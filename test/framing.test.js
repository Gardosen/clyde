import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeBlob, decodeBlobs, sha256 } from '../src/framing.js';
import { chunkStream, hashFile, rawSource, CHUNK_SIZE } from '../src/chunker.js';
import { homeForms } from '../src/rewrite.js';

// Zerlegt einen Buffer in zufaellig grosse Stuecke (simuliert Netzwerk-Chunks)
function* shred(buf, seed = 7) {
  let off = 0; let s = seed;
  while (off < buf.length) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const n = 1 + (s % 70000);
    yield buf.subarray(off, Math.min(off + n, buf.length));
    off += n;
  }
}

test('Blob-Rahmen ueberleben beliebige Stream-Zerlegung', async () => {
  const blobs = [randomBytes(0), randomBytes(1), randomBytes(65536), randomBytes(3 * 1024 * 1024 + 17), randomBytes(5)];
  const wire = Buffer.concat(blobs.flatMap((b) => encodeBlob(sha256(b), b)));
  for (const seed of [1, 7, 99]) {
    const got = [];
    for await (const b of decodeBlobs(shred(wire, seed))) got.push(b);
    assert.equal(got.length, blobs.length);
    got.forEach((g, i) => { assert.equal(g.hash, sha256(blobs[i])); assert.ok(g.data.equals(blobs[i])); });
  }
});

test('abgeschnittener Stream wird erkannt', async () => {
  const b = randomBytes(1000);
  const wire = Buffer.concat(encodeBlob(sha256(b), b)).subarray(0, 500);
  await assert.rejects((async () => { for await (const x of decodeBlobs([wire])) void x; })(), /Unvollstaendig/);
});

test('Chunker zerlegt Stroeme in 4-MiB-Stuecke, unabhaengig von der Stueckelung', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-chunk-'));
  const f = path.join(dir, 'x.bin');
  const data = randomBytes(2 * CHUNK_SIZE + 12345);
  fs.writeFileSync(f, data);
  const chunks = [];
  for await (const c of chunkStream(rawSource(f))) chunks.push(c);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].hash, sha256(data.subarray(0, CHUNK_SIZE)));
  assert.equal(chunks[2].hash, sha256(data.subarray(2 * CHUNK_SIZE)));
  assert.ok(chunks[2].data.equals(data.subarray(2 * CHUNK_SIZE)));
  const viaShred = [];
  for await (const c of chunkStream(shred(data, 3))) viaShred.push(c.hash);
  assert.deepEqual(viaShred, chunks.map((c) => c.hash));
  fs.writeFileSync(f, '');
  assert.deepEqual((await hashFile(f, [])).chunks, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hashFile mit Platzhaltern: gleiche Chats verschiedener Konten ergeben gleiche Hashes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-hash-'));
  const a = path.join(dir, 'a.jsonl');
  const b = path.join(dir, 'b.jsonl');
  fs.writeFileSync(a, '{"cwd":"C:\\\\Users\\\\alice\\\\p"}\n{"k":"C--Users-alice-p"}\n');
  fs.writeFileSync(b, '{"cwd":"C:\\\\Users\\\\bobbybob\\\\p"}\n{"k":"C--Users-bobbybob-p"}\n');
  const ha = await hashFile(a, homeForms('C:\\Users\\alice'));
  const hb = await hashFile(b, homeForms('C:\\Users\\bobbybob'));
  assert.deepEqual(ha.chunks, hb.chunks);
  assert.equal(ha.size, hb.size);
  assert.notDeepEqual((await hashFile(a, [])).chunks, ha.chunks, 'ohne Platzhalter muss der Hash anders sein');
  fs.rmSync(dir, { recursive: true, force: true });
});
