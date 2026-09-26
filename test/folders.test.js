// Chats ohne Arbeitsordner: anzeigen, Ordner anlegen, umstellen (mit Verweis)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.CLYDE_QUIET = '1';
process.env.CLYDE_SKIP_GUARD = '1';
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_CODE_HOST_SESSION_ID;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-folders-'));
process.env.CLYDE_HOME = path.join(tmp, 'clydehome');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');

const { createServer } = await import('../server/server.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { push } = await import('../src/commands.js');
const { folders } = await import('../src/commands-misc.js');
const { Client } = await import('../src/client.js');
const { remoteKey } = await import('../src/repos.js');

const TOKEN = 'folders-token';
const server = createServer({ dataDir: path.join(tmp, 'server'), token: TOKEN, gcGraceMs: 0, log: { log() {}, error: console.error } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SERVER = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const base = path.join(tmp, 'A');
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });
const cfg = () => {
  saveConfig({ ...(loadConfig({ required: false }).raw), server: SERVER, token: TOKEN, home, roots: { 'claude-projects': path.join(base, 'projects'), 'desktop-sessions': path.join(base, 'sessions'), 'claude-file-history': false, 'claude-todos': false, 'claude-plans': false, 'claude-history': false } });
  return loadConfig();
};
const key = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const chat = (id, title, cwd) => {
  write(path.join(base, 'sessions', 'org', 'acct', `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: `cli${id}`, title, cwd }));
  write(path.join(base, 'projects', key(cwd), `cli${id}.jsonl`), JSON.stringify({ cwd, message: 'hallo' }) + '\n');
};
const cwdOf = (id) => JSON.parse(fs.readFileSync(path.join(base, 'sessions', 'org', 'acct', `local_${id}.json`), 'utf8')).cwd;

const GONE1 = path.join(tmp, 'weg', 'Aegis');
const GONE2 = path.join(tmp, 'weg', 'Scratch');
chat('a', 'Aegis Web', GONE1);
chat('b', 'Ragnarok', GONE1);
chat('c', 'Talesweaver', GONE2);
chat('d', 'Da', home);

test('Chats ohne Ordner: je Ordner mit den Chats, die ihn brauchen', async () => {
  const r = await folders(cfg(), {}, quiet);
  assert.deepEqual(r.missing.map((e) => [e.cwd, e.chats.map((c) => c.title).sort()]), [[GONE1, ['Aegis Web', 'Ragnarok']], [GONE2, ['Talesweaver']]]);
  assert.ok(r.missing.every((e) => e.creatable));
  await assert.rejects(folders(cfg(), { mkdir: true, args: [path.join(tmp, 'irgendwas')] }, quiet), /kein fehlender Ordner/);
});

test('Ordner anlegen: sofort vorhanden, Chat unveraendert', async () => {
  await folders(cfg(), { mkdir: true, args: ['Talesweaver'] }, quiet);
  assert.ok(fs.existsSync(GONE2));
  assert.equal(cwdOf('c'), GONE2);
  assert.deepEqual((await folders(cfg(), {}, quiet)).missing.map((e) => e.cwd), [GONE1]);
});

test('Umstellen auf ein vorhandenes Repo: Trockenlauf aendert nichts, danach zeigen beide Chats dorthin und das Repo steht in den Verweisen', async () => {
  const REMOTE = path.join(tmp, 'atlas.git');
  g(tmp, 'init', '--bare', REMOTE);
  const ATLAS = path.join(tmp, 'Forjego', 'roguard-atlas');
  g(tmp, 'clone', REMOTE, ATLAS);
  await push(cfg(), {}, quiet); // Server kennt die Verweise

  const dry = await folders(cfg(), { set: true, args: [GONE1, ATLAS], dryRun: true }, quiet);
  assert.equal(dry.set, false);
  assert.equal(cwdOf('a'), GONE1, 'Trockenlauf aendert nichts');
  await assert.rejects(folders(cfg(), { set: true, args: [GONE1, ATLAS], noAsk: true }, quiet), /--yes/);

  const r = await folders(cfg(), { set: true, args: ['Ragnarok', ATLAS], yes: true }, quiet);
  assert.equal(r.needsRestart, true);
  assert.equal(cwdOf('a'), ATLAS);
  assert.equal(cwdOf('b'), ATLAS);
  assert.ok(fs.existsSync(path.join(base, 'projects', key(ATLAS), 'clia.jsonl')), 'Verlauf mit umgezogen');
  assert.equal(Object.values(cfg().pathMap).includes(ATLAS), true, 'Zuordnung gespeichert');
  assert.deepEqual((await folders(cfg(), {}, quiet)).missing, []);
  const refs = await new Client(SERVER, TOKEN).getRefs();
  assert.equal(refs.chats.local_a.repo, remoteKey(REMOTE), 'Repo gleich in die Verweise eingetragen');
});
