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
//                             sonst gewinnt die neuere Fassung; geloescht gegen
//                             geaendert -> geaendert bleibt
// Ohne Basis (erster Abgleich) gilt alles als neu: die Staende werden vereinigt.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { clydeHome } from './paths.js';
import { chunkStream } from './chunker.js';

export const sigOf = (f) => (f ? `${f.s}:${f.c.join(',')}` : null);
const keyOf = (root, p) => `${root}\u0000${p}`;

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
export function saveBase(cfg, filesMap, snapshotId) {
  fs.mkdirSync(clydeHome(), { recursive: true });
  const files = {};
  for (const [k, f] of filesMap) files[k] = sigOf(f);
  const tmp = `${baseFile(cfg)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, snapshotId, savedAt: new Date().toISOString(), files }));
  fs.renameSync(tmp, baseFile(cfg));
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
    else if (l && r && unionable(p)) d = { merged: null, local: 'write', kind: 'union', union: true };
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
