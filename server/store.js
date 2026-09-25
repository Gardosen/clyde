// Ablage auf dem Server: Chunks (gzip, inhaltsadressiert) und Snapshot-Manifeste
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }
export const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(id);

export function manifestHashes(m) {
  const s = new Set();
  for (const r of Object.values(m.roots || {})) for (const f of r.files || []) for (const h of f.c || []) s.add(h);
  return s;
}

export class Store {
  constructor(dataDir) {
    this.blobDir = path.join(dataDir, 'blobs');
    this.snapDir = path.join(dataDir, 'snapshots');
    fs.mkdirSync(this.blobDir, { recursive: true });
    fs.mkdirSync(this.snapDir, { recursive: true });
  }
  blobPath(h) { return path.join(this.blobDir, h.slice(0, 2), `${h}.gz`); }
  snapPath(id) { return path.join(this.snapDir, `${id}.json`); }
  exists(p) { return fs.promises.access(p).then(() => true, () => false); }
  hasBlob(h) { return this.exists(this.blobPath(h)); }

  async missing(hashes) {
    const out = [];
    for (const h of hashes) if (!(await this.hasBlob(h))) out.push(h);
    return out;
  }
  // true = neu gespeichert, false = war schon da
  async putBlob(hash, data) {
    const dest = this.blobPath(hash);
    if (await this.exists(dest)) return false;
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.promises.writeFile(tmp, await gzip(data));
    await fs.promises.rename(tmp, dest);
    return true;
  }
  async getBlob(hash) { return gunzip(await fs.promises.readFile(this.blobPath(hash))); }

  async listSnapshots() {
    const out = [];
    for (const f of await fs.promises.readdir(this.snapDir)) {
      if (!f.endsWith('.json')) continue;
      try { out.push(JSON.parse(await fs.promises.readFile(path.join(this.snapDir, f), 'utf8'))); } catch { /* defekt */ }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return out;
  }
  async getSnapshot(id) {
    try { return JSON.parse(await fs.promises.readFile(this.snapPath(id), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async putSnapshot(man) {
    const tmp = `${this.snapPath(man.id)}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(man));
    await fs.promises.rename(tmp, this.snapPath(man.id));
  }
  async deleteSnapshot(id) {
    try { await fs.promises.unlink(this.snapPath(id)); return true; }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }
  async gc() {
    const referenced = new Set();
    for (const man of await this.listSnapshots()) for (const h of manifestHashes(man)) referenced.add(h);
    let deleted = 0, kept = 0, freedBytes = 0;
    for (const sub of await fs.promises.readdir(this.blobDir)) {
      const d = path.join(this.blobDir, sub);
      for (const f of await fs.promises.readdir(d)) {
        if (!f.endsWith('.gz')) continue;
        if (referenced.has(f.slice(0, -3))) { kept++; continue; }
        const st = await fs.promises.stat(path.join(d, f));
        await fs.promises.unlink(path.join(d, f));
        deleted++; freedBytes += st.size;
      }
    }
    return { deleted, kept, freedBytes };
  }
}
