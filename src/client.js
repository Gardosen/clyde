import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decodeBlobs, encodeBlob, sha256 } from './framing.js';

async function readAll(stream) {
  const parts = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts).toString('utf8');
}

export class Client {
  constructor(server, token) {
    if (!server) throw new Error('Kein Server eingerichtet: clyde init --server URL --token TOKEN');
    this.base = server.replace(/\/+$/, '');
    this.token = token || '';
  }

  request(method, p, { headers = {}, body, bodyStreams } = {}) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(this.base + p); } catch { return reject(new Error(`Ungueltige Server-URL: ${this.base}`)); }
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(url, { method, headers: { authorization: `Bearer ${this.token}`, ...headers } },
        (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res }));
      req.on('error', (e) => reject(new Error(`Server ${this.base} nicht erreichbar: ${e.message}`)));
      if (bodyStreams) pipeline(...bodyStreams, req).catch((e) => { req.destroy(e); reject(e); });
      else req.end(body);
    });
  }

  async json(method, p, obj) {
    const res = await this.request(method, p, {
      headers: obj === undefined ? {} : { 'content-type': 'application/json' },
      body: obj === undefined ? undefined : JSON.stringify(obj),
    });
    const text = await readAll(res.stream);
    if (res.status >= 300) throw new Error(`${method} ${p}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  health() { return this.json('GET', '/health'); }
  me() { return this.json('GET', '/me'); }
  missing(hashes) { return this.json('POST', '/blobs/missing', { hashes }); }
  listSnapshots() { return this.json('GET', '/snapshots'); }
  getSnapshot(id) { return this.json('GET', `/snapshots/${encodeURIComponent(id)}`); }
  putSnapshot(m) { return this.json('PUT', `/snapshots/${encodeURIComponent(m.id)}`, m); }
  deleteSnapshot(id) { return this.json('DELETE', `/snapshots/${encodeURIComponent(id)}`); }
  gc() { return this.json('POST', '/gc'); }

  // blobs: (async) Iterable von {hash, data}; wird gerahmt und gzip-komprimiert gestreamt
  async upload(blobs) {
    const src = Readable.from((async function* () {
      for await (const b of blobs) { const [h, d] = encodeBlob(b.hash, b.data); yield h; yield d; }
    })());
    const res = await this.request('POST', '/blobs/upload', {
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' },
      bodyStreams: [src, zlib.createGzip({ level: 6 })],
    });
    const text = await readAll(res.stream);
    if (res.status >= 300) throw new Error(`Upload fehlgeschlagen: HTTP ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  // Holt Chunks in einem Stream; onBlob({hash, data}) wird je Chunk aufgerufen
  async fetchBlobs(hashes, onBlob) {
    const res = await this.request('POST', '/blobs/fetch', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes }),
    });
    if (res.status >= 300) throw new Error(`Download fehlgeschlagen: HTTP ${res.status} ${(await readAll(res.stream)).slice(0, 300)}`);
    const gunzip = zlib.createGunzip();
    pipeline(res.stream, gunzip).catch((e) => gunzip.destroy(e));
    let n = 0;
    for await (const b of decodeBlobs(gunzip)) {
      if (sha256(b.data) !== b.hash) throw new Error(`Server lieferte beschaedigten Chunk ${b.hash.slice(0, 12)}`);
      await onBlob(b);
      n++;
    }
    if (n !== hashes.length) throw new Error(`Server lieferte ${n} statt ${hashes.length} Chunks`);
  }
}
