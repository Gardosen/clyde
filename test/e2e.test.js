import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

process.env.CLYDE_QUIET = '1';
process.env.CLYDE_SKIP_GUARD = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-e2e-'));
process.env.CLYDE_HOME = path.join(tmp, 'clydehome');

const { createServer } = await import('../server/server.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { push, pull } = await import('../src/commands.js');
const { map } = await import('../src/commands-misc.js');
const { pathVariants } = await import('../src/rewrite.js');
const { Client } = await import('../src/client.js');
const { log } = await import('../src/log.js');

const TOKEN = 'test-token';
const server = createServer({ dataDir: path.join(tmp, 'server'), token: TOKEN, gcGraceMs: 0, log: { log() {}, error: console.error } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SERVER = `http://127.0.0.1:${server.address().port}`;
// Zweites Konto fuer die Tests mit anderem Benutzer und Laufwerk
const server2 = createServer({ dataDir: path.join(tmp, 'server2'), token: TOKEN, gcGraceMs: 0, log: { log() {}, error: console.error } });
await new Promise((r) => server2.listen(0, '127.0.0.1', r));
const SERVER2 = `http://127.0.0.1:${server2.address().port}`;
after(() => { server.close(); server2.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const A = path.join(tmp, 'A');
const B = path.join(tmp, 'B');
const MEM = path.join(tmp, 'memory');
const MB = 1024 * 1024;

const rootsFor = (base) => ({
  'claude-projects': path.join(base, 'projects'),
  'desktop-sessions': path.join(base, 'sessions'),
  'claude-history': { path: path.join(base, 'history.jsonl'), kind: 'file' },
  'claude-file-history': false, 'claude-todos': false, 'claude-plans': false,
});
function useRoots(base, token = TOKEN, home = undefined, projectDrive = undefined, srv = SERVER) {
  saveConfig({ server: srv, token, backupsToKeep: 2, roots: rootsFor(base), home, projectDrive });
  return loadConfig();
}
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const read = (p) => fs.readFileSync(p, 'utf8');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
function tree(dir, rel = '') {
  const out = [];
  const abs = rel ? path.join(dir, rel) : dir;
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const st = fs.statSync(path.join(abs, e.name));
    if (st.isDirectory()) out.push(...tree(dir, r));
    else out.push([r, sha(fs.readFileSync(path.join(abs, e.name))), st.size]);
  }
  return out;
}
const treeOf = (base) => [
  ...tree(path.join(base, 'projects')).map(([r, h, s]) => [`projects/${r}`, h, s]),
  ...tree(path.join(base, 'sessions')).map(([r, h, s]) => [`sessions/${r}`, h, s]),
  ...(fs.existsSync(path.join(base, 'history.jsonl')) ? [['history.jsonl', sha(fs.readFileSync(path.join(base, 'history.jsonl')))]] : []),
];

// Zustand von PC A (gleiches Benutzerkonto wie der Testlauf)
write(path.join(A, 'projects', 'proj1', 'big.jsonl'), randomBytes(9.5 * MB));
write(path.join(A, 'projects', 'proj1', 'small.json'), '{"a":1}');
write(path.join(A, 'projects', 'proj1', 'sub', 'deep', 'tool.txt'), 'tool');
write(path.join(A, 'projects', 'empty.txt'), '');
write(path.join(MEM, 'MEMORY.md'), '# memory');
fs.symlinkSync(MEM, path.join(A, 'projects', 'memory'), process.platform === 'win32' ? 'junction' : 'dir');
write(path.join(A, 'sessions', 'local_1.json'), '{"title":"eins"}');
write(path.join(A, 'history.jsonl'), '{"h":1}\n');

test('push legt Snapshot mit allen Chunks an', async () => {
  const r = await push(useRoots(A), {}, log);
  assert.equal(r.stats.files, 7);
  assert.equal(r.uploadedChunks, r.stats.chunks);
  const { snapshots } = await new Client(SERVER, TOKEN).listSnapshots();
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].id, r.id);
});

test('zweiter push nach Anhaengen laedt nur den letzten Chunk', async () => {
  fs.appendFileSync(path.join(A, 'projects', 'proj1', 'big.jsonl'), randomBytes(100 * 1024));
  const r = await push(useRoots(A), {}, log);
  assert.equal(r.uploadedChunks, 1);
});

test('pull auf leerem PC B stellt Zustand exakt her, inklusive Verzeichnis-Link', async () => {
  fs.mkdirSync(path.join(B, 'projects'), { recursive: true });
  const r = await pull(useRoots(B), {}, log);
  assert.equal(r.changed, true);
  assert.deepEqual(treeOf(B), treeOf(A));
  assert.ok(fs.lstatSync(path.join(B, 'projects', 'memory')).isSymbolicLink());
  const ma = fs.statSync(path.join(A, 'projects', 'proj1', 'big.jsonl')).mtimeMs;
  const mb = fs.statSync(path.join(B, 'projects', 'proj1', 'big.jsonl')).mtimeMs;
  assert.ok(Math.abs(ma - mb) < 5, `mtime weicht ab: ${ma} vs ${mb}`);
});

test('pull --exact spiegelt lokale Abweichungen zurueck (loeschen, ueberschreiben, verkuerzen)', async () => {
  fs.rmSync(path.join(B, 'projects', 'proj1', 'small.json'));
  write(path.join(B, 'projects', 'extra', 'x.txt'), 'x');
  write(path.join(B, 'projects', 'proj1', 'sub', 'deep', 'tool.txt'), 'changed');
  fs.truncateSync(path.join(B, 'projects', 'proj1', 'big.jsonl'), 5 * MB);
  write(path.join(B, 'sessions', 'local_2.json'), '{}');
  const r = await pull(useRoots(B), { exact: true }, log);
  assert.equal(r.deleted, 2);
  assert.equal(r.downloadedChunks, 4, 'small.json, tool.txt und zwei Chunks von big.jsonl fehlen lokal, Chunk 0 wird wiederverwendet');
  assert.deepEqual(treeOf(B), treeOf(A));
  assert.ok(!fs.existsSync(path.join(B, 'projects', 'extra')), 'leerer Ordner muss verschwinden');
});

test('pull ohne Abweichung ist ein No-op', async () => {
  const r = await pull(useRoots(B), {}, log);
  assert.equal(r.changed, false);
});

test('dry-run aendert nichts', async () => {
  fs.rmSync(path.join(B, 'projects', 'proj1', 'small.json'));
  const before = treeOf(B);
  const r = await pull(useRoots(B), { dryRun: true, exact: true }, log);
  assert.equal(r.changed, false);
  assert.deepEqual(treeOf(B), before);
  await pull(useRoots(B), { exact: true }, log);
  assert.deepEqual(treeOf(B), treeOf(A));
});

test('Backups werden angelegt und auf backupsToKeep begrenzt', () => {
  const dirs = fs.readdirSync(path.join(process.env.CLYDE_HOME, 'backups'));
  assert.equal(dirs.length, 2);
  assert.ok(fs.existsSync(path.join(process.env.CLYDE_HOME, 'backups', dirs[1], 'claude-projects', 'proj1', 'big.jsonl')));
});

test('falscher Token wird abgewiesen', async () => {
  await assert.rejects(push(useRoots(A, 'falsch'), {}, log), /401/);
});

// Verschiedene Benutzerkonten und Laufwerke: PC C gehoert "alice" (Projekte auf D:),
// PC D gehoert "bob" (Projekte auf C:)
const C = path.join(tmp, 'C');
const D = path.join(tmp, 'D');
const ALICE = 'C:\\Users\\alice';
const BOB = 'C:\\Users\\bob';
const chatAlice = '{"cwd":"C:\\\\Users\\\\alice\\\\Nextcloud\\\\Aegis","key":"C--Users-alice-Nextcloud-Aegis"}\n'
  + '{"tool":"ls /c/Users/alice/Nextcloud","fwd":"C:/Users/alice/x","raw":"C:\\Users\\alice\\y"}\n';
const chatBob = chatAlice.split('alice').join('bob');
const sessionAlice = '{"sessionId":"local_9","cliSessionId":"chat","cwd":"C:\\\\Users\\\\alice\\\\Nextcloud\\\\Aegis","title":"t"}';
write(path.join(C, 'projects', 'C--Users-alice-Nextcloud-Aegis', 'chat.jsonl'), chatAlice);
write(path.join(C, 'projects', 'C--Users-alice-Nextcloud-Aegis', 'bin.dat'), 'C:\\\\Users\\\\alice bleibt binaer');
write(path.join(C, 'projects', 'D--Aegis-episode1', 'chat.jsonl'), '{"cwd":"D:\\\\Aegis\\\\episode1","sh":"/d/Aegis"}\n');
write(path.join(C, 'projects', 'E--Other', 'chat.jsonl'), '{"cwd":"E:\\\\Other"}\n');
write(path.join(C, 'sessions', 'local_9.json'), sessionAlice);
write(path.join(C, 'history.jsonl'), '{"display":"cd /c/Users/alice"}\n');
const cAlice = () => useRoots(C, TOKEN, ALICE, 'D', SERVER2);
const cBob = () => useRoots(D, TOKEN, BOB, 'C', SERVER2);

test('anderes Konto und Laufwerk: pull schreibt Ordnernamen und Inhalte auf lokale Werte um', async () => {
  const pushed = await push(cAlice(), {}, log);
  assert.ok(pushed.uploadedChunks >= 5);
  fs.mkdirSync(path.join(D, 'projects'), { recursive: true });
  const r = await pull(cBob(), {}, log);
  assert.equal(r.changed, true);
  assert.ok(fs.existsSync(path.join(D, 'projects', 'C--Users-bob-Nextcloud-Aegis', 'chat.jsonl')), 'Ordnername muss bob tragen');
  assert.ok(!fs.existsSync(path.join(D, 'projects', 'C--Users-alice-Nextcloud-Aegis')));
  assert.equal(read(path.join(D, 'projects', 'C--Users-bob-Nextcloud-Aegis', 'chat.jsonl')), chatBob);
  assert.equal(read(path.join(D, 'projects', 'C--Users-bob-Nextcloud-Aegis', 'bin.dat')), 'C:\\\\Users\\\\alice bleibt binaer', 'Nicht-Textdateien bleiben unveraendert');
  assert.equal(read(path.join(D, 'projects', 'C--Aegis-episode1', 'chat.jsonl')), '{"cwd":"C:\\\\Aegis\\\\episode1","sh":"/c/Aegis"}\n', 'Projektlaufwerk D -> C');
  assert.ok(!fs.existsSync(path.join(D, 'projects', 'D--Aegis-episode1')));
  assert.equal(read(path.join(D, 'projects', 'E--Other', 'chat.jsonl')), '{"cwd":"E:\\\\Other"}\n', 'fremdes Laufwerk bleibt');
  assert.equal(read(path.join(D, 'sessions', 'local_9.json')), sessionAlice.split('alice').join('bob'));
  assert.equal(read(path.join(D, 'history.jsonl')), '{"display":"cd /c/Users/bob"}\n');
});

test('anderes Konto: erneuter pull ist ein No-op, push von bob laedt keine Chunks hoch', async () => {
  assert.equal((await pull(cBob(), {}, log)).changed, false);
  const r = await push(cBob(), {}, log);
  assert.equal(r.uploadedChunks, 0, 'kanonische Inhalte von alice und bob sind identisch');
  assert.equal((await pull(cAlice(), {}, log)).changed, false, 'alice sieht bobs Snapshot als unveraendert');
});

test('anderes Konto: Aenderung bei bob kommt bei alice als alice auf D: an', async () => {
  fs.appendFileSync(path.join(D, 'projects', 'C--Users-bob-Nextcloud-Aegis', 'chat.jsonl'), '{"neu":"C:\\\\Users\\\\bob\\\\n","proj":"C:\\\\Aegis"}\n');
  await push(cBob(), {}, log);
  const r = await pull(cAlice(), {}, log);
  assert.equal(r.changed, true);
  assert.equal(read(path.join(C, 'projects', 'C--Users-alice-Nextcloud-Aegis', 'chat.jsonl')), chatAlice + '{"neu":"C:\\\\Users\\\\alice\\\\n","proj":"D:\\\\Aegis"}\n');
});

test('Projekt-Zuordnung: fehlender Projektordner wird erfragt, gespeichert und angewendet', async () => {
  const bobsAegis = path.join(tmp, 'bobs-aegis');
  fs.mkdirSync(bobsAegis, { recursive: true });
  const asked = [];
  const r = await pull(cBob(), { ask: async (q) => { asked.push(q); return bobsAegis; } }, log);
  assert.equal(asked.length, 1, 'genau ein fehlendes Projekt muss erfragt werden');
  assert.ok(asked[0].includes('C:\\Users\\bob\\Nextcloud\\Aegis') && asked[0].includes('gibt es hier nicht'), asked[0]);
  assert.equal(r.changed, true);
  const cfg = loadConfig();
  assert.deepEqual(cfg.pathMap, { '@@CLYDE_HOME_RAW@@\\Nextcloud\\Aegis': bobsAegis });
  const key = pathVariants(bobsAegis).KEY;
  assert.ok(fs.existsSync(path.join(D, 'projects', key, 'chat.jsonl')), `Chat muss unter ${key} liegen`);
  assert.ok(!fs.existsSync(path.join(D, 'projects', 'C--Users-bob-Nextcloud-Aegis')), 'alter Ort muss verschwinden');
  const j1 = pathVariants(bobsAegis).J1;
  assert.ok(read(path.join(D, 'projects', key, 'chat.jsonl')).startsWith(`{"cwd":"${j1}"`));
  assert.ok(read(path.join(D, 'sessions', 'local_9.json')).includes(`"cwd":"${j1}"`));
  assert.equal((await pull(cfg, {}, log)).changed, false, 'zweiter pull ist ein No-op');
  assert.equal((await push(cfg, {}, log)).uploadedChunks, 0, 'neutrale Form bleibt identisch');
  assert.equal((await pull(cAlice(), {}, log)).changed, false);
  const lines = [];
  await map(cfg, { list: true }, { info: (s) => lines.push(s), warn() {} });
  assert.ok(lines.join('\n').includes(bobsAegis));
  await map(cfg, { remove: '1' }, { info() {}, warn() {}, debug() {} });
  assert.deepEqual(loadConfig().pathMap, {});
  assert.ok(fs.existsSync(path.join(D, 'projects', 'C--Users-bob-Nextcloud-Aegis', 'chat.jsonl')), 'Entfernen der Zuordnung stellt die Dateien sofort zurueck');
  assert.ok(!fs.existsSync(path.join(D, 'projects', key)));
  assert.ok(read(path.join(D, 'sessions', 'local_9.json')).includes('"cwd":"C:\\\\Users\\\\bob\\\\Nextcloud\\\\Aegis"'), 'Pfad im Inhalt zurueckgesetzt');
  assert.equal((await pull(loadConfig(), { noAsk: true }, log)).changed, false, 'danach ist nichts mehr abzugleichen');
  assert.equal((await push(loadConfig(), {}, log)).uploadedChunks, 0, 'und nichts hochzuladen: kein scheinbar verschobener Chat');
});

test('ohne Terminal wird ein fehlender Projektordner nur gemeldet, Projektlaufwerk wird uebernommen', async () => {
  const E = path.join(tmp, 'E');
  fs.mkdirSync(path.join(E, 'projects'), { recursive: true });
  const warned = [];
  const quiet = { info() {}, debug() {}, warn: (s) => warned.push(s), error() {} };
  await pull(useRoots(E, TOKEN, BOB, undefined, SERVER2), { dryRun: true, noAsk: true }, quiet);
  assert.ok(warned.some((w) => w.includes('gibt es hier nicht') && w.includes('clyde map --add')), warned.join('\n'));
  const latest = await new Client(SERVER2, TOKEN).getSnapshot('latest');
  assert.equal(loadConfig().projectDrive, latest.projectDrive, 'Projektlaufwerk aus dem Snapshot uebernommen');
  assert.deepEqual(loadConfig().pathMap, {});
});

test('Dashboard-API liefert Chats mit Titel, Projektpfad und Transkript', async () => {
  // ein in der App geloeschter Chat (Transkript bleibt, Marker daneben) und eine fremde Datei im Chatlisten-Ordner
  write(path.join(C, 'projects', 'C--Users-alice-Nextcloud-Aegis', 'weg.jsonl'), '{"x":1}\n');
  write(path.join(C, 'projects', 'C--Users-alice-Nextcloud-Aegis', 'weg.desktop-released.json'), '{"v":1,"reason":"delete"}');
  write(path.join(C, 'sessions', 'scheduled-tasks.json'), '{"scheduledTasks":[]}');
  // Einstellungsdatei der App: Gruppen plus ein Zugangsdatum, das nie hochgeladen werden darf
  write(path.join(C, 'claude_desktop_config.json'), JSON.stringify({
    mcpServers: { geheim: { command: 'x', env: { API_TOKEN: 'GEHEIM-12345' } } },
    preferences: { epitaxyPrefs: {
      'dframe-group-scopes': { 'org/acct': {
        groups: [{ id: 'cg-1', name: 'Archivar Project', secret: 'GEHEIM-12345' }],
        assignments: { 'code:local_9': 'cg-1' },
        order: { 'cg-1': ['code:local_9'] },
      } },
      'starred-local-code-sessions': [],
      'oauth:tokenCache': 'GEHEIM-12345',
    } },
  }));
  await push(cAlice(), {}, log);
  const c = new Client(SERVER2, TOKEN);
  const d = await c.json('GET', '/snapshots/latest/chats');
  assert.equal(d.snapshot.home, ALICE);
  assert.equal(d.snapshot.projectDrive, 'D');
  assert.deepEqual(d.snapshot.projects.map((p) => p.shown), ['C:\\Users\\alice\\Nextcloud\\Aegis']);
  assert.deepEqual(d.counts, { app: 1, deleted: 1, transcript: 2 }, 'scheduled-tasks.json ist kein Chat');
  const chat = d.chats.find((x) => x.kind === 'app');
  assert.equal(chat.title, 't');
  assert.ok(chat.transcript, 'Chat ist mit seinem Transkript verknuepft');
  assert.equal(d.chats.find((x) => x.cliSessionId === 'weg').kind, 'deleted');
  const fromTranscript = d.chats.find((x) => x.transcript && x.transcript.project === '@@CLYDE_DRIVE_KEY@@Aegis-episode1');
  assert.equal(fromTranscript.cwdShown, 'D:\\Aegis\\episode1', 'Projektordner aus dem Transkript gelesen');
  assert.equal(d.snapshot.chatListMissing, false);
  assert.deepEqual(chat.appGroup, { id: 'cg-1', name: 'Archivar Project', rank: 0 }, 'Gruppe der App kommt im Dashboard an');
  assert.equal(d.snapshot.hasAppGroups, true);
  const rawManifest = JSON.stringify(await c.getSnapshot('latest'));
  assert.ok(rawManifest.includes('Archivar Project'));
  assert.ok(!rawManifest.includes('GEHEIM'), 'aus der Einstellungsdatei geht nur Gruppen-Name und Zuordnung mit');
  assert.equal((await (await fetch(`${SERVER}/health`)).json()).version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.equal(chat.cwdShown, 'C:\\Users\\alice\\Nextcloud\\Aegis');
  assert.equal(chat.cwd, '@@CLYDE_HOME_RAW@@\\Nextcloud\\Aegis');
  assert.ok(d.chats.some((x) => !x.sidebar && x.transcript && x.transcript.projectShown === 'D--Aegis-episode1'), 'Transkript ohne Sidebar-Eintrag');
  assert.ok(d.projects.length >= 2);
  const html = await fetch(`${SERVER}/`).then((r) => r.text());
  assert.ok(html.includes('Clyde Dashboard'));
});

test('alter Snapshot (v1) wird mit klarer Meldung abgelehnt', async () => {
  const c = new Client(SERVER2, TOKEN);
  await c.putSnapshot({ version: 1, id: '20000101-000000000-alt', createdAt: '2000-01-01T00:00:00.000Z', host: 'h', user: 'u', roots: {}, stats: { files: 0, bytes: 0, chunks: 0 } });
  await assert.rejects(pull(cBob(), { id: '20000101-000000000-alt' }, log), /Format v1/);
  await c.deleteSnapshot('20000101-000000000-alt');
});

test('gc entfernt Chunks geloeschter Snapshots', async () => {
  const c = new Client(SERVER, TOKEN);
  const { snapshots } = await c.listSnapshots();
  assert.ok(snapshots.length >= 2);
  await c.deleteSnapshot(snapshots[snapshots.length - 1].id);
  const r = await c.gc();
  assert.ok(r.deleted >= 1);
});
