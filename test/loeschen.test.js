// Hash-Cache bei Push-Wiederholungen und Loeschen von Staenden (0.4.3)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLYDE_QUIET = '1';
process.env.CLYDE_SKIP_GUARD = '1';
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_CODE_HOST_SESSION_ID;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-loeschen-'));
process.env.CLYDE_HOME = path.join(tmp, 'clydehome');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');

const { createServer } = await import('../server/server.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { push, pull } = await import('../src/commands.js');
const { del, list } = await import('../src/commands-misc.js');
const { buildLocalManifest } = await import('../src/scan.js');
const { applyPlan } = await import('../src/restore.js');
const { Client } = await import('../src/client.js');
const { sha256 } = await import('../src/framing.js');
const { cachePath } = await import('../src/paths.js');

const TOKEN = 'loeschen-token';
const servers = [];
async function startServer(name) {
  const s = createServer({ dataDir: path.join(tmp, name), token: TOKEN, gcGraceMs: 0, log: { log() {}, error: console.error } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
after(() => { for (const s of servers) s.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const collect = () => { const out = []; return { out, log: { info: (s) => out.push(s), warn: (s) => out.push(`WARN ${s}`), debug() {}, error() {} } }; };
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const read = (p) => fs.readFileSync(p, 'utf8');
const rootsFor = (base) => ({
  'claude-projects': path.join(base, 'projects'),
  'desktop-sessions': path.join(base, 'sessions'),
  'claude-history': { path: path.join(base, 'history.jsonl'), kind: 'file' },
  'claude-file-history': false, 'claude-todos': false, 'claude-plans': false,
});
function useConfig(base, server) {
  saveConfig({ server, token: TOKEN, roots: rootsFor(base), home: path.join(tmp, `home-${path.basename(base)}`), backupsToKeep: 2 });
  return loadConfig();
}
const fileChunks = (snap, suffix) => snap.roots['claude-projects'].files.find((f) => f.p.endsWith(suffix))?.c;

test('Cache: gleiche Groesse und zurueckgesetztes mtime werden ueber ctime erkannt', async () => {
  const SRV = await startServer('s-cache');
  const A = path.join(tmp, 'A');
  const mem = path.join(A, 'projects', 'p', 'memory', 'MEMORY.md');
  const T = new Date('2026-09-20T10:00:00Z');
  write(mem, 'aaaa\n');
  fs.utimesSync(mem, T, T);
  const cfg = useConfig(A, SRV);
  await push(cfg, {}, quiet);
  await new Promise((r) => setTimeout(r, 30));
  write(mem, 'bbbb\n'); // Reparatur wie im Vorfall: gleiche Groesse ...
  fs.utimesSync(mem, T, T); // ... und altes mtime
  const { stats, roots } = await buildLocalManifest(cfg, quiet);
  assert.equal(stats.hashedFiles, 1, 'die Datei wird neu gehasht');
  assert.deepEqual(roots['claude-projects'].files.find((f) => f.lp.endsWith('MEMORY.md')).c, [sha256(Buffer.from('bbbb\n'))]);
});

test('Push-Wiederholung: veralteter Cache-Eintrag wird verworfen und neu gehasht', async () => {
  const SRV = await startServer('s-retry');
  const A = path.join(tmp, 'A2');
  const mem = path.join(A, 'projects', 'p', 'memory', 'MEMORY.md');
  write(mem, 'aaaa\n');
  const cfg = useConfig(A, SRV);
  await push(cfg, {}, quiet);
  write(mem, 'cccc\n');
  await buildLocalManifest(cfg, quiet); // Cache mit passendem Schluessel ...
  const cache = JSON.parse(read(cachePath()));
  const key = Object.keys(cache).find((k) => k.endsWith('MEMORY.md'));
  cache[key].c = [sha256(Buffer.from('zzzz\n'))]; // ... aber falschem Hash (wie im Vorfall)
  fs.writeFileSync(cachePath(), JSON.stringify(cache));
  const { out, log } = collect();
  await push(cfg, {}, log);
  assert.equal(out.filter((l) => l.includes('waehrend des Push geaendert')).length, 1, out.join('\n'));
  const snap = await new Client(SRV, TOKEN).getSnapshot('latest');
  assert.deepEqual(fileChunks(snap, 'MEMORY.md'), [sha256(Buffer.from('cccc\n'))], 'richtiger Inhalt auf dem Server');
});

test('Push-Wiederholung: Aufraeumen (gc) waehrend des Pushs fuehrt zu erneutem Hochladen', async () => {
  const SRV = await startServer('s-gc');
  const A = path.join(tmp, 'A3');
  write(path.join(A, 'projects', 'p', 'a.jsonl'), '{"a":1}\n');
  const cfg = useConfig(A, SRV);
  await push(cfg, {}, quiet);
  write(path.join(A, 'projects', 'p', 'b.jsonl'), '{"b":2}\n');
  const orig = Client.prototype.putSnapshot;
  let first = true;
  Client.prototype.putSnapshot = async function (m) {
    if (first) { first = false; await this.gc(); } // raeumt die gerade hochgeladenen Chunks weg (Schutzfrist 0)
    return orig.call(this, m);
  };
  try {
    const { out, log } = collect();
    await push(cfg, {}, log);
    assert.ok(out.some((l) => l.includes('fehlen')), out.join('\n'));
  } finally { Client.prototype.putSnapshot = orig; }
  const snap = await new Client(SRV, TOKEN).getSnapshot('latest');
  assert.ok(fileChunks(snap, 'b.jsonl'), 'neuer Chat ist im Stand');
});

test('Pull ueberschreibt keine Datei, die sich seit dem Scan geaendert hat', async () => {
  const F = path.join(tmp, 'F');
  const cfg = useConfig(F, 'http://127.0.0.1:1');
  const abs = path.join(F, 'projects', 'p', 'f.jsonl');
  write(abs, 'lokal\n');
  const data = Buffer.from('konto\n');
  const h = sha256(data);
  const plan = { write: [{ root: 'claude-projects', p: 'p/f.jsonl', lp: 'p/f.jsonl', s: data.length, m: Date.now(), c: [h], abs, isNew: false, seen: { m: 1, ct: 1 } }], delete: [], links: [] };
  const run = () => applyPlan({ cfg, local: { chunkIndex: new Map() }, plan, client: null, opts: { noBackup: true }, log: quiet, extra: new Map([[h, data]]) });
  const r = await run();
  assert.equal(r.skipped.length, 1);
  assert.equal(read(abs), 'lokal\n', 'lokale Aenderung bleibt');
  const st = fs.statSync(abs);
  plan.write[0].seen = { m: st.mtimeMs, ct: st.ctimeMs };
  assert.equal((await run()).skipped.length, 0);
  assert.equal(read(abs), 'konto\n');
});

test('Staende: frei werdender Platz, neuester nur mit --force, Loeschen nur mit Bestaetigung', async () => {
  const SRV = await startServer('s-del');
  const D = path.join(tmp, 'D');
  write(path.join(D, 'projects', 'p', 'x.jsonl'), '{"x":1}\n');
  const cfg = useConfig(D, SRV);
  const s1 = (await push(cfg, {}, quiet)).id;
  write(path.join(D, 'projects', 'p', 'y.jsonl'), '{"y":2}\n');
  const s2 = (await push(cfg, {}, quiet)).id;
  const { snapshots } = await list(cfg, {}, quiet);
  const [n, o] = snapshots;
  assert.equal(n.id, s2);
  assert.ok(n.newest && !o.newest);
  assert.equal(o.exclusive.chunks, 0, 'alles aus dem aelteren Stand steckt auch im neueren');
  assert.equal(n.exclusive.chunks, 1, 'y.jsonl gibt es nur im neuesten');
  assert.ok(n.exclusive.bytes > 0);

  const c = new Client(SRV, TOKEN);
  await assert.rejects(c.deleteSnapshot(s2), /HTTP 409.*neueste/);
  await assert.rejects(del(cfg, { args: [s2], yes: true }, quiet), /--force/);
  await assert.rejects(del(cfg, { args: [s1], noAsk: true }, quiet), /--yes/);
  const dry = collect();
  await del(cfg, { args: [s2], dryRun: true }, dry.log);
  assert.ok(dry.out.some((l) => l.startsWith('WARN') && l.includes('neueste')), dry.out.join('\n'));
  assert.equal((await c.listSnapshots()).snapshots.length, 2, 'nichts geloescht');
  const r = await del(cfg, { args: [s1], yes: true }, quiet);
  assert.equal(r.deleted, 1);
  assert.deepEqual((await c.listSnapshots()).snapshots.map((s) => s.id), [s2]);
});

test('Basis geloescht: der naechste Pull vereinigt nur und loescht nichts', async () => {
  const SRV = await startServer('s-base');
  const A = path.join(tmp, 'BA');
  const B = path.join(tmp, 'BB');
  write(path.join(A, 'projects', 'p', 'x.jsonl'), '{"x":1}\n');
  await push(useConfig(A, SRV), {}, quiet);
  fs.mkdirSync(path.join(B, 'projects'), { recursive: true });
  await pull(useConfig(B, SRV), { noAsk: true }, quiet);
  write(path.join(A, 'projects', 'p', 'y.jsonl'), '{"y":2}\n');
  const s2 = (await push(useConfig(A, SRV), {}, quiet)).id;
  await pull(useConfig(B, SRV), { noAsk: true }, quiet);
  assert.ok(fs.existsSync(path.join(B, 'projects', 'p', 'y.jsonl')));
  await new Client(SRV, TOKEN).deleteSnapshot(s2, { force: true }); // neuester Stand weg, Basis von B fehlt
  const { out, log } = collect();
  await pull(useConfig(B, SRV), { noAsk: true }, log);
  assert.ok(out.some((l) => l.includes('vereinigt deshalb nur')), out.join('\n'));
  assert.ok(fs.existsSync(path.join(B, 'projects', 'p', 'y.jsonl')), 'y bleibt auf B');
  await push(useConfig(B, SRV), {}, quiet);
  const snap = await new Client(SRV, TOKEN).getSnapshot('latest');
  assert.ok(fileChunks(snap, 'y.jsonl'), 'B bringt y wieder ins Konto');
});
