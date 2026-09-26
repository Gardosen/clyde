import fs from 'node:fs';
import path from 'node:path';
import { hashFile, chunkSizeAt } from './chunker.js';
import { sha256 } from './framing.js';
import { cachePath, clydeHome } from './paths.js';
import { canonicalize, isTextFile, textMode, REWRITE_VERSION } from './rewrite.js';
import { pathBelongsTo } from './session.js';

// Absoluter Pfad einer Datei (lokaler Relativpfad) innerhalb eines Roots
export function absFor(root, lp) {
  return root.kind === 'file' ? root.path : path.join(root.path, ...lp.split('/'));
}

// Werden in Dateien dieses Roots lokale Werte ersetzt? (Datei-Historie: nein, das
// sind Kopien von Projektdateien, die so bleiben muessen, wie sie sind)
export function formsFor(cfg, root, lp) {
  return root.rewrite !== false && isTextFile(lp) ? cfg.forms : [];
}

// Signatur der Platzhalter-Regeln; aendern sie sich (neue Zuordnung, anderes
// Laufwerk), sind gecachte Hashes von Textdateien ungueltig
export function formsKey(cfg) {
  return sha256(JSON.stringify([REWRITE_VERSION, cfg.forms.map((f) => [f.tag, f.value])])).slice(0, 16);
}

const UNC_PREFIX = String.fromCharCode(92, 92, 63, 92); // Windows-Praefix vor Junction-Zielen
const cleanLinkTarget = (t) => (t.startsWith(UNC_PREFIX) ? t.slice(UNC_PREFIX.length) : t);

// Laeuft ein Verzeichnis ab. Symbolische Links auf Verzeichnisse werden verfolgt
// und zusaetzlich als Link vermerkt (z. B. memory -> D:\ClaudeMemory\...).
export async function walkDir(rootAbs) {
  const files = [];
  const links = [];
  async function rec(rel) {
    const abs = rel ? path.join(rootAbs, ...rel.split('/')) : rootAbs;
    const entries = await fs.promises.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.endsWith('.clyde-tmp')) continue;
      const erel = rel ? `${rel}/${e.name}` : e.name;
      const eabs = path.join(abs, e.name);
      if (e.isSymbolicLink()) {
        let st;
        try { st = await fs.promises.stat(eabs); } catch { continue; } // haengender Link
        if (st.isDirectory()) {
          links.push({ p: erel, t: cleanLinkTarget(await fs.promises.readlink(eabs)) });
          await rec(erel);
        } else if (st.isFile()) {
          files.push({ p: erel, abs: eabs, s: st.size, m: st.mtimeMs, ct: st.ctimeMs });
        }
      } else if (e.isDirectory()) {
        await rec(erel);
      } else if (e.isFile()) {
        const st = await fs.promises.stat(eabs);
        files.push({ p: erel, abs: eabs, s: st.size, m: st.mtimeMs, ct: st.ctimeMs });
      }
    }
  }
  await rec('');
  return { files, links };
}

export function loadCache() {
  try { return JSON.parse(fs.readFileSync(cachePath(), 'utf8')); } catch { return {}; }
}
export function saveCache(c) {
  fs.mkdirSync(clydeHome(), { recursive: true });
  fs.writeFileSync(cachePath(), JSON.stringify(c));
}

// Erfasst alle Roots, hasht geaenderte Dateien und liefert Manifest-Roots
// (kanonische Pfade und Inhalte) plus einen Index Hash -> lokale Fundstelle.
// Cache-Treffer nur bei gleicher Groesse, mtime, ctime und Regel-Signatur: ctime
// aendert sich bei jedem Schreiben, auch wenn danach mtime zurueckgesetzt wird.
// rehash: Cache ganz ignorieren; forget: Set absoluter Pfade, die neu zu hashen sind.
export async function buildLocalManifest(cfg, log, { rehash = false, forget = null } = {}) {
  const oldCache = loadCache();
  const cache = {};
  const roots = {};
  const chunkIndex = new Map();
  const fkAll = formsKey(cfg);
  const stats = { files: 0, bytes: 0, hashedFiles: 0, hashedBytes: 0, chunks: 0, stale: 0, excluded: 0 };

  for (const [name, root] of Object.entries(cfg.roots)) {
    let entries = [];
    let links = [];
    let st = null;
    try { st = await fs.promises.stat(root.path); } catch { /* fehlt */ }
    if (!st) {
      log.debug(`Root ${name} fehlt lokal (${root.path})`);
      roots[name] = { kind: root.kind, missing: true, files: [], links: [] };
      continue;
    }
    if (root.kind === 'file') {
      if (st.isFile()) entries = [{ p: path.basename(root.path), abs: root.path, s: st.size, m: st.mtimeMs, ct: st.ctimeMs }];
    } else if (st.isDirectory()) {
      ({ files: entries, links } = await walkDir(root.path));
    }
    // Clyde-Chats (und der aufrufende Chat) sind unsichtbar: weder Upload noch Loeschen
    if (cfg.exclude?.length) {
      const before = entries.length;
      entries = entries.filter((f) => !pathBelongsTo(f.p, cfg.exclude));
      stats.excluded += before - entries.length;
    }
    const files = [];
    for (const f of entries) {
      const key = `${root.path}|${f.p}`;
      const c = oldCache[key];
      const forms = formsFor(cfg, root, f.p);
      const fk = forms.length ? fkAll : '-';
      let chunks;
      let csize;
      let stale;
      const fresh = rehash || (forget && forget.has(f.abs));
      if (!fresh && c && c.s === f.s && c.m === f.m && c.ct === f.ct && c.fk === fk && typeof c.cs === 'number') {
        chunks = c.c;
        csize = c.cs;
        stale = !!c.st;
      } else {
        ({ chunks, size: csize, stale } = await hashFile(f.abs, forms, textMode(f.p)));
        stats.hashedFiles++;
        stats.hashedBytes += f.s;
      }
      cache[key] = { s: f.s, m: f.m, ct: f.ct, c: chunks, cs: csize, fk, st: stale };
      if (stale) stats.stale++;
      chunks.forEach((h, i) => {
        if (!chunkIndex.has(h)) chunkIndex.set(h, { abs: f.abs, index: i, forms, size: chunkSizeAt(csize, i) });
      });
      files.push({ p: canonicalize(f.p, cfg.forms), lp: f.p, s: csize, m: f.m, ct: f.ct, c: chunks, stale });
      stats.files++;
      stats.bytes += f.s;
    }
    roots[name] = {
      kind: root.kind,
      files,
      links: links.map((l) => ({ p: canonicalize(l.p, cfg.forms), t: canonicalize(l.t, cfg.forms) })),
    };
  }
  saveCache(cache);
  stats.chunks = chunkIndex.size;
  return { roots, chunkIndex, stats };
}

// Manifest-Roots ohne lokale Zusatzfelder (fuer den Upload)
export function manifestRoots(localRoots) {
  const out = {};
  for (const [name, r] of Object.entries(localRoots)) {
    out[name] = { kind: r.kind, missing: r.missing || undefined, files: r.files.map(({ p, s, m, c }) => ({ p, s, m, c })), links: r.links };
  }
  return out;
}
