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
import { readAppGroups } from './appgroups.js';

export const MANIFEST_VERSION = 2;

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
async function collectProjects(cfg) {
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
  const client = new Client(cfg.server, cfg.token);
  await client.health();
  const limit = cfg.uploadBatchMiB * 1024 * 1024;
  let local;
  let missing;
  let uploadedChunks = 0;
  let uploadedBytes = 0;

  // Dateien, die sich waehrend des Uploads aendern, werden neu gehasht und der
  // Upload wird bis zu dreimal wiederholt
  for (let attempt = 1; ; attempt++) {
    log.info(attempt === 1 ? `Scanne lokalen Zustand (Home ${cfg.home}) ...` : `Scanne erneut (Versuch ${attempt}) ...`);
    local = await buildLocalManifest(cfg, log);
    const ex = local.stats.excluded ? `, ${local.stats.excluded} Dateien des Clyde-Chats ausgelassen` : '';
    log.info(`  ${local.stats.files} Dateien, ${fmtBytes(local.stats.bytes)}, ${local.stats.chunks} Chunks (${local.stats.hashedFiles} neu gehasht${ex})`);
    const all = [...local.chunkIndex.keys()];
    missing = [];
    for (let i = 0; i < all.length; i += 5000) missing.push(...(await client.missing(all.slice(i, i + 5000))).missing);
    log.info(`  ${missing.length} Chunks fehlen auf dem Server`);

    let batch = [];
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const r = await client.upload(batch);
      uploadedChunks += r.stored + r.skipped;
      uploadedBytes += batchBytes;
      batch = [];
      batchBytes = 0;
      log.info(`  hochgeladen ${uploadedChunks}/${missing.length} Chunks (${fmtBytes(uploadedBytes)})`);
    };
    try {
      for await (const c of missingChunks(local, missing)) {
        if (batch.length && (batchBytes + c.data.length > limit || batch.length >= 400)) await flush();
        batch.push(c);
        batchBytes += c.data.length;
      }
      await flush();
      break;
    } catch (e) {
      await flush().catch(() => {});
      if (e.code !== 'CHANGED' || attempt >= 3) throw e;
      log.warn(`${e.message}; wird neu erfasst.`);
    }
  }

  const manifest = {
    version: MANIFEST_VERSION, id: makeId(), createdAt: new Date().toISOString(),
    host: os.hostname(), user: os.userInfo().username, home: cfg.home, projectDrive: cfg.projectDrive, platform: process.platform, claudeHome: claudeHome(),
    rootPaths: Object.fromEntries(Object.entries(cfg.roots).map(([n, r]) => [n, r.path])),
    projects: await collectProjects(cfg),
    appGroups: readAppGroups(cfg),
    roots: manifestRoots(local.roots),
    stats: { files: local.stats.files, bytes: local.stats.bytes, chunks: local.stats.chunks },
  };
  await client.putSnapshot(manifest);
  saveLast({ id: manifest.id, createdAt: manifest.createdAt, direction: 'push' });
  log.info(`Snapshot ${manifest.id} gespeichert (${uploadedChunks} Chunks / ${fmtBytes(uploadedBytes)} uebertragen, ${manifest.projects.length} Projektordner vermerkt).`);
  return { id: manifest.id, uploadedChunks, uploadedBytes, stats: manifest.stats, projects: manifest.projects, excluded: local.stats.excluded };
}

async function ttyAsk(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

// Prueft, ob die Projektordner des Snapshots hier existieren. Fehlende werden im
// Terminal erfragt und als Zuordnung gespeichert; ohne Terminal (z. B. im
// Clyde-Chat) wird gemeldet, mit welchem Befehl sich die Zuordnung setzen laesst.
// Liefert die (evtl. aktualisierte) Konfiguration und die fehlenden Ordner.
export async function resolveProjects(snap, cfg, opts, log) {
  const ask = opts.ask || (opts.noAsk || !process.stdin.isTTY ? null : ttyAsk);
  const raw = { ...cfg.raw };
  let changed = false;
  const missing = [];
  if (!cfg.projectDrive && snap.projectDrive) {
    raw.projectDrive = snap.projectDrive;
    changed = true;
    log.info(`Projektlaufwerk hier nicht gesetzt, uebernehme "${snap.projectDrive}" aus dem Snapshot (aendern: clyde init --project-drive X).`);
  }
  let cur = changed ? configFromRaw(raw) : cfg;
  const sourceForms = allForms(snap.home, snap.projectDrive, {});
  for (const canonical of Array.isArray(snap.projects) ? snap.projects : []) {
    const local = localize(canonical, cur.forms);
    if (fs.existsSync(local)) continue;
    const shown = localize(canonical, sourceForms);
    if (!ask) {
      missing.push({ canonical, shown, local });
      log.warn(`Projektordner ${local} existiert hier nicht (auf ${snap.host}: ${shown}).\n  Zuordnen mit: clyde map --add "${canonical}" "PFAD-AUF-DIESEM-PC"`);
      continue;
    }
    const answer = (await ask(`Projekt "${shown}" (${snap.host}) liegt hier nicht unter ${local}.\n  Pfad auf diesem PC (leer = ueberspringen): `)).trim();
    if (!answer) continue;
    const localPath = normalizeHome(path.resolve(answer.replace(/^["']|["']$/g, '')));
    if (!fs.existsSync(localPath)) { log.warn(`${localPath} existiert nicht, uebersprungen.`); continue; }
    raw.pathMap = { ...(raw.pathMap || {}), [canonical]: localPath };
    changed = true;
    cur = configFromRaw(raw);
    log.info(`  Zuordnung gespeichert: ${shown} -> ${localPath}`);
  }
  if (changed) saveConfig(raw);
  cur.missingProjects = missing;
  return cur;
}

export async function pull(cfg, opts, log) {
  if (opts.clydeChat) cfg = registerClydeChat(cfg, log);
  const client = new Client(cfg.server, cfg.token);
  const snap = await client.getSnapshot(opts.id || 'latest');
  if (snap.version !== MANIFEST_VERSION) {
    throw new Error(`Snapshot ${snap.id} hat Format v${snap.version}, dieser Client braucht v${MANIFEST_VERSION}. Auf dem Quell-PC mit aktuellem Clyde neu pushen.`);
  }
  log.info(`Snapshot ${snap.id} von ${snap.host} (${snap.user}, Home ${snap.home}), erstellt ${snap.createdAt}: ${snap.stats.files} Dateien, ${fmtBytes(snap.stats.bytes)}`);
  cfg = await resolveProjects(snap, cfg, opts, log);
  if (snap.home !== cfg.home) log.info(`Home-Verzeichnis wird umgeschrieben: ${snap.home} -> ${cfg.home}`);
  log.info('Scanne lokalen Zustand ...');
  const local = await buildLocalManifest(cfg, log);
  const plan = planRestore(local.roots, snap.roots, cfg.roots, cfg.forms, log, cfg.exclude);
  const newCount = plan.write.filter((f) => f.isNew).length;
  log.info(`Plan: ${newCount} neu, ${plan.write.length - newCount} geaendert (${fmtBytes(plan.bytesToWrite)}), ${plan.delete.length} loeschen, ${plan.unchanged} unveraendert`);
  if (opts.verbose || opts.dryRun) {
    for (const f of plan.write) log.info(`  ${f.isNew ? '+' : '~'} ${f.root}/${f.lp}`);
    for (const d of plan.delete) log.info(`  - ${d.root}/${d.lp}`);
  }

  // Im Clyde-Chat: welche anderen, gerade in der App geoeffneten Chats bekommen
  // einen neuen Stand? Deren Prozess arbeitet sonst mit dem alten weiter.
  const own = ownSession();
  const touchedFiles = [...plan.write, ...plan.delete];
  const openTouched = own
    ? liveSessions().filter((s) => s.sessionId !== own.sessionId && touchedFiles.some((f) => pathBelongsTo(f.lp, sessionIds(s))))
    : [];
  const newSidebar = plan.write.filter((f) => f.root === 'desktop-sessions' && f.isNew).length;
  const hints = [];
  if (openTouched.length) {
    hints.push(`Diese Chats sind gerade in der App geoeffnet und bekommen einen neuen Stand: ${openTouched.map(describeSession).join(', ')}. Bevor du dort weiterschreibst, die App einmal neu starten.`);
  }
  if (own && newSidebar) {
    hints.push(`${newSidebar} neue Chats kommen dazu. Falls sie nicht in der Seitenleiste erscheinen, die App einmal neu starten.`);
  }

  plan.links = (await Promise.all(plan.links.map(async (ln) => { try { await fs.promises.lstat(ln.abs); return null; } catch { return ln; } }))).filter(Boolean);
  const base = { id: snap.id, missingProjects: cfg.missingProjects, openTouched: openTouched.map(describeSession), newSidebar, hints };
  if (!plan.write.length && !plan.delete.length && !plan.links.length) {
    log.info('Lokaler Zustand entspricht bereits dem Snapshot.');
    saveLast({ id: snap.id, createdAt: snap.createdAt, direction: 'pull' });
    return { changed: false, ...base };
  }
  if (opts.dryRun) {
    for (const h of hints) log.info(`Hinweis: ${h}`);
    log.info('Trockenlauf, nichts geaendert.');
    return { changed: false, plan, ...base };
  }
  checkGuard('Pull', opts.force, log);
  const result = await applyPlan({ cfg, local, plan, client, opts, log });
  saveLast({ id: snap.id, createdAt: snap.createdAt, direction: 'pull' });
  log.info(`Fertig: Zustand von ${snap.id} hergestellt (${result.downloadedChunks} Chunks / ${fmtBytes(result.downloadedBytes)} geladen${result.backupDir ? `, Backup unter ${result.backupDir}` : ''}).`);
  for (const h of hints) log.info(`Hinweis: ${h}`);
  return { changed: true, ...base, ...result };
}
