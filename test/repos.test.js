// Git-Repos der Projektordner: Push vermerkt sie, Pull klont oder spult vor
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-repos-'));
process.env.CLYDE_HOME = path.join(tmp, 'clydehome');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');

const { createServer } = await import('../server/server.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { push, pull } = await import('../src/commands.js');
const { sanitizeRemote, remoteKey, allowedRemote, planRepos } = await import('../src/repos.js');
const { Client } = await import('../src/client.js');

const TOKEN = 'repos-token';
const server = createServer({ dataDir: path.join(tmp, 'server'), token: TOKEN, gcGraceMs: 0, log: { log() {}, error: console.error } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SERVER = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const collect = () => { const out = []; return { out, log: { info: (s) => out.push(s), warn: (s) => out.push(`WARN ${s}`), debug() {}, error() {} } }; };
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const read = (p) => fs.readFileSync(p, 'utf8').split(String.fromCharCode(13)).join(''); // autocrlf egal
const rootsFor = (base) => ({
  'claude-projects': path.join(base, 'projects'),
  'desktop-sessions': path.join(base, 'sessions'),
  'claude-history': { path: path.join(base, 'history.jsonl'), kind: 'file' },
  'claude-file-history': false, 'claude-todos': false, 'claude-plans': false,
});
function pc(name) {
  const base = path.join(tmp, name);
  fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
  const home = path.join(tmp, `home-${name}`);
  fs.mkdirSync(home, { recursive: true });
  // jeder PC mit eigenem ~/.clyde (Konfiguration, Cache, Basis, Auswahl)
  return {
    base, home, cfg: () => {
      process.env.CLYDE_HOME = path.join(base, '.clyde');
      const prev = loadConfig({ required: false }).raw;
      saveConfig({ ...prev, server: SERVER, token: TOKEN, roots: rootsFor(base), home, backupsToKeep: 2 });
      return loadConfig();
    },
  };
}

// Remote (bare) und Arbeitskopie auf PC A, Chat mit Projektordner im Repo
const REMOTE = path.join(tmp, 'remote.git');
g(tmp, 'init', '--bare', REMOTE);
const A = pc('A');
const PA = path.join(A.home, 'proj');
g(tmp, 'clone', REMOTE, PA);
write(path.join(PA, 'README.md'), 'eins\n');
write(path.join(PA, 'src', 'main.txt'), 'code\n');
g(PA, 'add', '.');
g(PA, 'commit', '-m', 'eins');
g(PA, 'push', '-u', 'origin', 'main');
write(path.join(A.base, 'sessions', 'local_a.json'), JSON.stringify({ cwd: path.join(PA, 'src'), title: 'Projekt' }));
write(path.join(A.base, 'projects', 'p', 'chat.jsonl'), '{"a":1}\n');

test('Remote-Adressen: Zugangsdaten raus, gleiche Repos erkennen, Gefaehrliches ablehnen', () => {
  assert.equal(sanitizeRemote('https://user:geheim@github.com/x/y.git'), 'https://github.com/x/y.git');
  assert.equal(sanitizeRemote('https://token@github.com/x/y.git'), 'https://github.com/x/y.git');
  assert.equal(sanitizeRemote('ssh://git:pw@forge.example:222/x/y.git'), 'ssh://git@forge.example:222/x/y.git');
  assert.equal(sanitizeRemote('git@github.com:x/y.git'), 'git@github.com:x/y.git');
  assert.equal(remoteKey('git@github.com:Gardosen/clyde.git'), remoteKey('https://github.com/Gardosen/clyde'));
  assert.notEqual(remoteKey('https://github.com/a/b'), remoteKey('https://github.com/a/c'));
  for (const bad of ['', '--upload-pack=touch x', 'ext::sh -c touch% x', 'fd::17', 'https://x/y\n--z']) assert.equal(allowedRemote(bad), false, bad);
  for (const ok of ['https://github.com/x/y.git', 'ssh://git@h:222/x.git', 'git@github.com:x/y.git', REMOTE]) assert.equal(allowedRemote(ok), true, ok);
});

test('Pull lehnt gefaehrliche Remotes aus einem Stand ab', async () => {
  const acts = await planRepos([
    { root: path.join(tmp, 'x1'), remote: '--upload-pack=touch pwned', branch: 'main' },
    { root: path.join(tmp, 'x2'), remote: 'ext::sh -c touch% pwned', branch: 'main' },
  ], { forms: [] });
  assert.deepEqual(acts.map((a) => a.action), ['skip', 'skip']);
  assert.ok(acts.every((a) => a.reason.includes('nicht erlaubt')));
});

test('Push vermerkt das Repo des Projektordners (neutraler Pfad, ohne Zugangsdaten)', async () => {
  await push(A.cfg(), {}, quiet);
  const snap = await new Client(SERVER, TOKEN).getSnapshot('latest');
  assert.equal(snap.repos.length, 1);
  const [r] = snap.repos;
  assert.ok(r.root.startsWith('@@CLYDE_HOME_'), r.root);
  assert.ok(r.root.endsWith('proj'), 'Repo-Wurzel, nicht der Unterordner des Chats');
  assert.equal(remoteKey(r.remote), remoteKey(REMOTE));
  assert.equal(r.branch, 'main');
  assert.equal(r.head, g(PA, 'rev-parse', 'HEAD'));
});

test('Pull auf einem neuen PC klont das Repo an den Projektordner', async () => {
  const B = pc('B');
  const { out, log } = collect();
  await pull(B.cfg(), { noAsk: true }, log);
  const PB = path.join(B.home, 'proj');
  assert.equal(read(path.join(PB, 'README.md')), 'eins\n');
  assert.equal(g(PB, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.ok(!out.some((l) => l.includes('gibt es hier nicht')), 'wird geklont, fehlt also nicht');
  assert.ok(out.some((l) => l.includes('1 geklont')), out.join('\n'));

  // neuer Commit auf A, auf den Remote gepusht: B spult beim naechsten Pull vor
  write(path.join(PA, 'README.md'), 'zwei\n');
  g(PA, 'commit', '-am', 'zwei');
  g(PA, 'push');
  const r2 = collect();
  await pull(B.cfg(), { noAsk: true }, r2.log);
  assert.equal(read(path.join(PB, 'README.md')), 'zwei\n');
  assert.ok(r2.out.some((l) => l.includes('1 vorgespult')), r2.out.join('\n'));

  // lokale Aenderung auf B: nicht anfassen, nur melden
  write(path.join(PB, 'README.md'), 'lokal\n');
  const before = g(PB, 'rev-parse', 'HEAD');
  write(path.join(PA, 'neu.txt'), 'drei\n');
  g(PA, 'add', '.');
  g(PA, 'commit', '-m', 'drei');
  g(PA, 'push');
  const r3 = collect();
  await pull(B.cfg(), { noAsk: true }, r3.log);
  assert.equal(read(path.join(PB, 'README.md')), 'lokal\n');
  assert.equal(g(PB, 'rev-parse', 'HEAD'), before);
  assert.ok(r3.out.some((l) => l.includes('uebersprungen') && l.includes('geaenderte Datei')), r3.out.join('\n'));
});

test('Push warnt vor Commits, die nicht auf dem Remote liegen', async () => {
  write(path.join(PA, 'vier.txt'), 'vier\n');
  g(PA, 'add', '.');
  g(PA, 'commit', '-m', 'vier');
  const { out, log } = collect();
  await push(A.cfg(), {}, log);
  assert.ok(out.some((l) => l.startsWith('WARN') && l.includes('1 Commit(s) nicht gepusht')), out.join('\n'));
  g(PA, 'push');
});

test('Vorhandener Ordner ohne Git bleibt unangetastet; Trockenlauf und --no-repos klonen nichts', async () => {
  const C = pc('C');
  write(path.join(C.home, 'proj', 'fremd.txt'), 'meins\n');
  const c = collect();
  await pull(C.cfg(), { noAsk: true }, c.log);
  assert.deepEqual(fs.readdirSync(path.join(C.home, 'proj')), ['fremd.txt'], 'nichts hineingeklont');
  assert.ok(c.out.some((l) => l.includes('ohne Git')), c.out.join('\n'));

  const D = pc('D');
  const d = collect();
  await pull(D.cfg(), { noAsk: true, dryRun: true }, d.log);
  assert.ok(d.out.some((l) => l.includes('wird geklont')), d.out.join('\n'));
  assert.ok(!fs.existsSync(path.join(D.home, 'proj')), 'Trockenlauf klont nicht');

  const E = pc('E');
  const e = collect();
  await pull(E.cfg(), { noAsk: true, noRepos: true }, e.log);
  assert.ok(!fs.existsSync(path.join(E.home, 'proj')));
  assert.ok(e.out.some((l) => l.includes('gibt es hier nicht')), 'ohne Repos wird der fehlende Ordner wie bisher gemeldet');
});

test('Eigene Auswahl: Repo unter einem Chat-Ordner finden, mitnehmen und wieder abwaehlen', async () => {
  const { repos } = await import('../src/commands-misc.js');
  // Chat arbeitet im Oberordner "work", das Repo "tool" liegt darunter
  const REMOTE2 = path.join(tmp, 'tool.git');
  g(tmp, 'init', '--bare', REMOTE2);
  const W = path.join(A.home, 'work');
  const TOOL = path.join(W, 'tool');
  g(tmp, 'clone', REMOTE2, TOOL);
  write(path.join(TOOL, 'tool.txt'), 'werkzeug\n');
  g(TOOL, 'add', '.');
  g(TOOL, 'commit', '-m', 'tool');
  g(TOOL, 'push', '-u', 'origin', 'main');
  write(path.join(W, 'notizen.txt'), 'kein Repo\n');
  write(path.join(A.base, 'sessions', 'local_w.json'), JSON.stringify({ cwd: W, title: 'Oberordner' }));

  const scan = await repos(A.cfg(), { scan: true }, quiet);
  const hit = scan.found.find((r) => r.root.endsWith('tool'));
  assert.ok(hit && !hit.viaChat && !hit.selected, 'Kandidat unter dem Chat-Ordner, noch nicht ausgewaehlt');
  await push(A.cfg(), {}, quiet);
  let snap = await new Client(SERVER, TOKEN).getSnapshot('latest');
  assert.ok(!snap.repos.some((r) => r.root.endsWith('tool')), 'ohne Auswahl nicht im Stand');

  await assert.rejects(repos(A.cfg(), { add: true, args: [W] }, quiet), /kein Git-Repo/);
  await repos(A.cfg(), { add: true, args: [TOOL] }, quiet);
  assert.equal((await repos(A.cfg(), { scan: true }, quiet)).found.find((r) => r.root.endsWith('tool')).selected, true);
  await push(A.cfg(), {}, quiet);
  snap = await new Client(SERVER, TOKEN).getSnapshot('latest');
  assert.ok(snap.repos.some((r) => r.root.endsWith('tool')), 'ausgewaehlt: im Stand');

  const F = pc('F');
  await pull(F.cfg(), { noAsk: true }, quiet);
  assert.equal(read(path.join(F.home, 'work', 'tool', 'tool.txt')), 'werkzeug\n', 'anderer PC klont es');

  await repos(A.cfg(), { remove: TOOL }, quiet);
  assert.deepEqual(loadConfig().raw.dropRepos.length, 1);
  await push(A.cfg(), {}, quiet);
  snap = await new Client(SERVER, TOKEN).getSnapshot('latest');
  assert.ok(!snap.repos.some((r) => r.root.endsWith('tool')), 'abgewaehlt: aus dem Stand');
  assert.equal((loadConfig().raw.dropRepos || []).length, 0, 'Abwahl erledigt');
  assert.ok(fs.existsSync(path.join(F.home, 'work', 'tool', 'tool.txt')), 'vorhandener Klon bleibt');
});
