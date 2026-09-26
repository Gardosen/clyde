// Umbenennen von Chats und Gruppen ueber mehrere PCs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLYDE_QUIET = '1';
process.env.CLYDE_SKIP_GUARD = '1';
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_CODE_HOST_SESSION_ID;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-renames-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');

const { createServer } = await import('../server/server.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { push, pull } = await import('../src/commands.js');
const { groups } = await import('../src/commands-misc.js');
const { mergeEntry } = await import('../src/merge.js');
const { Client } = await import('../src/client.js');

const TOKEN = 'renames-token';
const server = createServer({ dataDir: path.join(tmp, 'server'), token: TOKEN, gcGraceMs: 0, log: { log() {}, error: console.error } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SERVER = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const collect = () => { const out = []; return { out, log: { info: (s) => out.push(s), warn: (s) => out.push(`WARN ${s}`), debug() {}, error() {} } }; };
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
function pc(name) {
  const base = path.join(tmp, name);
  fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
  const cfg = () => {
    process.env.CLYDE_HOME = path.join(base, '.clyde');
    saveConfig({
      server: SERVER, token: TOKEN, home: path.join(tmp, `home-${name}`),
      roots: { 'claude-projects': path.join(base, 'projects'), 'desktop-sessions': path.join(base, 'sessions'), 'claude-file-history': false, 'claude-todos': false, 'claude-plans': false, 'claude-history': false },
    });
    return loadConfig();
  };
  const entryPath = (id) => path.join(base, 'sessions', 'org', 'acct', `local_${id}.json`);
  return {
    base, cfg,
    entry: (id, obj, mtime) => { write(entryPath(id), JSON.stringify(obj)); if (mtime) fs.utimesSync(entryPath(id), new Date(mtime), new Date(mtime)); },
    read: (id) => JSON.parse(fs.readFileSync(entryPath(id), 'utf8')),
    groupsConfig: (groupsList, assignments) => write(path.join(base, 'claude_desktop_config.json'), JSON.stringify({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': { 'org/acct': { groups: groupsList, assignments, order: {} } } } } })),
  };
}
const latest = () => new Client(SERVER, TOKEN).getSnapshot('latest');

test('mergeEntry: Umbenennen auf einer Seite, anderes Feld auf der anderen - beides bleibt', () => {
  const base = Buffer.from(JSON.stringify({ title: 'Alt', titleSource: 'auto', previousTitles: [], isStarred: false, lastFocusedAt: 1 }));
  const a = Buffer.from(JSON.stringify({ title: 'Neu', titleSource: 'user', previousTitles: ['Alt'], isStarred: false, lastFocusedAt: 1 }));
  const b = Buffer.from(JSON.stringify({ title: 'Alt', titleSource: 'auto', previousTitles: [], isStarred: true, lastFocusedAt: 5 }));
  for (const [newer, older] of [[a, b], [b, a]]) {
    const m = JSON.parse(mergeEntry(newer, older, base).toString());
    assert.deepEqual([m.title, m.titleSource, m.previousTitles, m.isStarred, m.lastFocusedAt], ['Neu', 'user', ['Alt'], true, 5]);
  }
  const both = Buffer.from(JSON.stringify({ title: 'Anders', titleSource: 'user', previousTitles: ['Alt'], isStarred: false, lastFocusedAt: 1 }));
  assert.equal(JSON.parse(mergeEntry(both, a, base).toString()).title, 'Anders', 'beide umbenannt: die neuere Fassung gilt');
  assert.equal(JSON.parse(mergeEntry(a, b, null).toString()).title, 'Neu', 'ohne Basis: die neuere Fassung gilt');
  assert.equal(mergeEntry(Buffer.from('kaputt'), a, base), null);
});

test('Chat umbenannt auf A, auf B nur geoeffnet: beides kommt an, B uebernimmt den Titel in der App', async () => {
  const A = pc('A');
  const B = pc('B');
  const T0 = Date.parse('2026-09-26T10:00:00Z');
  A.entry('r1', { sessionId: 'local_r1', title: 'Alt', titleSource: 'auto', previousTitles: [], lastFocusedAt: 1, cwd: tmp }, T0);
  await push(A.cfg(), {}, quiet);
  await pull(B.cfg(), { noAsk: true }, quiet);
  await groups(B.cfg(), { done: true }, quiet);

  B.entry('r1', { ...B.read('r1'), lastFocusedAt: 2 }, T0 + 1000); // nur angeklickt
  await push(B.cfg(), {}, quiet);
  A.entry('r1', { ...A.read('r1'), title: 'Neu', titleSource: 'user', previousTitles: ['Alt'] }, T0 + 2000);
  await push(A.cfg(), {}, quiet);

  const snap = await latest();
  const f = snap.roots['desktop-sessions'].files.find((x) => x.p.endsWith('local_r1.json'));
  const parts = new Map();
  await new Client(SERVER, TOKEN).fetchBlobs(f.c, async ({ hash, data }) => { parts.set(hash, data); });
  const shared = JSON.parse(Buffer.concat(f.c.map((h) => parts.get(h))).toString());
  assert.equal(shared.title, 'Neu', 'Umbenennung von A');
  assert.equal(shared.lastFocusedAt, 2, 'Aenderung von B');

  await pull(B.cfg(), { noAsk: true }, quiet);
  assert.equal(B.read('r1').title, 'Neu');
  const r = await groups(B.cfg(), {}, quiet);
  assert.deepEqual(r.retitle, [{ id: 'local_r1', title: 'Neu' }], 'B setzt den Titel in der laufenden App');
  await groups(B.cfg(), { done: true }, quiet);
  assert.deepEqual((await groups(B.cfg(), {}, quiet)).retitle, [], 'nach dem Abgleich nichts mehr zu tun');
});

test('Gruppe umbenannt: Push bringt es ein, der andere PC benennt seine Gruppe um statt eine neue anzulegen', async () => {
  const A = pc('GA');
  const B = pc('GB');
  A.entry('g1', { sessionId: 'local_g1', title: 'Chat g1', cwd: tmp });
  A.groupsConfig([{ id: 'a-1', name: 'Archiv' }], { 'code:local_g1': 'a-1' });
  await push(A.cfg(), {}, quiet);

  // B holt und legt die Gruppe (wie /clyde:groups) mit eigener ID an
  await pull(B.cfg(), { noAsk: true }, quiet);
  B.groupsConfig([{ id: 'b-7', name: 'Archiv' }], { 'code:local_g1': 'b-7' });
  await groups(B.cfg(), { done: true }, quiet);
  await push(B.cfg(), {}, quiet);
  assert.deepEqual((await latest()).appGroups.scopes['org/acct'].groups.map((g) => g.name), ['Archiv'], 'keine doppelte Gruppe');

  // A benennt um; sonst aendert sich nichts - der Push muss trotzdem einen Stand anlegen
  A.groupsConfig([{ id: 'a-1', name: 'Archiv alt' }], { 'code:local_g1': 'a-1' });
  const p = collect();
  const res = await push(A.cfg(), {}, p.log);
  assert.ok(!res.unchanged, 'Umbenennen allein ist eine Aenderung');
  assert.ok(p.out.some((l) => l.includes('Gruppe umbenannt') && l.includes('Archiv alt')), p.out.join('\n'));
  assert.deepEqual((await latest()).appGroups.scopes['org/acct'].groups.map((g) => g.name), ['Archiv alt']);

  await pull(B.cfg(), { noAsk: true }, quiet);
  const r = await groups(B.cfg(), {}, quiet);
  assert.deepEqual(r.renames, [{ groupId: 'b-7', from: 'Archiv', to: 'Archiv alt' }]);
  assert.equal(r.groups.find((g) => g.name === 'Archiv alt').groupId, 'b-7', 'Ziel ist die vorhandene Gruppe');

  // B hat umbenannt (App schreibt die Einstellungen), Abgleich abgeschlossen
  B.groupsConfig([{ id: 'b-7', name: 'Archiv alt' }], { 'code:local_g1': 'b-7' });
  await groups(B.cfg(), { done: true }, quiet);
  assert.deepEqual((await groups(B.cfg(), {}, quiet)).renames, []);
  const again = await push(B.cfg(), {}, quiet);
  assert.equal(again.unchanged, true, 'B dreht die Umbenennung nicht zurueck');
});

test('Gruppe gleichzeitig auf zwei PCs umbenannt: der gemeinsame Stand gilt, der andere PC folgt', async () => {
  const A = pc('GA');
  const B = pc('GB');
  A.groupsConfig([{ id: 'a-1', name: 'Von A' }], { 'code:local_g1': 'a-1' });
  B.groupsConfig([{ id: 'b-7', name: 'Von B' }], { 'code:local_g1': 'b-7' });
  await push(A.cfg(), {}, quiet);
  await push(B.cfg(), {}, quiet);
  assert.deepEqual((await latest()).appGroups.scopes['org/acct'].groups.map((g) => g.name), ['Von A'], 'erster Push gilt');
  const r = await groups(B.cfg(), {}, quiet);
  assert.deepEqual(r.renames, [{ groupId: 'b-7', from: 'Von B', to: 'Von A' }]);
});
