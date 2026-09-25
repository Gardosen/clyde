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
import { normalizeHome, normalizeDrive, localize } from './rewrite.js';
import { loadLast, registerClydeChat } from './commands.js';
import { planRelocation, applyRelocation, undoRelocation } from './relocate.js';
import { fetchLatest, prepare, describe } from './sync.js';
import { changeMapping } from './remap.js';
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

export async function list(cfg, opts, log) {
  const { snapshots } = await new Client(cfg.server, cfg.token).listSnapshots();
  if (!snapshots.length) { log.info('Noch keine Snapshots auf dem Server.'); return; }
  const last = loadLast();
  for (const s of snapshots) {
    const mark = last && last.id === s.id ? ' <- lokal' : '';
    log.info(`${s.id}  ${s.createdAt}  ${s.host}/${s.user}  ${s.stats.files} Dateien, ${fmtBytes(s.stats.bytes)}${mark}`);
  }
}

export async function status(cfg, opts, log) {
  const client = new Client(cfg.server, cfg.token);
  const last = loadLast();
  const { snapshots } = await client.listSnapshots();
  const latest = snapshots[0];
  log.info(`Server ${cfg.server}: ${snapshots.length} Snapshots${latest ? `, neuester ${latest.id} von ${latest.host}` : ''}`);
  log.info(`Lokal zuletzt: ${last ? `${last.direction} ${last.id}` : 'noch nie synchronisiert'}`);
  for (const l of sessionLines()) log.info(l);
  const snap = latest ? await fetchLatest(client).catch(() => null) : null;
  const { decisions, local } = await prepare(cfg, client, snap, log);
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

export async function del(cfg, opts, log) {
  if (!opts.id) throw new Error('Aufruf: clyde delete SNAPSHOT-ID');
  await new Client(cfg.server, cfg.token).deleteSnapshot(opts.id);
  log.info(`Snapshot ${opts.id} geloescht. "clyde gc" gibt den Speicher frei.`);
}
