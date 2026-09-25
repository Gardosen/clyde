import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-cfg-'));
process.env.CLYDE_HOME = tmp;
process.env.CLYDE_QUIET = '1';
const { loadConfig, saveConfig, normalizeServerUrl } = await import('../src/config.js');
const { init } = await import('../src/commands-misc.js');
const { createServer } = await import('../server/server.js');
const { log } = await import('../src/log.js');

const server = createServer({ dataDir: path.join(tmp, 'server'), token: 'cfg-token', adminPassword: 'x'.repeat(12), log: { log() {}, error() {} } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const capture = () => { const out = []; return { out, l: { info: (s) => out.push(s), warn: (s) => out.push(`WARN ${s}`), debug() {} } }; };

test('ohne Einrichtung gibt es keinen Server, und Befehle verweisen auf init', () => {
  const cfg = loadConfig({ required: false });
  assert.equal(cfg.server, null);
  assert.throws(() => loadConfig(), /clyde init --server URL --token TOKEN/);
});

test('Server-URL wird vereinheitlicht', () => {
  assert.equal(normalizeServerUrl('clyde.example.com/'), 'https://clyde.example.com');
  assert.equal(normalizeServerUrl(' "http://localhost:8484/" '), 'http://localhost:8484');
  assert.equal(normalizeServerUrl('https://host.tld/sub/'), 'https://host.tld/sub');
  assert.throws(() => normalizeServerUrl('ftp://x'), /http/);
  assert.equal(normalizeServerUrl(''), null);
});

test('init ohne URL oder Token schlaegt ohne Terminal fehl', async () => {
  await assert.rejects(init(loadConfig({ required: false }), { token: 'abc', noAsk: true }, log), /Server-URL und Token sind bei der Ersteinrichtung Pflicht/);
  await assert.rejects(init(loadConfig({ required: false }), { server: URL_, noAsk: true }, log), /Pflicht/);
  assert.ok(!fs.existsSync(path.join(tmp, 'config.json')), 'nichts gespeichert');
});

test('init fragt fehlende Angaben nach und prueft Server und Token', async () => {
  const asked = [];
  const { out, l } = capture();
  await init(loadConfig({ required: false }), { ask: async (q) => { asked.push(q); return q.includes('Adresse') ? URL_ : 'cfg-token'; } }, l);
  assert.equal(asked.length, 2);
  const cfg = loadConfig();
  assert.equal(cfg.server, URL_);
  assert.equal(cfg.token, 'cfg-token');
  assert.ok(out.some((s) => s.includes('Token gehoert zu Benutzer "admin" (Admin)')), out.join('\n'));
});

test('falscher Token und fremder Server werden gemeldet', async () => {
  const a = capture();
  await init(loadConfig(), { token: 'falsch', noAsk: true }, a.l);
  assert.ok(a.out.some((s) => s.includes('Token wird nicht akzeptiert')), a.out.join('\n'));
  const b = capture();
  await init(loadConfig(), { server: 'http://127.0.0.1:1', token: 'cfg-token', noAsk: true }, b.l);
  assert.ok(b.out.some((s) => s.startsWith('WARN Server nicht erreichbar')), b.out.join('\n'));
});

test('bestehende Werte bleiben, Root-Ueberschreibungen auch', async () => {
  await init(loadConfig(), { server: URL_, token: 'cfg-token', noAsk: true }, log);
  saveConfig({ ...loadConfig().raw, roots: { 'claude-plans': false } });
  await init(loadConfig(), { token: 'neu', noAsk: true }, log);
  const cfg = loadConfig();
  assert.equal(cfg.server, URL_, 'Server bleibt, wenn nur der Token neu kommt');
  assert.equal(cfg.token, 'neu');
  assert.ok(!('claude-plans' in cfg.roots));
});
