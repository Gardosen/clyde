import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chunkStream, canonicalSource, localizeStream } from './chunker.js';
import { backupsDir, chunkCacheDir } from './paths.js';
import { loadCache, saveCache, formsFor, formsKey } from './scan.js';
import { textMode } from './rewrite.js';
import { fmtBytes } from './log.js';

// Pull-Sicherungen heissen nur nach dem Zeitstempel; nur sie werden aufgeraeumt.
// Sicherungen mit Namen (map-..., relocate-...) bleiben, bis der Nutzer sie loescht.
const PULL_BACKUP = /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/;

// Kopiert alle Roots nach ~/.clyde/backups/<Zeitstempel>/ und raeumt alte Pull-Sicherungen auf
export async function makeBackup(cfg, log) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupsDir(), ts);
  let copied = 0;
  for (const [name, root] of Object.entries(cfg.roots)) {
    try { await fs.promises.stat(root.path); } catch { continue; }
    const target = path.join(dest, name);
    if (root.kind === 'file') {
      await fs.promises.mkdir(dest, { recursive: true });
      await fs.promises.copyFile(root.path, target);
    } else {
      await fs.promises.cp(root.path, target, { recursive: true, dereference: true, force: true, filter: (s) => !s.endsWith('.clyde-tmp') });
    }
    copied++;
  }
  try {
    const older = (await fs.promises.readdir(backupsDir())).filter((d) => d !== ts && PULL_BACKUP.test(d)).sort();
    const keepOlder = Math.max(0, cfg.backupsToKeep - 1);
    for (const d of older.slice(0, Math.max(0, older.length - keepOlder))) {
      await fs.promises.rm(path.join(backupsDir(), d), { recursive: true, force: true });
      log.debug(`altes Backup entfernt: ${d}`);
    }
  } catch { /* kein Backup-Ordner */ }
  return copied ? dest : null;
}

// Sichert einzelne Dateien unter ~/.clyde/backups/<label>-<Zeitstempel>/<root>/<pfad>;
// wird nie automatisch aufgeraeumt. items: [{root, lp, abs}]
export async function backupFiles(label, items, log) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupsDir(), `${label}-${ts}`);
  for (const it of items) {
    const target = path.join(dest, it.root, ...it.lp.split('/'));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(it.abs, target);
  }
  log.debug(`${items.length} Dateien gesichert: ${dest}`);
  return dest;
}

// Legt einen Verzeichnis-Link an. Fehlt das Ziel, wird es angelegt, sofern sein
// Laufwerk existiert (z. B. D:\ClaudeMemory\...). Sonst normales Verzeichnis.
async function ensureLink(ln, log) {
  try { await fs.promises.lstat(ln.abs); return; } catch { /* existiert nicht */ }
  let targetOk = false;
  try { targetOk = (await fs.promises.stat(ln.t)).isDirectory(); } catch { /* fehlt */ }
  if (!targetOk) {
    const drive = path.parse(ln.t).root;
    let driveOk = false;
    try { driveOk = path.isAbsolute(ln.t) && (await fs.promises.stat(drive)).isDirectory(); } catch { /* fehlt */ }
    if (driveOk) {
      try {
        await fs.promises.mkdir(ln.t, { recursive: true });
        targetOk = true;
        log.info(`Link-Ziel angelegt: ${ln.t}`);
      } catch (e) { log.debug(`Link-Ziel ${ln.t} nicht anlegbar: ${e.message}`); }
    }
  }
  await fs.promises.mkdir(path.dirname(ln.abs), { recursive: true });
  if (targetOk) {
    await fs.promises.symlink(ln.t, ln.abs, process.platform === 'win32' ? 'junction' : 'dir');
    log.info(`Link angelegt: ${ln.abs} -> ${ln.t}`);
  } else {
    await fs.promises.mkdir(ln.abs, { recursive: true });
    log.warn(`Link-Ziel ${ln.t} ist hier nicht anlegbar; ${ln.abs} als normales Verzeichnis angelegt`);
  }
}

export async function pruneEmptyDirs(dir, rootSet) {
  for (;;) {
    if (rootSet.has(path.resolve(dir))) return;
    let st;
    try { st = await fs.promises.lstat(dir); } catch { return; }
    if (!st.isDirectory()) return; // Symlink/Junction nie anfassen
    if ((await fs.promises.readdir(dir)).length) return;
    await fs.promises.rmdir(dir);
    dir = path.dirname(dir);
  }
}

// Setzt einen Plan aus planRestore() um. Reihenfolge:
// benoetigte Chunks aus lokalen Dateien sichern -> fehlende laden -> Backup ->
// Links -> Dateien schreiben (Platzhalter -> lokales Home) -> loeschen
export async function applyPlan({ cfg, local, plan, client, opts, log, extra }) {
  const chunkDir = chunkCacheDir();
  await fs.promises.rm(chunkDir, { recursive: true, force: true });
  await fs.promises.mkdir(chunkDir, { recursive: true });
  const stagedPath = (h) => path.join(chunkDir, h);

  // 1. Benoetigte Chunks nach Quelle gruppieren: schon berechnet (zusammengefuehrte
  //    Dateien), lokal vorhanden oder vom Server zu laden
  const needed = new Set();
  for (const f of plan.write) for (const h of f.c) needed.add(h);
  const bySource = new Map();
  const toDownload = [];
  const staged = new Set();
  for (const [h, data] of extra || []) {
    if (!needed.has(h)) continue;
    await fs.promises.writeFile(stagedPath(h), data);
    staged.add(h);
  }
  for (const h of needed) {
    if (staged.has(h)) continue;
    const src = local.chunkIndex.get(h);
    if (!src) { toDownload.push(h); continue; }
    if (!bySource.has(src.abs)) bySource.set(src.abs, { forms: src.forms, hashes: new Set() });
    bySource.get(src.abs).hashes.add(h);
  }
  for (const [abs, { forms, hashes }] of bySource) {
    try {
      for await (const c of chunkStream(canonicalSource(abs, forms))) {
        if (!hashes.has(c.hash) || staged.has(c.hash)) continue;
        await fs.promises.writeFile(stagedPath(c.hash), c.data);
        staged.add(c.hash);
      }
    } catch (e) { log.debug(`Quelle ${abs} nicht lesbar: ${e.message}`); }
    for (const h of hashes) if (!staged.has(h)) toDownload.push(h); // Datei hat sich geaendert
  }

  // 2. Fehlende Chunks vom Server holen
  let downloadedChunks = 0;
  let downloadedBytes = 0;
  const BATCH = 16;
  for (let i = 0; i < toDownload.length; i += BATCH) {
    await client.fetchBlobs(toDownload.slice(i, i + BATCH), async ({ hash, data }) => {
      await fs.promises.writeFile(stagedPath(hash), data);
      staged.add(hash);
      downloadedChunks++;
      downloadedBytes += data.length;
    });
    log.info(`  geladen ${Math.min(i + BATCH, toDownload.length)}/${toDownload.length} Chunks (${fmtBytes(downloadedBytes)})`);
  }

  // 3. Backup des aktuellen Zustands
  let backupDir = null;
  if (!opts.noBackup) {
    backupDir = await makeBackup(cfg, log);
    if (backupDir) log.info(`  Backup angelegt: ${backupDir}`);
  }

  // 4. Verzeichnis-Links (z. B. memory -> D:\ClaudeMemory)
  for (const ln of plan.links) await ensureLink(ln, log);

  // 5. Dateien schreiben: kanonische Chunks zusammensetzen, Home einsetzen,
  //    temporaer schreiben, atomar umbenennen, mtime uebernehmen
  const cache = loadCache();
  const fkAll = formsKey(cfg);
  const skipped = [];
  // Hat sich eine lokale Datei seit dem Scan geaendert (ein Chat schreibt doch),
  // wird sie nicht ueberschrieben oder geloescht; der naechste Abgleich holt es nach
  const changedSinceScan = async (f) => {
    if (!f.seen) return false;
    try { const st = await fs.promises.stat(f.abs); return st.mtimeMs !== f.seen.m || st.ctimeMs !== f.seen.ct; } catch { return false; }
  };
  for (const f of plan.write) {
    const root = cfg.roots[f.root];
    if (await changedSinceScan(f)) { skipped.push(f); log.warn(`${f.root}/${f.lp} hat sich waehrend des Pulls geaendert und bleibt unveraendert.`); continue; }
    const forms = formsFor(cfg, root, f.lp);
    for (const h of f.c) if (!staged.has(h)) throw new Error(`Chunk ${h.slice(0, 12)} fuer ${f.lp} fehlt`);
    await fs.promises.mkdir(path.dirname(f.abs), { recursive: true });
    const tmp = `${f.abs}.clyde-tmp`;
    const canonical = (async function* () { for (const h of f.c) yield await fs.promises.readFile(stagedPath(h)); })();
    await pipeline(Readable.from(localizeStream(canonical, forms, textMode(f.lp))), fs.createWriteStream(tmp));
    await fs.promises.rename(tmp, f.abs);
    await fs.promises.utimes(f.abs, new Date(), new Date(f.m));
    const st = await fs.promises.stat(f.abs);
    cache[`${root.path}|${f.lp}`] = { s: st.size, m: st.mtimeMs, ct: st.ctimeMs, c: f.c, cs: f.s, fk: forms.length ? fkAll : '-', st: false };
    log.debug(`geschrieben ${f.root}/${f.lp}`);
  }

  // 6. Ueberzaehlige Dateien entfernen, leere Ordner aufraeumen
  const rootSet = new Set(Object.values(cfg.roots).map((r) => path.resolve(r.path)));
  const parents = new Set();
  for (const d of plan.delete) {
    if (await changedSinceScan(d)) { skipped.push(d); log.warn(`${d.root}/${d.lp} hat sich waehrend des Pulls geaendert und wird nicht geloescht.`); continue; }
    await fs.promises.rm(d.abs, { force: true });
    delete cache[`${cfg.roots[d.root].path}|${d.lp}`];
    parents.add(path.dirname(d.abs));
    log.debug(`geloescht ${d.root}/${d.lp}`);
  }
  for (const dir of parents) await pruneEmptyDirs(dir, rootSet);
  saveCache(cache);

  await fs.promises.rm(chunkDir, { recursive: true, force: true });
  return { downloadedChunks, downloadedBytes, backupDir, written: plan.write.length - skipped.filter((s) => plan.write.includes(s)).length, deleted: plan.delete.length - skipped.filter((s) => plan.delete.includes(s)).length, skipped };
}
