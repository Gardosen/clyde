import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Client } from './client.js';
import { buildLocalManifest, manifestRoots } from './scan.js';
import { planRestore } from './diff.js';
import { applyPlan } from './restore.js';
import { checkGuard } from './guard.js';
import { liveSessions, ownSession, sessionIds, pathBelongsTo, describeSession } from './session.js';
import { chunkStream, canonicalSource } from './chunker.js';
import { lastSnapshotPath, claudeHome, clydeHome } from './paths.js';
import { saveConfig, configFromRaw } from './config.js';
import { canonicalize, localize, allForms, normalizeHome } from './rewrite.js';
import { fmtBytes } from './log.js';
import { syncPush, prepare, localPlan, fetchLatest, resolveUnions, describe, remoteContent, localCanonical, projectChats } from './sync.js';
import { flatten, saveBase } from './merge.js';

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
  const root = cfg.roots['desktop-sessions'];
  const out = new Set();
  if (!root) return [];
  const names = [];
  const walk = async (dir) => {
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
      else if (e.name.endsWith('.json')) names.push(path.join(dir, e.name));
    }
  };
  await walk(root.path);
  for (const f of names) {
    if (pathBelongsTo(path.basename(f), cfg.exclude)) continue;
    try {
      const j = JSON.parse(await fs.promises.readFile(f, 'utf8'));
      for (const k of ['cwd', 'originCwd']) if (typeof j[k] === 'string' && j[k]) out.add(canonicalize(normalizeHome(j[k]), cfg.forms));
    } catch { /* kein JSON */ }
  }
  return [...out].sort();
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
  checkGuard('Push', opts.force, log);
  const r = await syncPush(cfg, opts, log);
  saveLast({ id: r.id, createdAt: new Date().toISOString(), direction: 'push' });
  return r;
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
  const setMap = (canonical, localPath, shown) => {
    raw.pathMap = { ...(raw.pathMap || {}), [canonical]: localPath };
    changed = true;
    cur = configFromRaw(raw);
    log.info(`  Zuordnung gespeichert: ${shown} -> ${localPath}`);
  };
  for (const canonical of Array.isArray(snap.projects) ? snap.projects : []) {
    const local = localize(canonical, cur.forms);
    if (!/@@CLYDE_/.test(local) && fs.existsSync(local)) continue;
    const shown = localize(canonical, sourceForms);
    if (opts.createMissing) {
      const dir = normalizeHome(path.join(path.resolve(opts.createMissing), lastSegment(shown)));
      fs.mkdirSync(dir, { recursive: true });
      setMap(canonical, dir, shown);
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
    setMap(canonical, localPath, shown);
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
  const result = await applyPlan({ cfg, local, plan, client, opts, log, extra });
  saveBase(cfg, baseFiles, snap.id);
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
  const snap = await fetchLatest(client, opts.id);
  if (!snap) { log.info('Auf dem Server liegt noch kein Stand. Erst auf einem PC "clyde push" ausfuehren.'); return { changed: false }; }
  log.info(`${opts.exact ? 'Stand' : 'Gemeinsamer Stand'} ${snap.id}, zuletzt von ${snap.host} (${snap.user}), ${snap.createdAt}: ${snap.stats.files} Dateien, ${fmtBytes(snap.stats.bytes)}`);
  const chatTitles = await projectChats(client, snap).catch(() => new Map());
  cfg = await resolveProjects(snap, cfg, { ...opts, chatTitles }, log);
  if (snap.home !== cfg.home) log.info(`Home-Verzeichnis wird umgeschrieben: ${snap.home} -> ${cfg.home}`);
  log.info('Scanne lokalen Zustand ...');
  if (opts.exact) {
    const local = await buildLocalManifest(cfg, log);
    const plan = planRestore(local.roots, snap.roots, cfg.roots, cfg.forms, log, cfg.exclude);
    const newCount = plan.write.filter((f) => f.isNew).length;
    log.info(`Plan (exakt): ${newCount} neu, ${plan.write.length - newCount} geaendert (${fmtBytes(plan.bytesToWrite)}), ${plan.delete.length} loeschen, ${plan.unchanged} unveraendert`);
    const R = flatten(snap.roots, Object.keys(cfg.roots));
    return finishPull({ cfg, opts, log, snap, local, plan, client, extra: null, summary: {}, baseFiles: R });
  }
  const { local, R, decisions } = await prepare(cfg, client, snap, log);
  const extra = await resolveUnions(decisions, (d) => localCanonical(cfg, d.l), (d) => remoteContent(client, d.r));
  const plan = localPlan(cfg, decisions, snap);
  const s = describe(decisions);
  log.info(`Plan: ${plan.write.length} Dateien neu oder aktualisiert (${fmtBytes(plan.bytesToWrite)}), ${s.pullDelete} auf einem anderen PC geloescht${s.union ? `, ${s.union} zeilenweise zusammengefuehrt` : ''}${s.conflicts - s.union ? `, ${s.conflicts - s.union} Konflikte nach Datum entschieden` : ''}. Eigene Aenderungen, die noch hochzuladen sind: ${s.push + s.pushDelete + s.union}.`);
  return finishPull({ cfg, opts, log, snap, local, plan, client, extra, summary: { pending: s.push + s.pushDelete + s.union }, baseFiles: R });
}
