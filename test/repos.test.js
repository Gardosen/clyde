// Verweise: welches Repo zu welchem Chat gehoert und wo es je Geraet liegt
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
const { sanitizeRemote, remoteKey, allowedRemote } = await import('../src/repos.js');
const { refs, repos } = await import('../src/commands-misc.js');
const { device } = await import('../src/refs.js');
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
write(path.join(A.base, 'sessions', 'local_a.json'), JSON.stringify({ sessionId: 'local_a', cwd: path.join(PA, 'src'), title: 'Projekt' }));
write(path.join(A.base, 'projects', 'p', 'chat.jsonl'), '{"a":1}\n');


// Ein zweites Repo, das nur unter einem Ordner liegt, in dem kein Chat arbeitet
// (darf nie auftauchen: kein Scannen)
const TOOLREMOTE = path.join(tmp, 'tool.git');
g(tmp, 'init', '--bare', TOOLREMOTE);
g(tmp, 'clone', TOOLREMOTE, path.join(A.home, 'tool'));
const refsOf = () => new Client(SERVER, TOKEN).getRefs();
const devOf = (P) => device(P.cfg()).id;
const KEY = remoteKey(REMOTE);

test('Remote-Adressen: Zugangsdaten raus, gleiche Repos erkennen, Gefaehrliches ablehnen', () => {
  assert.equal(sanitizeRemote('https://user:geheim@github.com/x/y.git'), 'https://github.com/x/y.git');
  assert.equal(sanitizeRemote('ssh://git:pw@forge.example:222/x/y.git'), 'ssh://git@forge.example:222/x/y.git');
  assert.equal(remoteKey('git@github.com:Gardosen/clyde.git'), remoteKey('https://github.com/Gardosen/clyde'));
  for (const bad of ['', '--upload-pack=touch x', 'ext::sh -c touch% x', 'fd::17']) assert.equal(allowedRemote(bad), false, bad);
  for (const ok of ['https://github.com/x/y.git', 'git@github.com:x/y.git', REMOTE]) assert.equal(allowedRemote(ok), true, ok);
});

test('Push merkt je Chat sein Repo und wo es auf diesem Geraet liegt, ohne Ordner zu durchsuchen', async () => {
  await push(A.cfg(), {}, quiet);
  const r = await refsOf();
  const da = devOf(A);
  assert.deepEqual(Object.keys(r.repos), [KEY], 'nur das Repo, in dem ein Chat arbeitet (tool bleibt aussen vor)');
  assert.deepEqual({ repo: r.chats.local_a.repo, sub: r.chats.local_a.sub }, { repo: KEY, sub: 'src' });
  assert.equal(r.repos[KEY].locations[da].path, PA);
  assert.equal(r.repos[KEY].locations[da].status, 'ok');
  assert.equal(r.repos[KEY].branch, 'main');
  assert.ok(r.repos[KEY].root.startsWith('@@CLYDE_HOME_'), 'neutraler Ort fuer den Vorschlag auf anderen PCs');
  assert.equal(r.devices[da].home, A.home);
  const snap = await new Client(SERVER, TOKEN).getSnapshot('latest');
  assert.equal(snap.refsRev, r.rev, 'der Stand verweist auf die Revision der Verweise');
  assert.equal(snap.repos, undefined, 'keine Repo-Liste mehr im Stand');
});

test('Pull auf einem neuen PC: Repo wird angeboten (nicht als fehlender Ordner), klonen traegt den Ort ein', async () => {
  const B = pc('B');
  const dry = collect();
  await pull(B.cfg(), { noAsk: true, dryRun: true }, dry.log);
  assert.ok(dry.out.some((l) => l.startsWith('WARN') && l.includes('ist hier nicht eingetragen') && l.includes('clyde refs --clone proj')), dry.out.join('\n'));
  assert.ok(!dry.out.some((l) => l.includes('gibt es hier nicht')), 'der Projektordner im Repo wird nicht einzeln erfragt');
  const pend = await refs(B.cfg(), { pending: true }, quiet);
  assert.equal(pend.problems.length, 1);
  assert.equal(pend.problems[0].suggested, path.join(B.home, 'proj'), 'Vorschlag: wie auf dem Quell-PC');
  assert.deepEqual(pend.problems[0].chats, ['Projekt']);

  await refs(B.cfg(), { clone: true, args: ['proj'] }, quiet);
  const PB = path.join(B.home, 'proj');
  assert.equal(read(path.join(PB, 'README.md')), 'eins\n');
  assert.equal((await refsOf()).repos[KEY].locations[devOf(B)].path, PB, 'sofort hochgeladen');
  await pull(B.cfg(), { noAsk: true }, quiet);
  assert.equal(JSON.parse(fs.readFileSync(path.join(B.base, 'sessions', 'local_a.json'), 'utf8')).cwd, path.join(PB, 'src'));

  // neuer Commit auf A: B spult beim naechsten Pull vor
  write(path.join(PA, 'README.md'), 'zwei\n');
  g(PA, 'commit', '-am', 'zwei');
  g(PA, 'push');
  const p2 = collect();
  await pull(B.cfg(), { noAsk: true }, p2.log);
  assert.equal(read(path.join(PB, 'README.md')), 'zwei\n');
  assert.ok(p2.out.some((l) => l.includes('1 vorgespult')), p2.out.join('\n'));
});

test('Liegt schon hier: --set prueft den Pfad, traegt ihn ein und stellt die Chats darauf um', async () => {
  const C = pc('C');
  const elsewhere = path.join(tmp, 'woanders', 'meinproj');
  g(tmp, 'clone', REMOTE, elsewhere);
  await assert.rejects(refs(C.cfg(), { set: true, args: ['proj', path.join(tmp, 'gibtsnicht')] }, quiet), /gibt es nicht/);
  await assert.rejects(refs(C.cfg(), { set: true, args: ['proj', path.join(A.home, 'tool')] }, quiet), /anderes Repo/);
  await assert.rejects(refs(C.cfg(), { set: true, args: ['unbekannt', elsewhere] }, quiet), /nicht bekannt/);
  await refs(C.cfg(), { set: true, args: ['proj', elsewhere] }, quiet);
  const cfg = C.cfg();
  assert.equal(Object.values(cfg.pathMap)[0], elsewhere, 'Zuordnung fuer die Chats des Repos');
  await pull(cfg, { noAsk: true }, quiet);
  assert.equal(JSON.parse(fs.readFileSync(path.join(C.base, 'sessions', 'local_a.json'), 'utf8')).cwd, path.join(elsewhere, 'src'));
  assert.equal((await refs(C.cfg(), { pending: true }, quiet)).problems.length, 0, 'nicht erneut gefragt');
});

test('Im Dashboard geaenderte Pfade: ungeprueft, der Push des Geraets bestaetigt, korrigiert oder beanstandet sofort', async () => {
  const c = new Client(SERVER, TOKEN);
  const setFor = async (dev, p) => { const r = await c.getRefs(); r.repos[KEY].locations[dev] = { device: 'x', path: p, status: 'unverified', by: 'dashboard', at: 'x' }; return c.putRefs(r); };
  // B arbeitet mit einem Chat im Repo: ein falscher Pfad aus dem Dashboard wird korrigiert
  const B = pc('B');
  await setFor(devOf(B), path.join(tmp, 'falsch'));
  const stale = await c.getRefs();
  await setFor(devOf(B), path.join(tmp, 'falsch2'));
  await assert.rejects(c.putRefs(stale), (e) => e.code === 'REFS_CONFLICT', 'alte Revision: Konflikt statt Ueberschreiben');
  await push(B.cfg(), {}, quiet);
  let r = await c.getRefs();
  assert.deepEqual([r.repos[KEY].locations[devOf(B)].path, r.repos[KEY].locations[devOf(B)].status], [path.join(B.home, 'proj'), 'ok'], 'vom Geraet korrigiert');

  // F kennt den Ort nur aus dem Dashboard
  const F = pc('F');
  const df = devOf(F);
  await setFor(df, path.join(tmp, 'falsch'));
  const w = collect();
  await push(F.cfg(), {}, w.log);
  r = await c.getRefs();
  assert.equal(r.repos[KEY].locations[df].status, 'missing', 'beanstandet und hochgeladen');
  assert.ok(w.out.some((l) => l.startsWith('WARN') && l.includes('fehlt hier')), w.out.join(' | '));
  const fp = path.join(tmp, 'F-proj');
  g(tmp, 'clone', REMOTE, fp);
  await setFor(df, fp);
  await push(F.cfg(), {}, quiet);
  r = await c.getRefs();
  assert.equal(r.repos[KEY].locations[df].status, 'ok', 'bestaetigt');
  assert.equal(r.repos[KEY].locations[df].by, 'dashboard');
});

test('Ueberspringen, von Hand zuordnen, Vergessenes pruefen; Scannen gibt es nicht mehr', async () => {
  const D = pc('D');
  await refs(D.cfg(), { skip: true, args: ['proj'] }, quiet);
  assert.equal((await refs(D.cfg(), { pending: true }, quiet)).problems.length, 0, 'uebersprungen: keine Frage mehr');

  write(path.join(A.base, 'sessions', 'local_n.json'), JSON.stringify({ cwd: A.home, title: 'Notizen' }));
  await refs(A.cfg(), { link: true, args: ['Notizen', 'proj'] }, quiet);
  assert.equal((await refsOf()).chats.local_n.repo, KEY);
  await refs(A.cfg(), { unlink: true, args: ['Notizen'] }, quiet);
  assert.equal((await refsOf()).chats.local_n, undefined);

  await assert.rejects(repos(A.cfg(), { scan: true }, quiet), /durchsucht keine Ordner/);
  write(path.join(PA, 'neu.txt'), 'neu\n');
  const chk = await push(A.cfg(), { check: true }, quiet);
  assert.deepEqual(chk.items.map((i) => [i.name, i.untracked]), [['proj', 1]], 'nur Repos von Chats');
  assert.deepEqual(chk.refs, []);
  await repos(A.cfg(), { commit: PA, message: 'Nachgereicht' }, quiet);
  assert.equal(g(REMOTE, 'log', '-1', '--format=%s', 'main'), 'Nachgereicht');
});

test('Klonen nur von erlaubten Remotes', async () => {
  const c = new Client(SERVER, TOKEN);
  const r = await c.getRefs();
  r.repos['boese/x'] = { remote: '--upload-pack=touch pwned', name: 'boese', locations: {} };
  await c.putRefs(r);
  await assert.rejects(refs(pc('E').cfg(), { clone: true, args: ['boese'] }, quiet), /nicht erlaubt/);
});

test('Dashboard: je Chat und Geraet Projektordner, Repo und Stand des Verweises', async () => {
  const chats = await new Client(SERVER, TOKEN).json('GET', '/snapshots/latest/chats');
  const c = chats.chats.find((x) => x.sessionId === 'local_a' || (x.file || '').endsWith('local_a.json'));
  const byDev = Object.fromEntries(c.places.map((p) => [p.deviceId, p]));
  const pa = byDev[devOf(A)];
  assert.equal(pa.repo.name, 'proj');
  assert.equal(pa.repo.path, PA);
  assert.equal(pa.cwd, path.join(PA, 'src'), 'Projektordner = Repo-Ort + Unterordner');
  const pd = byDev[devOf(pc('D'))];
  assert.equal(pd.repo.status, 'skipped');
});
