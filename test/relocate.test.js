import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.CLAUDE_CODE_SESSION_ID; // wie ein Terminal ausserhalb der App
delete process.env.CLAUDE_CODE_HOST_SESSION_ID;
process.env.CLYDE_SKIP_GUARD = '1';
process.env.CLYDE_QUIET = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-reloc-'));
process.env.CLYDE_HOME = path.join(tmp, 'clydehome');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { configFromRaw } = await import('../src/config.js');
const { relocate } = await import('../src/commands-misc.js');
const { projectKey } = await import('../src/relocate.js');
const quiet = { info() {}, warn() {}, debug() {} };

const W = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d); };
const PROJ = path.join(tmp, 'projects');
const SIDE = path.join(tmp, 'sessions', 'org', 'acct');
const OLD = path.join(tmp, 'Nextcloud', 'Aegis');
const LUNIA = path.join(tmp, 'D', 'Lunia');
const LINEAGE = path.join(tmp, 'D', 'Lineage 2');
const MEMORY = path.join(tmp, 'ClaudeMemory', 'memory');
for (const d of [OLD, LUNIA, LINEAGE, MEMORY]) fs.mkdirSync(d, { recursive: true });
W(path.join(MEMORY, 'MEMORY.md'), '# Wissen');
const oldKey = path.join(PROJ, projectKey(OLD));
fs.mkdirSync(oldKey, { recursive: true });
fs.symlinkSync(MEMORY, path.join(oldKey, 'memory'), process.platform === 'win32' ? 'junction' : 'dir');

function chat(sid, app, title) {
  W(path.join(oldKey, `${sid}.jsonl`), `{"cwd":"x","sid":"${sid}"}\n`);
  W(path.join(oldKey, sid, 'subagents', 'a.jsonl'), 'sub');
  W(path.join(SIDE, `${app}.json`), JSON.stringify({
    sessionId: app, cliSessionId: sid, title, cwd: OLD, originCwd: OLD, model: 'm',
    sessionPermissionUpdates: [{ type: 'addDirectories', directories: [OLD, 'E:\\anders'] }],
  }));
}
chat('11111111-aaaa', 'local_a', '3. Lunia Archivar Projekt');
chat('22222222-bbbb', 'local_b', '4. Lineage 2 Archivar Projekt');
chat('33333333-cccc', 'local_c', 'Chat-Synchronisierung');

const cfg = configFromRaw({ roots: {
  'claude-projects': PROJ, 'desktop-sessions': path.join(tmp, 'sessions'),
  'claude-file-history': false, 'claude-todos': false, 'claude-plans': false, 'claude-history': false,
} });
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const plan = path.join(tmp, 'plan.json');
W(plan, JSON.stringify({ chats: [{ chat: 'Lunia', to: LUNIA }, { chat: 'local_b', to: `"${LINEAGE}\\"` }] }));

test('Trockenlauf aendert nichts und plant Umzug samt Memory-Verknuepfung', async () => {
  const r = await relocate(cfg, { plan, dryRun: true }, quiet);
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0].moves.length, 2, 'Transkript und Unterordner');
  assert.equal(r.steps[0].link.target, fs.realpathSync(MEMORY));
  assert.equal(r.steps[1].to, LINEAGE, 'Anfuehrungszeichen und Schraegstrich am Ende werden entfernt');
  assert.ok(fs.existsSync(path.join(oldKey, '11111111-aaaa.jsonl')));
  assert.equal(read(path.join(SIDE, 'local_a.json')).cwd, OLD);
});

let backup;
test('Umzug stellt Chatliste und Ablage um, Memory bleibt erreichbar, anderes bleibt', async () => {
  const r = await relocate(cfg, { plan }, quiet);
  backup = r.backupDir;
  const lk = path.join(PROJ, projectKey(LUNIA));
  assert.ok(fs.existsSync(path.join(lk, '11111111-aaaa.jsonl')));
  assert.ok(fs.existsSync(path.join(lk, '11111111-aaaa', 'subagents', 'a.jsonl')));
  assert.ok(!fs.existsSync(path.join(oldKey, '11111111-aaaa.jsonl')));
  assert.equal(fs.readFileSync(path.join(lk, 'memory', 'MEMORY.md'), 'utf8'), '# Wissen', 'Memory ueber Verknuepfung');
  const a = read(path.join(SIDE, 'local_a.json'));
  assert.equal(a.cwd, LUNIA);
  assert.equal(a.originCwd, LUNIA);
  assert.deepEqual(a.sessionPermissionUpdates[0].directories, [LUNIA, 'E:\\anders']);
  assert.equal(a.title, '3. Lunia Archivar Projekt');
  assert.equal(read(path.join(SIDE, 'local_b.json')).cwd, LINEAGE);
  assert.ok(fs.existsSync(path.join(PROJ, projectKey(LINEAGE), '22222222-bbbb.jsonl')));
  assert.equal(read(path.join(SIDE, 'local_c.json')).cwd, OLD, 'nicht genannter Chat bleibt');
  assert.ok(fs.existsSync(path.join(oldKey, '33333333-cccc.jsonl')));
  assert.ok(fs.existsSync(path.join(oldKey, 'memory', 'MEMORY.md')), 'altes Memory bleibt');
});

test('zweiter Lauf erkennt, dass nichts mehr zu tun ist', async () => {
  const r = await relocate(cfg, { plan, dryRun: true }, quiet);
  assert.ok(r.steps.every((s) => s.unchanged));
});

test('Rueckgaengig stellt alles wieder her', async () => {
  await relocate(cfg, { undo: backup }, quiet);
  assert.ok(fs.existsSync(path.join(oldKey, '11111111-aaaa.jsonl')));
  assert.ok(fs.existsSync(path.join(oldKey, '22222222-bbbb', 'subagents', 'a.jsonl')));
  assert.equal(read(path.join(SIDE, 'local_a.json')).cwd, OLD);
  assert.ok(!fs.existsSync(path.join(PROJ, projectKey(LUNIA), 'memory')), 'Verknuepfung entfernt');
  assert.ok(fs.existsSync(path.join(MEMORY, 'MEMORY.md')), 'Memory selbst unangetastet');
});

test('Fehler: mehrdeutiger Titel, fehlender Zielordner, Aufruf aus einem Chat', async () => {
  await assert.rejects(relocate(cfg, { chat: 'Archivar', to: LUNIA }, quiet), /mehreren Chats/);
  await assert.rejects(relocate(cfg, { chat: 'Lunia', to: path.join(tmp, 'gibtsnicht') }, quiet), /existiert nicht/);
  delete process.env.CLYDE_SKIP_GUARD;
  process.env.CLAUDE_CODE_SESSION_ID = 'x';
  await assert.rejects(relocate(cfg, { chat: 'Lunia', to: LUNIA }, quiet), /nicht aus einem Chat heraus/);
  const dry = await relocate(cfg, { chat: 'Lunia', to: LUNIA, dryRun: true }, quiet);
  assert.equal(dry.steps.length, 1, 'Trockenlauf geht auch aus dem Chat');
  delete process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLYDE_SKIP_GUARD = '1';
});
