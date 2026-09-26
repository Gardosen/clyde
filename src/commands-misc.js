import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from './client.js';
import { buildLocalManifest, walkDir } from './scan.js';
import { planRestore } from './diff.js';
import { claudeRunning } from './guard.js';
import { liveSessions, ownSession, describeSession } from './session.js';
import readline from 'node:readline/promises';
import { saveConfig, loadConfig, normalizeServerUrl } from './config.js';
import { configPath } from './paths.js';
import { normalizeHome, normalizeDrive, localize, canonicalize } from './rewrite.js';
import { loadLast, registerClydeChat } from './commands.js';
import { planRelocation, applyRelocation, undoRelocation } from './relocate.js';
import { fetchLatest, prepare, describe } from './sync.js';
import { changeMapping } from './remap.js';
import { versionNotes, versionLine } from './version.js';
import { loadBase } from './merge.js';
import { configFromRaw } from './config.js';
import { fmtBytes } from './log.js';

// Zustand der laufenden Chats: im Clyde-Chat zaehlt nur, ob andere gerade arbeiten
function sessionLines() {
  const own = ownSession();
  const others = liveSessions().filter((s) => s.sessionId !== own?.sessionId);
  if (own) {
    const busy = others.filter((s) => s.status !== 'idle');
    return [
      `Aufruf aus einem Chat der App (Clyde-Chat-Modus): App darf offen bleiben, dieser Chat wird ausgenommen.`,
      busy.length ? `  Arbeiten gerade (blockieren push/pull): ${busy.map(describeSession).join(', ')}` : `  Kein anderer Chat arbeitet gerade, push/pull moeglich.`,
      others.length ? `  In der App geoeffnet: ${others.map((s) => `${describeSession(s)} (${s.status})`).join(', ')}` : '  Keine anderen Chats geoeffnet.',
    ];
  }
  const running = claudeRunning();
  return [running.length ? `Claude laeuft: ${running.join('; ')} (push/pull aus dem Terminal erst nach dem Schliessen, oder aus einem Clyde-Chat)` : 'Claude laeuft nicht.'];
}

function describeMapping(cfg) {
  const key = cfg.forms.find((f) => f.tag === '@@CLYDE_HOME_KEY@@');
  const lines = [`Home ${cfg.home}: Projektordner "${key ? key.value : '?'}-..." stehen im Snapshot als "@@CLYDE_HOME_KEY@@-..."`];
  if (cfg.projectDrive) lines.push(`Projektlaufwerk ${cfg.projectDrive}:  "${cfg.projectDrive}--..." und "${cfg.projectDrive}:\\..." stehen im Snapshot als "@@CLYDE_DRIVE_...@@"`);
  else lines.push('Projektlaufwerk: keins gesetzt (clyde init --project-drive D), Pfade ausserhalb des Home bleiben wie sie sind');
  const n = Object.keys(cfg.pathMap).length;
  lines.push(n ? `${n} Projekt-Zuordnung(en), siehe "clyde map --list"` : 'keine Projekt-Zuordnungen (entstehen bei "clyde pull", wenn ein Projektordner hier fehlt)');
  return lines;
}

const askFor = (opts) => opts.ask || (opts.noAsk || !process.stdin.isTTY ? null : ttyAsk);

async function ttyAsk(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

// Ersteinrichtung: Server-URL und Token sind Pflicht. Fehlen sie auf der
// Kommandozeile, wird im Terminal danach gefragt; bestehende Werte bleiben,
// wenn nur einer der beiden neu gesetzt wird.
export async function init(cfg, opts, log) {
  const ask = opts.ask || (opts.noAsk || !process.stdin.isTTY ? null : ttyAsk);
  let serverIn = opts.server || cfg.raw.server;
  let token = opts.token || cfg.raw.token;
  if (!serverIn && ask) serverIn = await ask('Adresse des Clyde-Servers (z. B. https://clyde.example.com): ');
  if (!token && ask) token = await ask('Client-Token (im Dashboard unter "Zugang fuer PCs" erzeugen): ');
  if (!serverIn || !token) {
    throw new Error('Aufruf: clyde init --server URL --token TOKEN [--project-drive D] [--home PFAD]\nServer-URL und Token sind bei der Ersteinrichtung Pflicht; den Token erzeugst du im Dashboard des Servers.');
  }
  const server = normalizeServerUrl(serverIn);
  const localHttp = new RegExp('^http://(localhost|127[.]0[.]0[.]1)(:|/|$)');
  if (server.startsWith('http:') && !localHttp.test(server)) {
    log.warn(`Unverschluesselte Verbindung zu ${server}: der Token geht im Klartext ueber die Leitung.`);
  }
  const raw = { ...cfg.raw, server, token };
  if (opts.home) raw.home = normalizeHome(opts.home);
  if (opts.projectDrive !== undefined) {
    const d = normalizeDrive(opts.projectDrive);
    if (!d && opts.projectDrive !== '') throw new Error(`Ungueltiges Projektlaufwerk "${opts.projectDrive}", erwartet einen Buchstaben wie D`);
    if (d) raw.projectDrive = d; else delete raw.projectDrive;
  }
  saveConfig(raw);
  let fresh = loadConfig();
  if (opts.clydeChat) fresh = registerClydeChat(fresh, log);
  log.info(`Konfiguration gespeichert: ${configPath()} (Server ${server})`);
  log.info(`Windows-Konto ${os.userInfo().username}`);
  for (const l of describeMapping(fresh)) log.info(`  ${l}`);
  await checkServer(server, token, log);
}

// Ist unter der URL wirklich ein Clyde-Server, und wem gehoert der Token?
async function checkServer(server, token, log) {
  const c = new Client(server, token);
  try {
    const h = await c.health();
    const vn = versionNotes(h);
    log.info(versionLine(vn));
    for (const n of vn.notes) log.warn(n.text);
    if (h?.service !== 'clyde') { log.warn(`${server} antwortet, ist aber kein Clyde-Server.`); return false; }
  } catch (e) {
    log.warn(`Server nicht erreichbar: ${e.message}`);
    return false;
  }
  try {
    const me = await c.me();
    log.info(`Server erreichbar, Token gehoert zu Benutzer "${me.user}"${me.admin ? ' (Admin)' : ''}.`);
    return true;
  } catch (e) {
    log.warn(/HTTP 401/.test(e.message) ? 'Server erreichbar, aber der Token wird nicht akzeptiert. Neuen Token im Dashboard erzeugen.' : `Token-Pruefung fehlgeschlagen: ${e.message}`);
    return false;
  }
}

// Zuordnungen von Projektordnern anzeigen, setzen oder entfernen
export async function map(cfg, opts, log) {
  const entries = Object.entries(cfg.pathMap);
  if (opts.add) {
    const [canonical, localRaw] = opts.args || [];
    if (!canonical || !localRaw) throw new Error('Aufruf: clyde map --add "NEUTRALER-PFAD" "PFAD-AUF-DIESEM-PC" [--create]   (der neutrale Pfad steht in der Meldung von clyde pull)');
    const localPath = normalizeHome(path.resolve(localRaw.replace(/^["']|["']$/g, '')));
    const exists = fs.existsSync(localPath);
    if (!exists && !opts.create) throw new Error(`${localPath} existiert nicht (mit --create wird er angelegt).`);
    const raw = { ...cfg.raw, pathMap: { ...(cfg.raw.pathMap || {}), [canonical]: localPath } };
    // Chats dieses Projekts, die schon hier liegen, an den neuen Ort bringen; nur ihre
    // Dateien, nach Plan und Bestaetigung
    const from = localize(canonical, cfg.forms);
    const r = await changeMapping({ oldCfg: cfg, newCfg: configFromRaw(raw), from, to: localPath, title: `Zuordnung ${canonical} -> ${localPath}${exists ? '' : ' (Ordner wird angelegt)'}`, opts, log, ask: askFor(opts) });
    if (!r.applied) return r;
    if (!exists) { fs.mkdirSync(localPath, { recursive: true }); log.info(`Ordner angelegt: ${localPath}`); }
    saveConfig(raw);
    log.info(`Zuordnung gespeichert: ${canonical} -> ${localPath}`);
    return r;
  }
  if (opts.remove !== undefined) {
    const i = Number(opts.remove) - 1;
    if (!(i >= 0 && i < entries.length)) throw new Error(`Aufruf: clyde map --remove NUMMER   (1..${entries.length}, siehe clyde map --list)`);
    const raw = { ...cfg.raw, pathMap: { ...cfg.raw.pathMap } };
    delete raw.pathMap[entries[i][0]];
    // Chats unter der alten Zuordnung zurueckstellen
    const newCfg = configFromRaw(raw);
    const to = localize(entries[i][0], newCfg.forms);
    const r = await changeMapping({ oldCfg: cfg, newCfg, from: entries[i][1], to, title: `Zuordnung ${i + 1} entfernen: ${entries[i][0]} -> ${entries[i][1]} (Chats zurueck nach ${to})`, opts, log, ask: askFor(opts) });
    if (!r.applied) return r;
    saveConfig(raw);
    log.info(`Zuordnung ${i + 1} entfernt: ${entries[i][0]} -> ${entries[i][1]}`);
    return r;
  }
  if (!entries.length) { log.info('Keine Projekt-Zuordnungen. Sie entstehen bei "clyde pull", wenn ein Projektordner hier fehlt.'); return; }
  entries.forEach(([c, l], i) => log.info(`${String(i + 1).padStart(2)}. ${c}\n    -> ${l}`));
}

// Staende mit Groesse und dem Platz, den Loeschen mindestens freigibt
export async function list(cfg, opts, log) {
  const { snapshots } = await new Client(cfg.server, cfg.token).listSnapshots({ sizes: true });
  if (!snapshots.length) { log.info('Noch keine Snapshots auf dem Server.'); return { snapshots }; }
  snapshots.forEach((s, i) => { s.newest = s.newest ?? i === 0; }); // aeltere Server liefern das Feld nicht
  const base = loadBase(cfg).snapshotId;
  for (const s of snapshots) {
    const marks = [s.newest && 'neuester, gemeinsamer Stand', s.id === base && 'Basis dieses PCs'].filter(Boolean);
    const free = s.exclusive ? `, frei beim Loeschen: ${fmtBytes(s.exclusive.bytes)}` : '';
    log.info(`${s.id}  ${s.createdAt}  ${s.host}/${s.user}  ${s.stats.files} Dateien, ${fmtBytes(s.stats.bytes)}${free}${marks.length ? `  [${marks.join(', ')}]` : ''}`);
  }
  return { snapshots, base };
}

export async function status(cfg, opts, log) {
  const client = new Client(cfg.server, cfg.token);
  const v = versionNotes(await client.health());
  log.info(versionLine(v));
  for (const n of v.notes) log.warn(n.text);
  const last = loadLast();
  const { snapshots } = await client.listSnapshots();
  const latest = snapshots[0];
  log.info(`Server ${cfg.server}: ${snapshots.length} Snapshots${latest ? `, neuester ${latest.id} von ${latest.host}` : ''}`);
  log.info(`Lokal zuletzt: ${last ? `${last.direction} ${last.id}` : 'noch nie synchronisiert'}`);
  for (const l of sessionLines()) log.info(l);
  const snap = latest ? await fetchLatest(client).catch(() => null) : null;
  const { decisions, local } = await prepare(cfg, client, snap, log, { rehash: opts.rehash });
  const s = describe(decisions);
  log.info(`Lokal: ${local.stats.files} Dateien, ${fmtBytes(local.stats.bytes)}`);
  log.info(`Zum Hochladen (clyde push): ${s.push} neu oder geaendert, ${s.pushDelete} geloescht${s.union ? `, ${s.union} beidseitig geaendert (werden zusammengefuehrt)` : ''}`);
  log.info(`Zum Holen (clyde pull): ${s.pull} neu oder geaendert, ${s.pullDelete} auf anderen PCs geloescht`);
  if (opts.verbose) {
    for (const d of decisions) if (d.kind !== 'same') log.info(`  ${d.kind.padEnd(20)} ${d.root}/${d.l?.lp || d.p}`);
  }
}

export async function doctor(cfg, opts, log) {
  log.info(`Konfiguration: ${configPath()}${cfg.raw.server ? '' : ' (noch nicht angelegt)'}`);
  log.info(`Benutzer ${os.userInfo().username}, ${process.platform}, Host ${os.hostname()}, Node ${process.version}`);
  for (const l of describeMapping(cfg)) log.info(`  ${l}`);
  log.info('Roots:');
  for (const [name, r] of Object.entries(cfg.roots)) {
    let info = 'FEHLT';
    try {
      const st = fs.statSync(r.path);
      if (r.kind === 'file') info = fmtBytes(st.size);
      else { const { files, links } = await walkDir(r.path); info = `${files.length} Dateien${links.length ? `, ${links.length} Links` : ''}`; }
    } catch { /* fehlt */ }
    log.info(`  ${name.padEnd(20)} ${info.padEnd(22)} ${r.path}${r.rewrite === false ? '  (Inhalte unveraendert)' : ''}`);
  }
  for (const l of sessionLines()) log.info(l);
  log.info(cfg.registeredClydeChats.length ? `Registrierte Clyde-Chats (nie synchronisiert): ${cfg.registeredClydeChats.join(', ')}` : 'Kein Clyde-Chat registriert (clyde push --clyde-chat aus dem Chat heraus).');
  if (cfg.server && cfg.token) {
    log.info(`Server ${cfg.server}:`);
    await checkServer(cfg.server, cfg.token, { info: (s) => log.info(`  ${s}`), warn: (s) => log.info(`  ${s}`) });
  } else {
    log.info('Kein Server eingerichtet: clyde init --server URL --token TOKEN');
  }
}

// Chats einem anderen Projektordner zuordnen. Aendert die Chatliste der App und
// geht deshalb nur bei geschlossener App aus einem Terminal (Trockenlauf immer).
export async function relocate(cfg, opts, log) {
  if (opts.undo) {
    requireAppClosed('Rueckgaengig machen', opts.force);
    const n = undoRelocation(opts.undo, log);
    log.info(`${n} Chats zurueckgestellt. App starten.`);
    return;
  }
  let items;
  if (opts.plan) {
    const raw = JSON.parse(fs.readFileSync(opts.plan, 'utf8'));
    items = (Array.isArray(raw) ? raw : raw.chats || []).map((x) => ({ chat: x.chat, to: x.to }));
  } else if (opts.chat && opts.to) {
    items = [{ chat: opts.chat, to: opts.to }];
  } else {
    throw new Error('Aufruf: clyde relocate --chat "TITEL oder ID" --to ZIELORDNER   oder   clyde relocate --plan PLAN.json   [--dry-run]   |   clyde relocate --undo SICHERUNGSORDNER');
  }
  const steps = planRelocation(cfg, items);
  log.info(`${steps.length} Chats:`);
  for (const s of steps) {
    if (s.unchanged) { log.info(`  = ${s.title}: liegt schon in ${s.to}`); continue; }
    log.info(`  ${s.title}\n      Projektordner ${s.oldCwd} -> ${s.to}`);
    if (s.moves.length) log.info(`      Transkript nach .claude/projects/${path.basename(s.newDir)} (${s.moves.length} Eintraege)`);
    if (s.link) log.info(`      Memory-Verknuepfung ${path.basename(s.newDir)}/memory -> ${s.link.target}`);
  }
  if (opts.dryRun) { log.info('Trockenlauf, nichts geaendert.'); return { steps }; }
  requireAppClosed('Umzug', opts.force);
  const bdir = applyRelocation(steps, log);
  log.info(`Fertig. Sicherung und Rueckgaengig-Daten: ${bdir}\nRueckgaengig: clyde relocate --undo "${bdir}"\nJetzt die App starten.`);
  return { steps, backupDir: bdir };
}

function requireAppClosed(action, force) {
  if (process.env.CLYDE_SKIP_GUARD === '1') return;
  if (ownSession()) throw new Error(`${action} aendert die Chatliste der App und geht nicht aus einem Chat heraus. App schliessen und den Befehl in einem Terminal ausfuehren.`);
  const r = claudeRunning();
  if (r.length && !force) throw new Error(`${action} abgebrochen, Claude laeuft noch:\n${r.map((x) => `  - ${x}`).join('\n')}\nErst die Claude-App schliessen.`);
}

export async function gc(cfg, opts, log) {
  const r = await new Client(cfg.server, cfg.token).gc();
  log.info(`Aufgeraeumt: ${r.deleted} Chunks geloescht (${fmtBytes(r.freedBytes)}), ${r.kept} behalten.`
    + (r.recent ? ` ${r.recent} nicht mehr benoetigte Chunks sind juenger als ${r.gcGraceMinutes} Minuten und werden beim naechsten Aufraeumen entfernt.` : ''));
}

// Staende loeschen und danach aufraeumen. Der neueste Stand nur mit --force.
// Ohne Terminal (Plugin) nur mit --yes.
export async function del(cfg, opts, log) {
  const ids = [...new Set(opts.args || [])];
  if (!ids.length) throw new Error('Aufruf: clyde delete STAND-ID [STAND-ID ...] [--yes] [--force]   (IDs siehe clyde list)');
  const client = new Client(cfg.server, cfg.token);
  const { snapshots } = await client.listSnapshots({ sizes: true });
  snapshots.forEach((s, i) => { s.newest = s.newest ?? i === 0; });
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`Unbekannte Staende: ${unknown.join(', ')} (siehe clyde list)`);
  const chosen = ids.map((id) => byId.get(id));
  const base = loadBase(cfg).snapshotId;
  log.info(`Zu loeschen (${chosen.length}):`);
  for (const s of chosen) log.info(`  ${s.id}  ${s.host}/${s.user}  ${s.stats.files} Dateien, frei: ${fmtBytes(s.exclusive?.bytes || 0)}`);
  log.info(`Frei werden mindestens ${fmtBytes(chosen.reduce((a, s) => a + (s.exclusive?.bytes || 0), 0))} (gemeinsam genutzte Chunks evtl. mehr).`);
  const newest = chosen.find((s) => s.newest);
  if (newest) {
    log.warn(`${newest.id} ist der neueste, gemeinsame Stand des Kontos. Danach gilt der naechstaeltere. PCs, die ${newest.id} schon geholt haben, vereinigen beim naechsten Abgleich nur (nichts wird geloescht) und laden ihre Chats erneut hoch.`);
  }
  if (chosen.some((s) => s.id === base)) log.info('Hinweis: Einer davon ist die Basis dieses PCs; der naechste Abgleich hier vereinigt nur.');
  if (opts.dryRun) { log.info('Trockenlauf, nichts geloescht.'); return { deleted: 0, newest: !!newest }; }
  if (newest && !opts.force) throw new Error('Den neuesten Stand nur mit --force loeschen.');
  if (!opts.yes) {
    const ask = askFor(opts);
    if (!ask) throw new Error('Nichts geloescht. Mit --yes bestaetigen.');
    const a = String(await ask('Loeschen? [j/N] ')).trim().toLowerCase();
    if (!['j', 'ja', 'y', 'yes'].includes(a)) { log.info('Abgebrochen, nichts geloescht.'); return { deleted: 0 }; }
  }
  for (const s of chosen) await client.deleteSnapshot(s.id, { force: !!s.newest });
  const r = await client.gc();
  log.info(`${chosen.length} ${chosen.length === 1 ? 'Stand' : 'Staende'} geloescht, ${fmtBytes(r.freedBytes)} freigegeben.`
    + (r.recent ? ` ${r.recent} weitere Chunks werden frei, sobald sie aelter als ${r.gcGraceMinutes} Minuten sind (Schutz fuer laufende Pushs); dann "clyde gc".` : ''));
  return { deleted: chosen.length, freedBytes: r.freedBytes, recent: r.recent };
}

// Git-Repos: anzeigen (gemeinsamer Stand und eigene Auswahl), Kandidaten suchen,
// auswaehlen oder abwaehlen. Aenderungen wirken mit dem naechsten Push.
export async function repos(cfg, opts, log) {
  const { scanRepos, inspectRepo, extraRepos, dropRepos, ignoredRepos, sanitizeRemote, commitAndPush, pushRepo } = await import('./repos.js');
  const { isUnder } = await import('./remap.js');
  const same = (a, b) => isUnder(a, b) && isUnder(b, a);
  const raw = { ...cfg.raw, extraRepos: extraRepos(cfg), dropRepos: dropRepos(cfg), ignoredRepos: ignoredRepos(cfg) };
  const argPaths = () => (opts.args || []).map((p) => normalizeHome(path.resolve(p.replace(/^["']|["']$/g, ''))));
  // Vergessenes nachholen (vom Push-Skill nach Rueckfrage aufgerufen)
  if (opts.commit) {
    const r = await commitAndPush(normalizeHome(path.resolve(opts.commit)), opts.message, { force: opts.force });
    log.info(`${r.root}: ${r.committed ? `committet ("${r.message}") und ` : ''}auf den Remote gepusht (${r.branch}).`);
    return r;
  }
  if (opts.gitPush) {
    const r = await pushRepo(normalizeHome(path.resolve(opts.gitPush)), { force: opts.force });
    log.info(`${r.root}: Commits auf den Remote gepusht (${r.branch}).`);
    return r;
  }
  if (opts.ignore) {
    const paths = argPaths();
    if (!paths.length) throw new Error('Aufruf: clyde repos --ignore PFAD [PFAD ...]');
    for (const p of paths) if (!raw.ignoredRepos.some((x) => same(x, p))) raw.ignoredRepos.push(p);
    saveConfig(raw);
    log.info(`Wird nicht mehr vorgeschlagen: ${paths.join(' | ')} (mitnehmen jederzeit mit clyde repos --add)`);
    return { ignored: raw.ignoredRepos };
  }
  if (opts.scan) {
    const found = await scanRepos(cfg);
    if (!found.length) { log.info('In und direkt unter den Projektordnern deiner Chats liegen keine Git-Repos.'); return { found }; }
    log.info('Git-Repos in und direkt unter den Projektordnern deiner Chats:');
    found.forEach((r, i) => {
      const state = r.viaChat ? 'automatisch (ein Chat arbeitet darin)' : r.selected ? 'ausgewaehlt' : raw.ignoredRepos.some((x) => same(x, r.root)) ? 'nicht ausgewaehlt (wird nicht vorgeschlagen)' : 'nicht ausgewaehlt';
      const warn = [!r.remote && 'kein Remote', r.ahead && `${r.ahead} Commit(s) nicht gepusht`, r.dirty && `${r.dirty} Datei(en) nicht committet`, r.untracked && `${r.untracked} neue Datei(en)`].filter(Boolean);
      log.info(`${String(i + 1).padStart(2)}. ${r.root}  ${r.remote ? sanitizeRemote(r.remote) : '-'}  [${!r.head ? 'leer' : r.branch || 'losgeloest'}]  ${fmtBytes(r.sizeBytes)}  ${state}${warn.length ? `  (${warn.join(', ')})` : ''}`);
    });
    log.info('Auswaehlen: clyde repos --add PFAD [PFAD ...]   abwaehlen: clyde repos --remove PFAD');
    return { found };
  }
  if (opts.add) {
    const paths = argPaths();
    if (!paths.length) throw new Error('Aufruf: clyde repos --add PFAD [PFAD ...]   (Kandidaten: clyde repos --scan)');
    for (const p of paths) {
      const info = fs.existsSync(p) ? await inspectRepo(p) : null;
      if (!info) throw new Error(`${p} ist kein Git-Repo.`);
      if (!info.remote) throw new Error(`${info.root} hat keinen Remote und laesst sich auf anderen PCs nicht klonen.`);
      if (!raw.extraRepos.some((x) => same(x, info.root))) raw.extraRepos.push(info.root);
      raw.ignoredRepos = raw.ignoredRepos.filter((x) => !same(x, info.root));
      const canon = canonicalize(info.root, cfg.forms);
      raw.dropRepos = raw.dropRepos.filter((d) => d !== canon);
      log.info(`Ausgewaehlt: ${info.root} (${sanitizeRemote(info.remote)})`);
    }
    saveConfig(raw);
    log.info('Wirkt mit dem naechsten Push; die anderen PCs klonen es beim naechsten Pull.');
    return { selected: raw.extraRepos };
  }
  if (opts.remove !== undefined) {
    const p = normalizeHome(path.resolve(String(opts.remove).replace(/^["']|["']$/g, '')));
    const hit = raw.extraRepos.find((x) => same(x, p));
    if (!hit) throw new Error(`${p} ist nicht ausgewaehlt (siehe clyde repos).`);
    raw.extraRepos = raw.extraRepos.filter((x) => x !== hit);
    const canon = canonicalize(hit, cfg.forms);
    if (!raw.dropRepos.includes(canon)) raw.dropRepos.push(canon);
    saveConfig(raw);
    const { sidebarCwds } = await import('./repos.js');
    if ((await sidebarCwds(cfg)).some((c) => isUnder(c, hit))) log.warn(`In ${hit} arbeiten Chats; es bleibt deshalb automatisch dabei.`);
    log.info(`Abgewaehlt: ${hit}. Der naechste Push nimmt es aus dem gemeinsamen Stand; vorhandene Klone auf anderen PCs bleiben, werden aber nicht mehr aktualisiert.`);
    return { selected: raw.extraRepos };
  }
  const snap = await fetchLatest(new Client(cfg.server, cfg.token));
  const shared = snap?.repos || [];
  log.info(shared.length ? `Im gemeinsamen Stand (${shared.length}):` : 'Im gemeinsamen Stand sind keine Git-Repos vermerkt.');
  for (const r of shared) log.info(`  ${localize(r.root, cfg.forms)}  ${r.remote}  [${r.branch || 'losgeloest'}]  von ${r.host}`);
  const sel = raw.extraRepos;
  log.info(sel.length ? `Auf diesem PC ausgewaehlt (${sel.length}): ${sel.join(' | ')}` : 'Auf diesem PC ist nichts eigens ausgewaehlt (Kandidaten: clyde repos --scan).');
  if (raw.dropRepos.length) log.info(`Beim naechsten Push abgewaehlt: ${raw.dropRepos.map((d) => localize(d, cfg.forms)).join(' | ')}`);
  return { shared, selected: sel };
}

// Gruppen der Chatliste: Soll-Zustand aus dem gemeinsamen Stand fuer die Chats,
// die es auf diesem PC gibt. Clyde schreibt die Einstellungsdatei der App nicht;
// der Skill /clyde:groups setzt das ueber die Seitenleisten-Werkzeuge der App um.
export async function groups(cfg, opts, log) {
  const { localSidebarChats, desiredGroups } = await import('./appgroups.js');
  const snap = await fetchLatest(new Client(cfg.server, cfg.token));
  const chats = await localSidebarChats(cfg);
  const d = desiredGroups(snap?.appGroups, (id) => chats.has(id));
  const result = { snapshot: snap?.id || null, ...d, titles: Object.fromEntries([...chats].filter(([id]) => d.groups.some((g) => g.sessions.includes(id)) || d.pinned.includes(id))) };
  if (opts.json) { process.stdout.write(`${JSON.stringify(result, null, 1)}\n`); return result; }
  if (!d.groups.length && !d.pinned.length) { log.info('Im gemeinsamen Stand sind keine Gruppen fuer die Chats dieses PCs vermerkt.'); return result; }
  for (const g of d.groups) log.info(`${g.name} (${g.sessions.length}): ${g.sessions.map((id) => chats.get(id) || id).join(' | ')}`);
  if (d.pinned.length) log.info(`Angeheftet: ${d.pinned.map((id) => chats.get(id) || id).join(' | ')}`);
  log.info('In die App uebernehmen: /clyde:groups im Clyde-Chat (Clyde schreibt die Einstellungen der App nicht selbst).');
  return result;
}
