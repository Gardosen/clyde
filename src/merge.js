// Zusammenfuehren statt Spiegeln: Dreiwege-Abgleich je Datei.
//
// L = lokaler Stand, R = gemeinsamer Stand des Kontos (neuester Snapshot),
// B = Basis = der Stand, den dieser PC zuletzt mit dem Konto abgeglichen hat.
// Alles in neutraler Form (Platzhalter), Datei-Identitaet ueber Groesse + Chunk-Hashes.
//
//   L == R                 -> nichts zu tun
//   L == B, R != B         -> nur das Konto hat sich geaendert -> R gilt (auch Loeschen)
//   R == B, L != B         -> nur dieser PC hat sich geaendert -> L gilt (auch Loeschen)
//   beide geaendert        -> Konflikt: Zeilen zusammenfuehren (.jsonl, MEMORY.md),
//                             Chat-Eintraege der Seitenleiste feldweise,
//                             sonst gewinnt die neuere Fassung; geloescht gegen
//                             geaendert -> geaendert bleibt
// Ohne Basis (erster Abgleich) gilt alles als neu: die Staende werden vereinigt.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { clydeHome } from './paths.js';
import { chunkStream } from './chunker.js';
import { sha256 } from './framing.js';
import { absFor, formsFor } from './scan.js';
import { localize, canonicalizeBuf } from './rewrite.js';

export const sigOf = (f) => (f ? `${f.s}:${f.c.join(',')}` : null);
export const keyOf = (root, p) => `${root}\u0000${p}`;

// Basis je PC: gespeichert pro Satz lokaler Pfade, damit mehrere Clyde-Installationen
// (oder Tests) mit eigenem Stand nicht durcheinandergeraten
function baseFile(cfg) {
  const id = crypto.createHash('sha256').update(JSON.stringify([cfg.server, Object.entries(cfg.roots).map(([n, r]) => [n, r.path])])).digest('hex').slice(0, 16);
  return path.join(clydeHome(), `base-${id}.json`);
}
export function loadBase(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(baseFile(cfg), 'utf8'));
    return { snapshotId: j.snapshotId || null, files: new Map(Object.entries(j.files || {})) };
  } catch { return { snapshotId: null, files: new Map() }; }
}
// keep: Map Schluessel -> Signatur (oder null), die statt filesMap gelten (Dateien,
// die ein Pull nicht schreiben konnte, behalten ihre alte Basis)
export function saveBase(cfg, filesMap, snapshotId, keep = null) {
  fs.mkdirSync(clydeHome(), { recursive: true });
  const files = {};
  for (const [k, f] of filesMap) files[k] = sigOf(f);
  for (const [k, sig] of keep || []) { if (sig) files[k] = sig; else delete files[k]; }
  const tmp = `${baseFile(cfg)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, snapshotId, savedAt: new Date().toISOString(), files }));
  fs.renameSync(tmp, baseFile(cfg));
  saveBaseEntries(cfg, files);
}

// Inhalt der Chat-Eintraege (Seitenleiste) zur Basis: damit lassen sich Eintraege,
// die auf zwei PCs geaendert wurden, feldweise zusammenfuehren (Umbenennen auf A,
// Oeffnen auf B). Gespeichert wird nur, was lokal genau der Basis entspricht.
const entriesFile = (cfg) => baseFile(cfg).replace(/\.json$/, '-entries.json');
export const isSidebarEntry = (root, p) => root === 'desktop-sessions' && /(^|\/)local_[^/]+\.json$/.test(p);
function saveBaseEntries(cfg, files) {
  const root = cfg.roots['desktop-sessions'];
  const out = {};
  if (root) {
    for (const [k, sig] of Object.entries(files)) {
      const { root: r, p } = splitKey(k);
      if (!sig || !isSidebarEntry(r, p)) continue;
      const lp = localize(p, cfg.forms);
      let buf;
      try { buf = fs.readFileSync(absFor(root, lp)); } catch { continue; }
      if (buf.length > 1024 * 1024) continue;
      buf = canonicalizeBuf(buf, formsFor(cfg, root, lp));
      if (`${buf.length}:${sha256(buf)}` === sig) out[k] = buf.toString('utf8');
    }
  }
  try {
    const tmp = `${entriesFile(cfg)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, entriesFile(cfg));
  } catch { /* nur eine Hilfe fuer das Zusammenfuehren */ }
}
export function loadBaseEntries(cfg) {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(entriesFile(cfg), 'utf8')))); } catch { return new Map(); }
}

// Chat-Eintrag feldweise zusammenfuehren. Ein Feld, das nur eine Seite seit der
// Basis geaendert hat, kommt von dieser Seite; haben beide es geaendert (oder
// fehlt die Basis), gilt die neuere Fassung. Der Titel mit seinen Begleitfeldern
// zaehlt als ein Feld. Liefert null, wenn ein Eintrag kein JSON ist.
const TITLE_FIELDS = ['title', 'titleSource', 'previousTitles', 'titleTurn'];
export function mergeEntry(newer, older, base) {
  let n, o, b = null;
  try { n = JSON.parse(newer.toString('utf8')); o = JSON.parse(older.toString('utf8')); } catch { return null; }
  if (!n || !o || typeof n !== 'object' || typeof o !== 'object') return null;
  try { b = base ? JSON.parse(base.toString('utf8')) : null; } catch { b = null; }
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const pickOf = (obj, keys) => (obj ? keys.map((k) => obj[k]) : undefined);
  const out = {};
  const keys = [...Object.keys(n), ...Object.keys(o).filter((k) => !(k in n))];
  const decided = new Set();
  for (const k of keys) {
    if (decided.has(k)) continue;
    const group = TITLE_FIELDS.includes(k) ? TITLE_FIELDS : [k];
    group.forEach((g) => decided.add(g));
    const nv = pickOf(n, group), ov = pickOf(o, group), bv = pickOf(b, group);
    let from = n;
    if (!same(nv, ov) && b) {
      if (same(nv, bv)) from = o; // nur die aeltere Fassung hat es geaendert
    }
    for (const g of group) if (g in from) out[g] = from[g];
  }
  // Reihenfolge der neueren Fassung beibehalten
  const ordered = {};
  for (const k of [...Object.keys(n), ...Object.keys(out)]) if (k in out && !(k in ordered)) ordered[k] = out[k];
  return Buffer.from(JSON.stringify(ordered) + (newer.toString('utf8').endsWith('\n') ? '\n' : ''));
}

// roots {name: {files: [...]}} -> Map key -> {root, p, s, m, c, lp?}
export function flatten(roots, onlyRoots) {
  const out = new Map();
  for (const [root, r] of Object.entries(roots || {})) {
    if (onlyRoots && !onlyRoots.includes(root)) continue;
    for (const f of r.files || []) out.set(keyOf(root, f.p), { root, ...f });
  }
  return out;
}
export const splitKey = (k) => { const i = k.indexOf('\u0000'); return { root: k.slice(0, i), p: k.slice(i + 1) }; };

export const unionable = (p) => p.toLowerCase().endsWith('.jsonl') || /(^|\/)MEMORY\.md$/i.test(p);

// Zeilen zusammenfuehren: die neuere Fassung bestimmt die Reihenfolge, fehlende
// Zeilen der anderen werden in ihrer Reihenfolge angehaengt. byUuid (Transkripte):
// eine Zeile mit derselben "uuid" wie eine Zeile der neueren Fassung ist dieselbe
// Nachricht, auch wenn sie sich in der Schreibweise unterscheidet.
const uuidOf = (line) => {
  if (!line.includes('"uuid"')) return null;
  try { const u = JSON.parse(line).uuid; return typeof u === 'string' && u ? u : null; } catch { return null; }
};
export function unionLines(newer, older, { byUuid = false } = {}) {
  const a = newer.toString('utf8');
  const b = older.toString('utf8');
  const aLines = a.split('\n');
  const endsNl = a.endsWith('\n') || (!a.length && b.endsWith('\n'));
  if (aLines[aLines.length - 1] === '') aLines.pop();
  const seen = new Set(aLines);
  const uuids = byUuid ? new Set(aLines.map(uuidOf).filter(Boolean)) : null;
  const extra = [];
  for (const line of b.split('\n')) {
    if (line === '' || seen.has(line)) continue;
    if (uuids) { const u = uuidOf(line); if (u && uuids.has(u)) continue; }
    seen.add(line);
    extra.push(line);
  }
  if (!extra.length) return Buffer.from(a);
  return Buffer.from([...aLines, ...extra].join('\n') + (endsNl ? '\n' : ''));
}

// Entscheidung je Datei. Liefert fuer jede Datei den Zielstand im Konto (merged,
// null = geloescht) und was lokal passieren muss (local: 'none'|'write'|'delete').
export function decide(L, R, B) {
  const keys = new Set([...L.keys(), ...R.keys(), ...B.keys()]);
  const out = [];
  for (const k of keys) {
    const l = L.get(k) || null;
    const r = R.get(k) || null;
    const ls = sigOf(l), rs = sigOf(r), bs = B.has(k) ? B.get(k) : null;
    const { root, p } = splitKey(k);
    let d;
    if (ls === rs) d = { merged: r || l, local: 'none', kind: 'same' };
    else if (ls === bs) d = { merged: r, local: r ? 'write' : 'delete', kind: r ? 'remote' : 'remote-delete' };
    else if (rs === bs) d = { merged: l, local: 'none', kind: l ? 'local' : 'local-delete' };
    else if (l && r && (unionable(p) || isSidebarEntry(root, p))) d = { merged: null, local: 'write', kind: 'union', union: true };
    else if (l && r) {
      const remoteNewer = (r.m || 0) > (l.m || 0);
      d = { merged: remoteNewer ? r : l, local: remoteNewer ? 'write' : 'none', kind: remoteNewer ? 'conflict-remote' : 'conflict-local', conflict: true };
    } else if (r) d = { merged: r, local: 'write', kind: 'conflict-keep-remote', conflict: true };
    else d = { merged: l, local: 'none', kind: 'conflict-keep-local', conflict: true };
    out.push({ key: k, root, p, l, r, ...d });
  }
  return out;
}

// Inhalt als Chunks zerlegen (fuer zusammengefuehrte Dateien)
export async function chunksOf(buf) {
  const chunks = [];
  for await (const c of chunkStream([buf])) chunks.push(c);
  return chunks;
}
