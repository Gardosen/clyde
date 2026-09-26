// Bericht nach dem Push
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-report-'));
process.env.CLYDE_HOME = path.join(tmp, 'clydehome');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');

const { createServer } = await import('../server/server.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { push } = await import('../src/commands.js');
const { refs } = await import('../src/commands-misc.js');
const { formatReport } = await import('../src/report.js');

const TOKEN = 'report-token';
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
  saveConfig({ server: SERVER, token: TOKEN, home, roots: { 'claude-projects': path.join(base, 'projects'), 'desktop-sessions': path.join(base, 'sessions'), 'claude-file-history': false, 'claude-todos': false, 'claude-plans': false, 'claude-history': false } });
  return loadConfig();
};
const entry = (id, obj) => write(path.join(base, 'sessions', 'org', 'acct', `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: `cli${id}`, cwd: home, ...obj }));
const transcript = (id, lines) => write(path.join(base, 'projects', 'p', `cli${id}.jsonl`), Array.from({ length: lines }, (_, i) => JSON.stringify({ i })).join('\n') + '\n');
const groupsConfig = (groups, assignments) => write(path.join(base, 'claude_desktop_config.json'), JSON.stringify({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': { 'org/acct': { groups, assignments, order: {} } } } } }));

test('Bericht: neuer Content mit Zeilen, neue und geloeschte Chats, Repo, Umbenennen, Gruppen, Anheften, Archiv', async () => {
  entry('1', { title: 'Eins' });
  transcript('1', 3);
  entry('2', { title: 'Zwei' });
  transcript('2', 2);
  entry('4', { title: 'Vier' });
  groupsConfig([{ id: 'g1', name: 'Archiv' }, { id: 'g2', name: 'Web' }], { 'code:local_1': 'g1' });
  const first = await push(cfg(), {}, quiet);
  assert.deepEqual(first.report.newChats.map((c) => c.title).sort(), ['Eins', 'Vier', 'Zwei'], 'erster Push: alles neu');

  // Repo, das spaeter per Pfad verknuepft wird
  const REMOTE = path.join(tmp, 'r.git');
  g(tmp, 'init', '--bare', REMOTE);
  const REPO = path.join(home, 'r');
  g(tmp, 'clone', REMOTE, REPO);
  await new Promise((r) => setTimeout(r, 20));

  transcript('1', 8);                                                   // +5 Zeilen
  entry('1', { title: 'Eins', isStarred: true });                       // angeheftet
  entry('2', { title: 'Zwei neu', titleSource: 'user', isArchived: true }); // umbenannt, archiviert
  entry('3', { title: 'Drei' });                                        // neu
  transcript('3', 4);
  fs.rmSync(path.join(base, 'sessions', 'org', 'acct', 'local_4.json')); // geloescht
  groupsConfig([{ id: 'g1', name: 'Archiv' }, { id: 'g2', name: 'Webprojekte' }], { 'code:local_1': 'g2' }); // verschoben + Gruppe umbenannt
  await refs(cfg(), { link: true, args: ['Zwei neu', REPO] }, quiet);

  const out = [];
  const r = await push(cfg(), {}, { info: (s) => out.push(s), warn() {}, debug() {}, error() {} });
  const rep = r.report;
  assert.deepEqual(rep.content, [{ title: 'Eins', lines: 5, bytes: rep.content[0].bytes }]);
  assert.deepEqual(rep.newChats.map((c) => [c.title, c.lines]), [['Drei', 4]]);
  assert.deepEqual(rep.deleted, ['Vier']);
  assert.deepEqual(rep.repos, [{ title: 'Zwei neu', remote: REMOTE }]);
  assert.deepEqual(rep.renamed, [{ kind: 'chat', from: 'Zwei', to: 'Zwei neu' }, { kind: 'group', from: 'Web', to: 'Webprojekte' }]);
  assert.deepEqual(rep.moved, [{ title: 'Eins', from: 'Archiv', to: 'Webprojekte' }]);
  assert.deepEqual(rep.pinned, ['Eins']);
  assert.deepEqual(rep.archived, ['Zwei neu']);

  const text = out.join('\n');
  for (const line of ['Bericht:', 'Neuer Content:', '* Eins -> +5 Zeilen', 'Neuer Chat:', '* Drei (+4 Zeilen)', 'Neues Repo registriert:', '* Zwei neu -> ' + REMOTE,
    'Umbenannt:', '* Zwei -> Zwei neu', '* Gruppe Web -> Webprojekte', 'In Gruppe verschoben:', '* Eins: Archiv -> Webprojekte', 'Angeheftet:', 'Archiviert:', 'Geloescht:', '* Vier']) {
    assert.ok(text.includes(line), `fehlt im Bericht: ${line}\n${text}`);
  }

  // ohne Aenderungen: kein Bericht, Repo nicht erneut gemeldet
  const again = [];
  await push(cfg(), {}, { info: (s) => again.push(s), warn() {}, debug() {}, error() {} });
  assert.ok(!again.some((l) => l.includes('Bericht:')), again.join('\n'));
});

test('Ohne Zeilenzahl im alten Stand nennt der Bericht die Groesse', () => {
  const lines = formatReport({ content: [{ title: 'Alt', lines: null, bytes: 34 * 1024 }], newChats: [], repos: [], renamed: [], moved: [], pinned: [], unpinned: [], archived: [], unarchived: [], deleted: [] });
  assert.deepEqual(lines, ['Neuer Content:', '  * Alt -> +34.0 KB']);
});
