// Versionsvergleich Clyde (dieser PC) <-> Server
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLYDE_QUIET = '1';
process.env.CLYDE_SKIP_GUARD = '1';
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_CODE_HOST_SESSION_ID;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-version-'));
process.env.CLYDE_HOME = path.join(tmp, 'clydehome');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');

const { createServer } = await import('../server/server.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { push, pull } = await import('../src/commands.js');
const { status } = await import('../src/commands-misc.js');
const { cmpVersion, versionNotes, CLIENT_VERSION } = await import('../src/version.js');

const TOKEN = 'version-token';
const servers = [];
async function serverWith(opts) {
  const s = createServer({ dataDir: path.join(tmp, `srv-${servers.length}`), token: TOKEN, gcGraceMs: 0, log: { log() {}, error: console.error }, ...opts });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
after(() => { for (const s of servers) s.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const base = path.join(tmp, 'pc');
fs.mkdirSync(path.join(base, 'projects', 'p'), { recursive: true });
fs.writeFileSync(path.join(base, 'projects', 'p', 'c.jsonl'), '{"a":1}\n');
function cfgFor(server) {
  saveConfig({ server, token: TOKEN, home: path.join(tmp, 'home'), roots: { 'claude-projects': path.join(base, 'projects'), 'desktop-sessions': false, 'claude-file-history': false, 'claude-todos': false, 'claude-plans': false, 'claude-history': false } });
  return loadConfig();
}
const collect = () => { const out = []; return { out, log: { info: (s) => out.push(s), warn: (s) => out.push(`WARN ${s}`), debug() {}, error() {} } }; };

test('Versionen vergleichen', () => {
  assert.equal(cmpVersion('0.4.10', '0.4.9'), 1);
  assert.equal(cmpVersion('0.4.7', '0.4.7'), 0);
  assert.equal(cmpVersion('0.3.9', '0.4.0'), -1);
  assert.deepEqual(versionNotes({ version: CLIENT_VERSION }).notes, [], 'gleiche Version: kein Hinweis');
  assert.deepEqual(versionNotes({ version: 'unbekannt' }).notes, [], 'unbekannte Serverversion: kein Hinweis');
});

test('status meldet einen veralteten Client und empfiehlt clyde update', async () => {
  const { out, log } = collect();
  await status(cfgFor(await serverWith({ version: '9.9.9' })), {}, log);
  assert.ok(out[0].includes(`Clyde ${CLIENT_VERSION}`) && out[0].includes('Server 9.9.9'), out[0]);
  assert.ok(out.some((l) => l.startsWith('WARN') && l.includes('veraltet') && l.includes('clyde update')), out.join('\n'));
});

test('status und push melden einen veralteten Server', async () => {
  const srv = await serverWith({ version: '0.4.2' });
  const s = collect();
  await status(cfgFor(srv), {}, s.log);
  assert.ok(s.out.some((l) => l.startsWith('WARN') && l.includes('Server laeuft noch mit 0.4.2')), s.out.join('\n'));
  const p = collect();
  await push(cfgFor(srv), {}, p.log);
  assert.ok(p.out.some((l) => l.startsWith('WARN') && l.includes('Server aktualisieren')), 'Hinweis auch beim Push');
});

test('verlangt der Server eine neuere Client-Version, brechen push und pull ab', async () => {
  const srv = await serverWith({ minClient: '99.0.0' });
  await assert.rejects(push(cfgFor(srv), {}, collect().log), /zu alt fuer den Server/);
  await assert.rejects(pull(cfgFor(srv), { noAsk: true }, collect().log), /zu alt fuer den Server/);
});
