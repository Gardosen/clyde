import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { sha256 } from './framing.js';
import { canonicalizeBuf, localizeFn, transformStream } from './rewrite.js';

export const CHUNK_SIZE = 4 * 1024 * 1024;

// Roher Byte-Strom einer Datei
export function rawSource(absPath) {
  return fs.createReadStream(absPath, { highWaterMark: 1024 * 1024 });
}

// Kanonischer Byte-Strom: lokale Werte durch Platzhalter ersetzt (forms leer = roh)
export function canonicalSource(absPath, forms) {
  const src = rawSource(absPath);
  return forms.length ? transformStream(src, (b) => canonicalizeBuf(b, forms)) : src;
}

// Umkehrung fuer das Schreiben: Platzhalter durch die lokalen Werte ersetzen.
// mode (textMode des Pfads): jsonl prueft jede Zeile, json die ganze Datei
// (bis 64 MiB im Speicher) auf gueltiges JSON.
const JSON_WHOLE_LIMIT = 64 * 1024 * 1024;
export async function* localizeStream(source, forms, mode = 'text') {
  if (!forms.length) { yield* source; return; }
  if (mode !== 'json') { yield* transformStream(source, (b) => localizeFn(mode)(b, forms)); return; }
  const it = (source[Symbol.asyncIterator] || source[Symbol.iterator]).call(source);
  const parts = [];
  let len = 0;
  let whole = true;
  for (;;) {
    const { value, done } = await it.next();
    if (done) break;
    parts.push(value);
    len += value.length;
    if (len > JSON_WHOLE_LIMIT) { whole = false; break; }
  }
  if (whole) { yield localizeFn('json')(Buffer.concat(parts), forms); return; }
  const rest = (async function* () { yield* parts; for (;;) { const { value, done } = await it.next(); if (done) return; yield value; } })();
  yield* transformStream(rest, (b) => localizeFn('text')(b, forms));
}

// Zerlegt einen Byte-Strom in 4-MiB-Chunks: {index, hash, data}
export async function* chunkStream(source) {
  const parts = [];
  let len = 0;
  let index = 0;
  for await (const piece of source) {
    if (!piece.length) continue;
    parts.push(piece);
    len += piece.length;
    while (len >= CHUNK_SIZE) {
      const all = Buffer.concat(parts);
      const data = Buffer.from(all.subarray(0, CHUNK_SIZE));
      yield { index: index++, hash: sha256(data), data };
      const rest = all.subarray(CHUNK_SIZE);
      parts.length = 0;
      len = 0;
      if (rest.length) { parts.push(Buffer.from(rest)); len = rest.length; }
    }
  }
  if (len) {
    const data = Buffer.concat(parts);
    yield { index: index++, hash: sha256(data), data };
  }
}

// Hasht eine Datei in kanonischer Form; liefert Chunk-Hashes, kanonische Groesse
// und ob die Datei "veraltet lokalisiert" ist: neutral und zurueck ergibt nicht
// mehr die Originalbytes (z. B. nach einer neuen Projekt-Zuordnung). Solche Dateien
// muss ein Pull neu schreiben, obwohl ihre neutrale Form unveraendert ist.
export async function hashFile(absPath, forms, mode = 'text') {
  const chunks = [];
  let size = 0;
  if (!forms.length) {
    for await (const c of chunkStream(rawSource(absPath))) { chunks.push(c.hash); size += c.data.length; }
    return { chunks, size, stale: false };
  }
  const rawHash = createHash('sha256');
  const backHash = createHash('sha256');
  const tapped = (async function* () { for await (const p of rawSource(absPath)) { rawHash.update(p); yield p; } })();
  const canonical = transformStream(tapped, (b) => canonicalizeBuf(b, forms));
  const chunkData = (async function* () { for await (const c of chunkStream(canonical)) { chunks.push(c.hash); size += c.data.length; yield c.data; } })();
  for await (const b of localizeStream(chunkData, forms, mode)) backHash.update(b);
  return { chunks, size, stale: rawHash.digest('hex') !== backHash.digest('hex') };
}

// Groesse von Chunk Nr. i bei bekannter Gesamtgroesse
export function chunkSizeAt(totalSize, i) {
  return Math.max(0, Math.min(CHUNK_SIZE, totalSize - i * CHUNK_SIZE));
}
