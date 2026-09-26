import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Client } from './client.js';
import { buildLocalManifest, manifestRoots } from './scan.js';
import { planRestore } from './diff.js';
import { applyPlan } from './restore.js';
import { checkGuard, busyOtherSessions } from './guard.js';
import { liveSessions, ownSession, sessionIds, pathBelongsTo, describeSession } from './session.js';
import { chunkStream, canonicalSource } from './chunker.js';
import { lastSnapshotPath, claudeHome, clydeHome } from './paths.js';
import { saveConfig, configFromRaw } from './config.js';
import { canonicalize, localize, allForms, normalizeHome } from './rewrite.js';
import { fmtBytes } from './log.js';
import { syncPush, prepare, localPlan, fetchLatest, resolveUnions, describe, remoteContent, localCanonical, projectChats } from './sync.js';
import { flatten, saveBase, loadBase, keyOf, loadBaseEntries } from './merge.js';
import { changeMapping } from './remap.js';
import { saveSidebarPull } from './appgroups.js';
import { checkVersions } from './version.js';
import { sidebarCwds, applyRepos } from './repos.js';
import { syncRefs, describeProblem } from './refs.js';
import { isUnder } from './remap.js';

export { MANIFEST_VERSION } from './sync.js';

function makeId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'host';
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}-${host}`;
}
export function loadLast() {
  try { return JSON.parse(fs.readFileSync(lastSnapshotPath(), 'utf8')); } catch { return null; }
}
function saveLast(info) {
  fs.mkdirSync(clydeHome(), { recursive: true });
  fs.writeFileSync(lastSnapshotPath(), JSON.stringify(info, null, 2));
}
export { checkGuard };

// Registriert den aufrufenden Chat dauerhaft als Clyde-Chat: er wird auf diesem
// PC nie hochgeladen und bei keinem Pull angefasst, auch nicht aus dem Terminal.
export function registerClydeChat(cfg, log) {
  const own = ownSession();
  if (!own) throw new Error('--clyde-chat geht nur aus einem Chat der Claude-App heraus.');
  const ids = sessionIds(own);
  if (ids.every((id) => cfg.registeredClydeChats.includes(id))) return cfg;
  const raw = { ...cfg.raw, excludeSessions: [...new Set([...cfg.registeredClydeChats, ...ids])] };
  saveConfig(raw);
  log.info('Dieser Chat ist jetzt als Clyde-Chat registriert und wird nie synchronisiert.');
  return configFromRaw(raw);
}

// Projektordner, auf die die Chats zeigen (aus dem Sidebar-Index der Desktop-App),
// in neutraler Form fuer das Manifest. Clyde-Chats zaehlen nicht mit.
export async function collectProjects(cfg) {
  return [...new Set((await sidebarCwds(cfg)).map((c) => canonicalize(c, cfg.forms)))].sort();
}

// Liefert die fehlenden Chunks datei-weise in einem Durchlauf je Datei
// (kanonische Stroeme lassen sich nicht wahlfrei lesen).
async function* missingChunks(local, missing) {
  const bySource = new Map();
  for (const h of missing) {
    const loc = local.chunkIndex.get(h);
    if (!bySource.has(loc.abs)) bySource.set(loc.abs, { forms: loc.forms, hashes: new Set() });
    bySource.get(loc.abs).hashes.add(h);
  }
  for (const [abs, { forms, hashes }] of bySource) {
    for await (const c of chunkStream(canonicalSource(abs, forms))) {
      if (!hashes.has(c.hash)) continue;
      hashes.delete(c.hash);
      yield { hash: c.hash, data: c.data };
    }
    if (hashes.size) {
      const e = new Error(`Datei hat sich waehrend des Push geaendert: ${abs}`);
      e.code = 'CHANGED';
      throw e;
    }
  }
}

export async function push(cfg, opts, log) {
  if (opts.clydeChat) cfg = registerClydeChat(cfg, log);
  if (opts.check) return pushCheck(cfg, opts, log);
  checkGuard('Push', opts.force, log);
  const r = await syncPush(cfg, opts, log);
  saveLast({ id: r.id, createdAt: new Date().toISOString(), direction: 'push' });
  return r;
}

// Vor dem Push: Vergessenes auflisten (Git-Arbeit in den Repos der Chats, die nicht
// auf dem Remote liegt), Verweise dieses Geraets, die nicht stimmen, und arbeitende
// Chats. --json fuer den Push-Skill, der daraus Rueckfragen macht. Aendert nichts.
async function pushCheck(cfg, opts, log) {
  const { workItems } = await import('./repos.js');
  let refsRes = null;
  if (!opts.noRepos && cfg.raw.repos !== false) refsRes = await syncRefs(cfg, new Client(cfg.server, cfg.token), { write: false }).catch(() => null);
  const roots = [...(refsRes?.facts?.repos.values() || [])].map((r) => r.root);
  for (const e of Object.values(refsRes?.refs?.repos || {})) {
    const loc = e.locations?.[refsRes.device.id];
    if (loc?.status === 'ok' && loc.path) roots.push(loc.path);
  }
  const items = await workItems(roots);
  const refs = refsRes?.problems || [];
  const own = ownSession();
  const busy = own ? busyOtherSessions(own).map(describeSession) : [];
  const result = { items, refs, busy };
  if (opts.json) { process.stdout.write(JSON.stringify(result, null, 1) + String.fromCharCode(10)); return result; }
  if (!items.length && !refs.length) log.info('Nichts vergessen: die Repos der Chats liegen vollstaendig auf ihrem Remote, die Verweise dieses Geraets stimmen.');
  else log.info('Vor dem Push pruefen:');
  for (const it of items) {
    const parts = [it.changed && `${it.changed} geaenderte Datei(en)`, it.untracked && `${it.untracked} neue Datei(en)`, it.ahead && `${it.ahead} Commit(s) nicht gepusht`,
      it.noUpstream && `Branch ${it.branch} hat keinen Upstream`, it.noRemote && 'kein Remote'].filter(Boolean);
    log.info(`  Git ${it.name} (${it.repo}): ${parts.join(', ')}${it.busyChats?.length ? ` - darin arbeitet gerade ${it.busyChats.join(', ')}` : ''}`);
    for (const f of it.files || []) log.info(`      ${f}`);
  }
  if (items.length) log.info('Nachholen: clyde repos --commit PFAD [--message TEXT] | clyde repos --push PFAD');
  for (const p of refs) log.info(`  ${describeProblem(p)}`);
  if (busy.length) log.info(`Arbeiten gerade (blockieren den Push): ${busy.join(', ')}`);
  return result;
}

async function ttyAsk(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

const lastSegment = (p) => String(p).split(/[\\/]+/).filter(Boolean).pop() || 'projekt';

// Prueft, ob die Projektordner des Stands hier existieren. Fehlende werden im
// Terminal erfragt, mit --create-missing DIR unter DIR angelegt, sonst gemeldet
// (mit dem Befehl, der die Zuordnung setzt). Liefert die (evtl. aktualisierte)
// Konfiguration und die fehlenden Ordner.
export async function resolveProjects(snap, cfg, opts, log) {
  const ask = opts.ask || (opts.noAsk || !process.stdin.isTTY ? null : ttyAsk);
  const raw = { ...cfg.raw };
  let changed = false;
  const missing = [];
  // Laufwerk nur auf Windows uebernehmen; macOS und Linux kennen keine Laufwerksbuchstaben
  if (!cfg.projectDrive && snap.projectDrive && process.platform === 'win32') {
    raw.projectDrive = snap.projectDrive;
    changed = true;
    log.info(`Projektlaufwerk hier nicht gesetzt, uebernehme "${snap.projectDrive}" aus dem Stand (aendern: clyde init --project-drive X).`);
  }
  let cur = changed ? configFromRaw(raw) : cfg;
  const sourceForms = allForms(snap.home, snap.projectDrive, {});
  // Zuordnung setzen: Chats des Projekts, die schon hier liegen, werden wie bei
  // "clyde map --add" umgestellt (nur ihre Dateien). Im Trockenlauf nur planen.
  const dryMaps = {};
  const setMap = async (canonical, localPath, shown, { create = false } = {}) => {
    const next = configFromRaw({ ...raw, pathMap: { ...(raw.pathMap || {}), ...dryMaps, [canonical]: localPath } });
    let r;
    try {
      r = await changeMapping({ oldCfg: cur, newCfg: next, from: localize(canonical, cur.forms), to: localPath, title: `Zuordnung ${shown} -> ${localPath}`, opts, log, ask, onlyOnWarnings: true });
    } catch (e) { log.warn(`  Zuordnung fuer ${shown} nicht gesetzt: ${e.message}`); return; }
    if (opts.dryRun) { dryMaps[canonical] = localPath; cur = next; return; }
    if (!r.applied) { log.warn(`  Zuordnung fuer ${shown} nicht gesetzt.`); return; }
    if (create) fs.mkdirSync(localPath, { recursive: true });
    raw.pathMap = { ...(raw.pathMap || {}), [canonical]: localPath };
    saveConfig(raw); // sofort: umgestellte Dateien und Konfiguration muessen zusammenpassen
    cur = configFromRaw(raw);
    log.info(`  Zuordnung gespeichert: ${shown} -> ${localPath}`);
  };
  const freeDir = (dir) => { let d = dir; for (let i = 2; fs.existsSync(d) && fs.readdirSync(d).length; i++) d = `${dir}-${i}`; return d; };
  for (const canonical of Array.isArray(snap.projects) ? snap.projects : []) {
    const local = localize(canonical, cur.forms);
    if (!/@@CLYDE_/.test(local) && fs.existsSync(local)) continue;
    // liegt in einem Repo, nach dem gleich eigens gefragt wird (klonen / liegt hier)
    if ((opts.repoRoots || []).some((r) => isUnder(canonical, r))) continue;
    const shown = localize(canonical, sourceForms);
    if (opts.createMissing) {
      const dir = freeDir(normalizeHome(path.join(path.resolve(opts.createMissing), lastSegment(shown))));
      await setMap(canonical, dir, shown, { create: true });
      continue;
    }
    const chats = opts.chatTitles?.get(canonical) || [];
    if (!ask) {
      missing.push({ canonical, shown, local, chats });
      log.warn(`Projektordner ${shown} (von ${snap.host}) gibt es hier nicht.${chats.length ? `\n  Chats: ${chats.join(' | ')}` : ''}\n  Zuordnen mit: clyde map --add "${canonical}" "PFAD-AUF-DIESEM-PC" [--create]`);
      continue;
    }
    const answer = (await ask(`Projekt "${shown}" (${snap.host}) gibt es hier nicht${local !== shown ? ` unter ${local}` : ''}.\n  Pfad auf diesem PC (leer = ueberspringen): `)).trim();
    if (!answer) continue;
    const localPath = normalizeHome(path.resolve(answer.replace(/^["']|["']$/g, '')));
    if (!fs.existsSync(localPath)) { log.warn(`${localPath} existiert nicht, uebersprungen.`); continue; }
    await setMap(canonical, localPath, shown);
  }
  if (changed) saveConfig(raw);
  cur.missingProjects = missing;
  return cur;
}

// Hinweise fuer den Clyde-Chat: welche offenen Chats bekommen einen neuen Stand?
function openChatHints(plan) {
  const own = ownSession();
  const touchedFiles = [...plan.write, ...plan.delete];
  const openTouched = own
    ? liveSessions().filter((s) => s.sessionId !== own.sessionId && touchedFiles.some((f) => pathBelongsTo(f.lp, sessionIds(s))))
    : [];
  const newSidebar = plan.write.filter((f) => f.root === 'desktop-sessions' && f.isNew).length;
  const hints = [];
  if (openTouched.length) hints.push(`Diese Chats sind gerade in der App geoeffnet und bekommen einen neuen Stand: ${openTouched.map(describeSession).join(', ')}. Bevor du dort weiterschreibst, die App einmal neu starten.`);
  if (own && newSidebar) hints.push(`${newSidebar} neue Chats kommen dazu. Falls sie nicht in der Seitenleiste erscheinen, die App einmal neu starten.`);
  return { openTouched: openTouched.map(describeSession), newSidebar, hints };
}

async function finishPull({ cfg, opts, log, snap, local, plan, client, extra, summary, baseFiles }) {
  if (opts.verbose || opts.dryRun) {
    for (const f of plan.write) log.info(`  ${f.isNew ? '+' : '~'} ${f.root}/${f.lp}`);
    for (const d of plan.delete) log.info(`  - ${d.root}/${d.lp}`);
  }
  const { openTouched, newSidebar, hints } = openChatHints(plan);
  plan.links = (await Promise.all(plan.links.map(async (ln) => { try { await fs.promises.lstat(ln.abs); return null; } catch { return ln; } }))).filter(Boolean);
  const info = { id: snap.id, missingProjects: cfg.missingProjects, openTouched, newSidebar, hints, ...summary };
  if (!plan.write.length && !plan.delete.length && !plan.links.length) {
    log.info('Dieser PC ist auf dem Stand des Kontos.');
    if (!opts.dryRun) { saveBase(cfg, baseFiles, snap.id); saveLast({ id: snap.id, createdAt: snap.createdAt, direction: 'pull' }); }
    return { changed: false, ...info };
  }
  if (opts.dryRun) {
    for (const h of hints) log.info(`Hinweis: ${h}`);
    log.info('Trockenlauf, nichts geaendert.');
    return { changed: false, plan, ...info };
  }
  checkGuard('Pull', opts.force, log);
  const oldBase = loadBase(cfg).files;
  const result = await applyPlan({ cfg, local, plan, client, opts, log, extra });
  // Geaenderte Eintraege schon bekannter Chats merken (fuer /clyde:groups)
  const skippedSet = new Set(result.skipped || []);
  const pulled = {};
  for (const f of plan.write) {
    const id = path.basename(f.lp, '.json');
    if (f.root !== 'desktop-sessions' || f.isNew || skippedSet.has(f) || !id.startsWith('local_')) continue;
    try { const j = JSON.parse(fs.readFileSync(f.abs, 'utf8')); pulled[id] = { title: typeof j.title === 'string' ? j.title : null, starred: typeof j.isStarred === 'boolean' ? j.isStarred : null }; } catch { /* kein Eintrag */ }
  }
  saveSidebarPull(pulled);
  // Ausgelassene Dateien behalten ihre alte Basis, damit der naechste Abgleich
  // die Aenderung des Kontos erneut sieht, statt sie mit dem lokalen Stand zu ueberschreiben
  const keep = new Map((result.skipped || []).map((f) => { const k = keyOf(f.root, f.p); return [k, oldBase.get(k) ?? null]; }));
  saveBase(cfg, baseFiles, snap.id, keep);
  saveLast({ id: snap.id, createdAt: snap.createdAt, direction: 'pull' });
  log.info(`Fertig (${result.downloadedChunks} Chunks / ${fmtBytes(result.downloadedBytes)} geladen${result.backupDir ? `, Sicherung unter ${result.backupDir}` : ''}).`);
  for (const h of hints) log.info(`Hinweis: ${h}`);
  return { changed: true, ...info, ...result };
}

// Pull: Aenderungen anderer PCs holen, eigene behalten (Standard).
// Mit --exact: Stand exakt herstellen, lokale Abweichungen werden entfernt.
export async function pull(cfg, opts, log) {
  if (opts.clydeChat) cfg = registerClydeChat(cfg, log);
  const client = new Client(cfg.server, cfg.token);
  checkVersions(await client.health(), log);
  const snap = await fetchLatest(client, opts.id);
  if (!snap) { log.info('Auf dem Server liegt noch kein Stand. Erst auf einem PC "clyde push" ausfuehren.'); return { changed: false }; }
  log.info(`${opts.exact ? 'Stand' : 'Gemeinsamer Stand'} ${snap.id}, zuletzt von ${snap.host} (${snap.user}), ${snap.createdAt}: ${snap.stats.files} Dateien, ${fmtBytes(snap.stats.bytes)}`);
  const chatTitles = await projectChats(client, snap).catch(() => new Map());
  const refsPlan = await refsForPull(client, snap, cfg, opts, log, chatTitles.byId);
  cfg = await resolveProjects(snap, cfg, { ...opts, chatTitles, repoRoots: refsPlan.pendingRoots }, log);
  if (snap.home !== cfg.home) log.info(`Home-Verzeichnis wird umgeschrieben: ${snap.home} -> ${cfg.home}`);
  const result = await pullFiles(client, snap, cfg, opts, log);
  result.pendingRepos = refsPlan.problems;
  if (refsPlan.supported) result.repos = await updateRepos(client, cfg, refsPlan, opts, log);
  return result;
}

// Verweise fuer den Pull: welche Repos brauchen die Chats (auch die, die gerade
// erst kommen), und wo liegen sie hier? Fehlende werden gemeldet; der Pull-Skill
// fragt danach (klonen / liegt hier / ueberspringen).
async function refsForPull(client, snap, cfg, opts, log, titles) {
  const empty = { supported: false, problems: [], pendingRoots: [] };
  if (opts.noRepos || cfg.raw.repos === false) return empty;
  const ids = (snap.roots['desktop-sessions']?.files || []).map((f) => f.p.split('/').pop())
    .filter((n) => n.startsWith('local_') && n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => !pathBelongsTo(id, cfg.exclude));
  let r;
  try { r = await syncRefs(cfg, client, { write: false, extraChatIds: ids, extraTitles: titles }); } catch (e) { log.warn(`Verweise nicht lesbar: ${e.message}`); return empty; }
  if (r.unsupported) return empty;
  for (const p of r.problems) log.warn(describeProblem(p));
  return { supported: true, problems: r.problems, pendingRoots: r.problems.map((p) => r.refs.repos[p.key]?.root).filter(Boolean) };
}

// Nach dem Pull: Verweise dieses Geraets eintragen und die Repos, die hier liegen,
// vorspulen (nur sauber und fast-forward). Vorspulen aendert Projektdateien,
// deshalb gilt dieselbe Pruefung auf arbeitende Chats wie beim Pull.
async function updateRepos(client, cfg, plan, opts, log) {
  if (opts.dryRun) return { planned: plan.problems };
  let r;
  try { r = await syncRefs(cfg, client); } catch (e) { log.warn(`Verweise nicht aktualisiert: ${e.message}`); return null; }
  if (!r?.refs) return null;
  const actions = Object.values(r.refs.repos).map((e) => ({ e, loc: e.locations?.[r.device.id] }))
    .filter((x) => x.loc?.status === 'ok' && x.loc.path).map((x) => ({ action: 'update', local: x.loc.path, remote: x.e.remote }));
  if (!actions.length) return { updated: [] };
  checkGuard('Git-Repos vorspulen', opts.force, log);
  return applyRepos(actions, log);
}

async function pullFiles(client, snap, cfg, opts, log) {
  log.info('Scanne lokalen Zustand ...');
  if (opts.exact) {
    const local = await buildLocalManifest(cfg, log, { rehash: opts.rehash });
    const plan = planRestore(local.roots, snap.roots, cfg.roots, cfg.forms, log, cfg.exclude);
    const newCount = plan.write.filter((f) => f.isNew).length;
    log.info(`Plan (exakt): ${newCount} neu, ${plan.write.length - newCount} geaendert (${fmtBytes(plan.bytesToWrite)}), ${plan.delete.length} loeschen, ${plan.unchanged} unveraendert`);
    const R = flatten(snap.roots, Object.keys(cfg.roots));
    return finishPull({ cfg, opts, log, snap, local, plan, client, extra: null, summary: {}, baseFiles: R });
  }
  const { local, R, decisions } = await prepare(cfg, client, snap, log, { rehash: opts.rehash });
  const entries = loadBaseEntries(cfg);
  const extra = await resolveUnions(decisions, (d) => localCanonical(cfg, d.l), (d) => remoteContent(client, d.r), (d) => (entries.has(d.key) ? Buffer.from(entries.get(d.key)) : null));
  const plan = localPlan(cfg, decisions, snap);
  const s = describe(decisions);
  if (plan.stale) log.warn(`${plan.stale} Dateien enthalten Stellen, die Clyde nicht verlustfrei umschreiben kann (z. B. beschaedigte Zeilen); sie bleiben unveraendert.`);
  log.info(`Plan: ${plan.write.length} Dateien neu oder aktualisiert (${fmtBytes(plan.bytesToWrite)}), ${s.pullDelete} auf einem anderen PC geloescht${s.union ? `, ${s.union} zeilenweise zusammengefuehrt` : ''}${s.conflicts - s.union ? `, ${s.conflicts - s.union} Konflikte nach Datum entschieden` : ''}. Eigene Aenderungen, die noch hochzuladen sind: ${s.push + s.pushDelete + s.union}.`);
  return finishPull({ cfg, opts, log, snap, local, plan, client, extra, summary: { pending: s.push + s.pushDelete + s.union }, baseFiles: R });
}
