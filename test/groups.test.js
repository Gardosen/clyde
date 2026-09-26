// Gruppen der Chatliste: Soll-Zustand fuer einen anderen PC und Zusammenfuehren nach Namen
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLYDE_QUIET = '1';
process.env.CLYDE_SKIP_GUARD = '1';
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_CODE_HOST_SESSION_ID;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-groups-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');

const { createServer } = await import('../server/server.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { push, pull } = await import('../src/commands.js');
const { groups } = await import('../src/commands-misc.js');
const { mergeAppGroups } = await import('../src/sync.js');
const { Client } = await import('../src/client.js');

const TOKEN = 'groups-token';
const server = createServer({ dataDir: path.join(tmp, 'server'), token: TOKEN, gcGraceMs: 0, log: { log() {}, error: console.error } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SERVER = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
function pc(name) {
  const base = path.join(tmp, name);
  fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
  return {
    base,
    cfg: () => {
      process.env.CLYDE_HOME = path.join(base, '.clyde');
      saveConfig({
        server: SERVER, token: TOKEN, home: path.join(tmp, `home-${name}`),
        roots: { 'claude-projects': path.join(base, 'projects'), 'desktop-sessions': path.join(base, 'sessions'), 'claude-file-history': false, 'claude-todos': false, 'claude-plans': false, 'claude-history': false },
      });
      return loadConfig();
    },
  };
}
const appConfig = (scopes, starred = []) => JSON.stringify({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': scopes, 'starred-local-code-sessions': starred }, other: 'geheim' } });

test('Gruppen: anderer PC bekommt den Soll-Zustand nur fuer Chats, die er hat', async () => {
  const A = pc('A');
  for (const id of ['a', 'b', 'c', 'd']) write(path.join(A.base, 'sessions', 'org', 'acct', `local_${id}.json`), JSON.stringify({ title: `Chat ${id}`, cwd: tmp }));
  write(path.join(A.base, 'claude_desktop_config.json'), appConfig({
    'org/acct': {
      groups: [{ id: 'g1', name: 'Archiv' }, { id: 'g2', name: 'Web' }],
      assignments: { 'code:local_b': 'g1', 'code:local_a': 'g1', 'code:local_c': 'g2' },
      order: { g1: ['code:local_a', 'code:local_b'] },
    },
  }, ['local_d']));
  await push(A.cfg(), {}, quiet);

  const M = pc('Mac');
  await pull(M.cfg(), { noAsk: true }, quiet);
  fs.rmSync(path.join(M.base, 'sessions', 'org', 'acct', 'local_c.json')); // diesen Chat gibt es hier nicht
  const r = await groups(M.cfg(), {}, quiet);
  assert.deepEqual(r.groups, [{ name: 'Archiv', sessions: ['local_a', 'local_b'] }], 'Reihenfolge wie in der Seitenleiste, nur vorhandene Chats');
  assert.deepEqual(r.pin, ['local_d'], 'ohne isStarred im Eintrag gilt die Liste der App-Einstellungen');
  assert.deepEqual(r.unpin, []);
  assert.equal(r.titles.local_a, 'Chat a');
});

test('Gruppen: gleichnamige Gruppe eines anderen PCs wird keine zweite Gruppe', () => {
  const shared = { scopes: { s: { groups: [{ id: 'g1', name: 'Archiv' }], assignments: { 'code:local_a': 'g1' }, order: {} } }, starred: [] };
  const mac = { scopes: { s: { groups: [{ id: 'mac-7', name: 'archiv ' }, { id: 'mac-8', name: 'Neu' }], assignments: { 'code:local_b': 'mac-7', 'code:local_c': 'mac-8' }, order: { 'mac-7': ['code:local_b'] } } }, starred: ['local_b'] };
  const m = mergeAppGroups(shared, mac).scopes.s;
  assert.deepEqual(m.groups.map((g) => g.name), ['Archiv', 'Neu']);
  assert.deepEqual(m.assignments, { 'code:local_a': 'g1', 'code:local_b': 'g1', 'code:local_c': 'mac-8' });
  assert.deepEqual(m.order.g1, ['code:local_b']);
});

test('Gruppen: Push vom Mac nach /clyde:groups erzeugt keine doppelten Gruppen im Stand', async () => {
  const M = pc('Mac');
  write(path.join(M.base, 'claude_desktop_config.json'), appConfig({
    'org/acct': { groups: [{ id: 'mac-1', name: 'Archiv' }], assignments: { 'code:local_a': 'mac-1', 'code:local_b': 'mac-1' }, order: {} },
  }));
  write(path.join(M.base, 'sessions', 'org', 'acct', 'local_e.json'), JSON.stringify({ title: 'neu auf dem Mac', cwd: tmp }));
  await push(M.cfg(), {}, quiet);
  const snap = await new Client(SERVER, TOKEN).getSnapshot('latest');
  const s = snap.appGroups.scopes['org/acct'];
  assert.deepEqual(s.groups.map((g) => g.name).sort(), ['Archiv', 'Web']);
  assert.equal(s.assignments['code:local_b'], 'g1');
  assert.ok(!JSON.stringify(snap).includes('geheim'), 'nichts ausser den Gruppen aus der Einstellungsdatei');
});

test('Anheften: isStarred im Chat-Eintrag zaehlt; Loesen nur, wenn der Pull es mitgebracht hat', async () => {
  const A = pc('A');
  const M = pc('Mac');
  const entry = (base, id, starred) => write(path.join(base, 'sessions', 'org', 'acct', `local_${id}.json`), JSON.stringify({ title: `Chat ${id}`, cwd: tmp, isStarred: starred }));
  entry(A.base, 'p1', true);
  entry(A.base, 'p2', false);
  await push(A.cfg(), {}, quiet);
  await pull(M.cfg(), { noAsk: true }, quiet);
  let r = await groups(M.cfg(), {}, quiet);
  assert.ok(r.pin.includes('local_p1') && !r.pin.includes('local_p2'), JSON.stringify(r.pin));
  assert.deepEqual(r.unpin, [], 'neue Chats liest die App beim Start selbst richtig ein');

  // auf PC A: p1 geloest, p2 angeheftet
  entry(A.base, 'p1', false);
  entry(A.base, 'p2', true);
  await push(A.cfg(), {}, quiet);
  await pull(M.cfg(), { noAsk: true }, quiet);
  r = await groups(M.cfg(), {}, quiet);
  assert.ok(r.pin.includes('local_p2') && !r.pin.includes('local_p1'), JSON.stringify(r.pin));
  assert.deepEqual(r.unpin, ['local_p1'], 'geloest auf dem anderen PC');
  assert.equal(r.titles.local_p1, 'Chat p1');

  // hier wieder angeheftet (die App schreibt isStarred): nicht erneut loesen
  entry(M.base, 'p1', true);
  r = await groups(M.cfg(), {}, quiet);
  assert.deepEqual(r.unpin, []);
});
