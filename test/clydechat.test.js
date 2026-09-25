// Clyde-Chat-Modus: Aufruf aus einem Chat der laufenden App.
// Laeuft als eigener Prozess (node --test isoliert Dateien), damit die
// Umgebungsvariablen der Session hier gezielt gesetzt werden koennen.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLYDE_QUIET = '1';
delete process.env.CLYDE_SKIP_GUARD;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-chat-'));
process.env.CLYDE_HOME = path.join(tmp, 'clydehome');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude'); // ~/.claude/sessions der Testwelt

const OWN = '11111111-1111-1111-1111-111111111111';
const OWN_HOST = 'local_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = '22222222-2222-2222-2222-222222222222';
const OTHER_HOST = 'local_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FRESH = '33333333-3333-3333-3333-333333333333';
const FRESH_HOST = 'local_cccccccc-cccc-cccc-cccc-cccccccccccc';
process.env.CLAUDE_CODE_SESSION_ID = OWN;
process.env.CLAUDE_CODE_HOST_SESSION_ID = OWN_HOST;

const { createServer } = await import('../server/server.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { push, pull } = await import('../src/commands.js');
const { checkGuard } = await import('../src/guard.js');
const { log } = await import('../src/log.js');

const TOKEN = 'chat-token';
const server = createServer({ dataDir: path.join(tmp, 'server'), token: TOKEN, adminPassword: 'x'.repeat(12), log: { log() {}, error: console.error } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SERVER = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const sessionsDir = path.join(tmp, 'claude', 'sessions');
function setLive(entries) {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  // process.pid ist garantiert lebendig; jede Session bekommt eine eigene Datei
  entries.forEach((e, i) => write(path.join(sessionsDir, `${process.pid}-${i}.json`), JSON.stringify({ pid: process.pid, ...e })));
}
const PC = (n) => path.join(tmp, n);
function cfgFor(base, extra = {}) {
  saveConfig({
    server: SERVER, token: TOKEN, home: 'C:\\Users\\tester',
    roots: {
      'claude-projects': path.join(base, 'projects'),
      'desktop-sessions': path.join(base, 'sessions'),
      'claude-history': false, 'claude-file-history': false, 'claude-todos': false, 'claude-plans': false,
    },
    ...extra,
  });
  return loadConfig();
}
function chatFiles(base, sid, host, text) {
  write(path.join(base, 'projects', 'D--proj', `${sid}.jsonl`), `{"text":"${text}"}\n`);
  write(path.join(base, 'projects', 'D--proj', sid, 'tool-results', 'r.txt'), text);
  write(path.join(base, 'sessions', 'org', 'acct', `${host}.json`), JSON.stringify({ sessionId: host, cliSessionId: sid, title: text, cwd: 'D:\\proj' }));
}

test('Guard: App darf offen sein, nur andere arbeitende Chats blockieren', () => {
  setLive([{ sessionId: OWN, hostSessionId: OWN_HOST, status: 'busy', name: 'Clyde' }, { sessionId: OTHER, hostSessionId: OTHER_HOST, status: 'idle', name: 'Projekt' }]);
  assert.doesNotThrow(() => checkGuard('Push', false, log), 'eigener Chat ist busy, der andere idle: erlaubt');
  setLive([{ sessionId: OWN, status: 'busy' }, { sessionId: OTHER, status: 'busy', name: 'Projekt' }]);
  assert.throws(() => checkGuard('Push', false, log), /arbeiten gerade:[\s\S]*"Projekt"/);
  assert.doesNotThrow(() => checkGuard('Push', true, { warn() {} }), '--force uebersteuert');
});

test('push aus dem Clyde-Chat laesst den eigenen Chat aus und registriert ihn', async () => {
  setLive([{ sessionId: OWN, hostSessionId: OWN_HOST, status: 'busy' }, { sessionId: OTHER, hostSessionId: OTHER_HOST, status: 'idle', name: 'Projekt' }]);
  const A = PC('A');
  chatFiles(A, OWN, OWN_HOST, 'clyde-chat-a');
  chatFiles(A, OTHER, OTHER_HOST, 'projekt');
  const r = await push(cfgFor(A), { clydeChat: true }, log);
  assert.equal(r.excluded, 3, 'Transkript, Unterordner-Datei und Sidebar-Eintrag des Clyde-Chats');
  assert.equal(r.stats.files, 3);
  assert.deepEqual(loadConfig().registeredClydeChats, [OWN, OWN_HOST]);
  const snap = await (await fetch(`${SERVER}/snapshots/latest`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const all = Object.values(snap.roots).flatMap((x) => x.files.map((f) => f.p)).join('\n');
  assert.ok(!all.includes(OWN) && !all.includes(OWN_HOST), all);
  assert.ok(all.includes(OTHER));
});

test('pull im Clyde-Chat eines anderen PCs: eigener Chat und eigene Chats bleiben, offene Chats werden gemeldet', async () => {
  const B = PC('B');
  const OWN_B = '44444444-4444-4444-4444-444444444444';
  const OWN_B_HOST = 'local_dddddddd-dddd-dddd-dddd-dddddddddddd';
  process.env.CLAUDE_CODE_SESSION_ID = OWN_B;
  process.env.CLAUDE_CODE_HOST_SESSION_ID = OWN_B_HOST;
  chatFiles(B, OWN_B, OWN_B_HOST, 'clyde-chat-b');
  chatFiles(B, OTHER, OTHER_HOST, 'projekt-alt-und-laenger');
  chatFiles(B, FRESH, FRESH_HOST, 'nur-auf-b');
  setLive([{ sessionId: OWN_B, hostSessionId: OWN_B_HOST, status: 'busy' }, { sessionId: OTHER, hostSessionId: OTHER_HOST, status: 'idle', name: 'Projekt' }]);
  const r = await pull(cfgFor(B), { noAsk: true }, log);
  assert.equal(r.changed, true);
  assert.equal(fs.readFileSync(path.join(B, 'projects', 'D--proj', `${OWN_B}.jsonl`), 'utf8'), '{"text":"clyde-chat-b"}\n', 'eigener Chat unangetastet');
  assert.ok(fs.existsSync(path.join(B, 'sessions', 'org', 'acct', `${OWN_B_HOST}.json`)));
  assert.equal(fs.readFileSync(path.join(B, 'projects', 'D--proj', `${OTHER}.jsonl`), 'utf8'), '{"text":"projekt-alt-und-laenger"}\n{"text":"projekt"}\n', 'auf beiden PCs weitergefuehrter Chat: Zeilen beider Seiten, neuere Fassung zuerst');
  assert.ok(fs.existsSync(path.join(B, 'projects', 'D--proj', `${FRESH}.jsonl`)), 'Chat, den es nur auf B gibt, bleibt');
  assert.deepEqual(r.openTouched, ['"Projekt"']);
  assert.ok(r.hints.some((h) => h.includes('neu starten')));
});

test('ohne Session-Umgebung gilt wieder: App muss geschlossen sein', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_HOST_SESSION_ID;
  setLive([{ sessionId: OTHER, status: 'idle', name: 'Projekt' }]);
  assert.throws(() => checkGuard('Pull', false, log), /Claude laeuft noch/);
});
