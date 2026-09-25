// Regressionstests zum Vorfall vom 2026-09-26 (Clyde 0.4.0 hat beim Pull und bei
// "map --add" Chat-Dateien beschaedigt):
//   1. Download hinter einem Proxy, der gzip bereits entpackt ("incorrect header check")
//   2. woertliche @@CLYDE_...@@-Texte in Chats wurden als Platzhalter eingesetzt
//   3. map --add hat global Fliesstext umgeschrieben und zwei Pfade vermengt
//   4. Umstellen lief, obwohl Chats des Projekts arbeiteten
//   5. Sicherungen wurden zu frueh aufgeraeumt
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

process.env.CLYDE_QUIET = '1';
process.env.CLYDE_SKIP_GUARD = '1';
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_CODE_HOST_SESSION_ID;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-vorfall-'));
process.env.CLYDE_HOME = path.join(tmp, 'clydehome');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude'); // eigene Session-Dateien fuer den Test

const { createServer } = await import('../server/server.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { push, pull } = await import('../src/commands.js');
const { map } = await import('../src/commands-misc.js');
const { pathVariants } = await import('../src/rewrite.js');
const { hashFile } = await import('../src/chunker.js');
const { makeBackup } = await import('../src/restore.js');
const { unionLines } = await import('../src/merge.js');
const { Client } = await import('../src/client.js');
const { sha256 } = await import('../src/framing.js');
const { backupsDir } = await import('../src/paths.js');

const B = String.fromCharCode(92);
const TOKEN = 'vorfall-token';
const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const servers = [];
async function startServer(name) {
  const s = createServer({ dataDir: path.join(tmp, name), token: TOKEN, gcGraceMs: 0, log: { log() {}, error: console.error } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
const SERVER = await startServer('server');
const LEGACY = await startServer('server-legacy');

// Proxy wie Traefik im Vorfall: entpackt gzip-Antworten und entfernt den Header
let seenAcceptEncoding = null;
const proxy = http.createServer((req, res) => {
  if (req.url === '/blobs/fetch') seenAcceptEncoding = req.headers['accept-encoding'] || null;
  const { host, ...headers } = req.headers;
  const up = http.request(SERVER + req.url, { method: req.method, headers }, (ur) => {
    const h = { ...ur.headers };
    let body = ur;
    if (h['content-encoding'] === 'gzip') { body = ur.pipe(zlib.createGunzip()); delete h['content-encoding']; delete h['content-length']; }
    res.writeHead(ur.statusCode, h);
    body.pipe(res);
  });
  req.pipe(up);
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
servers.push(proxy);
const PROXY = `http://127.0.0.1:${proxy.address().port}`;
after(() => { for (const s of servers) s.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const read = (p) => fs.readFileSync(p, 'utf8');
const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rootsFor = (base) => ({
  'claude-projects': path.join(base, 'projects'),
  'desktop-sessions': path.join(base, 'sessions'),
  'claude-history': { path: path.join(base, 'history.jsonl'), kind: 'file' },
  'claude-file-history': false, 'claude-todos': false, 'claude-plans': false,
});
function useConfig(base, home, { server = SERVER, drive, keep = 3 } = {}) {
  saveConfig({ server, token: TOKEN, roots: rootsFor(base), home, projectDrive: drive, backupsToKeep: keep });
  return loadConfig();
}
function snapshotTree(base) {
  const out = {};
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(base, p)] = sha(p);
    }
  };
  walk(base);
  return out;
}

test('1. Download klappt auch, wenn ein Proxy die gzip-Antwort schon entpackt hat', async () => {
  const data = [Buffer.from('eins'), Buffer.from('zwei'.repeat(5000))];
  const direct = new Client(SERVER, TOKEN);
  await direct.upload(data.map((d) => ({ hash: sha256(d), data: d })));
  for (const c of [direct, new Client(PROXY, TOKEN)]) {
    const got = [];
    await c.fetchBlobs(data.map((d) => sha256(d)), async (b) => { got.push(b.data.toString()); });
    assert.deepEqual(got, data.map(String));
  }
  assert.equal(seenAcceptEncoding, 'gzip', 'Client bittet ausdruecklich um gzip');
});

test('2. woertliche Platzhalter in einem Chat ueberstehen Push und Pull auf einen anderen PC unveraendert', async () => {
  const HA = path.join(tmp, 'home-a');
  const HB = path.join(tmp, 'home-b');
  const A = path.join(tmp, 'A');
  const PB = path.join(tmp, 'PB');
  fs.mkdirSync(path.join(HB, 'proj'), { recursive: true });
  const talk = 'So sieht das aus: @@CLYDE_HOME_RAW@@, @@CLYDE_HOME_J1@@, @@CLYDE_HOME_KEY@@-x, @@CLYDE_DRIVE_RAW@@Aegis, @@CLYDE_ESC_HOME_RAW@@ und @@CLYDE_';
  const rows = (home) => [
    { uuid: 'u1', type: 'user', cwd: path.join(home, 'proj'), message: talk },
    { uuid: 'u2', type: 'assistant', message: `Datei unter ${path.join(home, 'proj', 'a.txt')}` },
  ];
  const keyA = pathVariants(path.join(HA, 'proj')).KEY;
  const keyB = pathVariants(path.join(HB, 'proj')).KEY;
  const fileA = path.join(A, 'projects', keyA, 'c1.jsonl');
  write(fileA, jsonl(rows(HA)));
  const cfgA = useConfig(A, HA, { drive: 'Q' });
  const h = await hashFile(fileA, cfgA.forms, 'jsonl');
  assert.equal(h.stale, false, 'Datei mit woertlichen Platzhaltern laesst sich verlustfrei neutral und zurueck wandeln');
  await push(cfgA, {}, quiet);
  assert.equal((await new Client(SERVER, TOKEN).getSnapshot('latest')).version, 3);

  const cfgB = useConfig(PB, HB, { drive: 'Q' });
  const r = await pull(cfgB, { noAsk: true }, quiet);
  assert.equal(r.changed, true);
  const got = read(path.join(PB, 'projects', keyB, 'c1.jsonl'));
  assert.equal(got, jsonl(rows(HB)), 'Text bleibt woertlich, nur das echte Home wird ersetzt');
  for (const line of got.trim().split('\n')) JSON.parse(line);
  assert.equal((await push(cfgB, {}, quiet)).uploadedChunks, 0, 'neutrale Form auf beiden PCs identisch');
});

test('2b. alter Stand (v2) mit woertlichem Platzhalter: kein ungueltiges JSON beim Pull', async () => {
  const c = new Client(LEGACY, TOKEN);
  const content = jsonl([{ uuid: 'l1', message: 'alt @@CLYDE_HOME_RAW@@ text' }, `{"uuid":"l2","cwd":"@@CLYDE_HOME_J1@@${B}${B}p"}`]);
  const buf = Buffer.from(content);
  await c.upload([{ hash: sha256(buf), data: buf }]);
  await c.putSnapshot({
    version: 2, id: '20260926-000000000-alt', createdAt: new Date().toISOString(), host: 'alt', user: 'x', home: 'C:\\Users\\x',
    roots: { 'claude-projects': { kind: 'dir', files: [{ p: 'legacy/l.jsonl', s: buf.length, m: Date.now(), c: [sha256(buf)] }], links: [] } },
    stats: { files: 1, bytes: buf.length, chunks: 1 },
  });
  const HC = path.join(tmp, 'home-c');
  const PC = path.join(tmp, 'PC');
  await pull(useConfig(PC, HC, { server: LEGACY }), { noAsk: true }, quiet);
  const lines = read(path.join(PC, 'projects', 'legacy', 'l.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].message, 'alt @@CLYDE_HOME_RAW@@ text', 'woertlicher Platzhalter bleibt stehen statt JSON zu zerbrechen');
  assert.equal(lines[1].cwd, `${HC}${B}p`, 'echte Platzhalter werden weiter eingesetzt');
});

test('Zusammenfuehren: Zeilen mit derselben uuid sind dieselbe Nachricht', () => {
  const a = Buffer.from('{"uuid":"1","t":"neu"}\n{"uuid":"2","t":"x"}\n');
  const b = Buffer.from('{"uuid":"1","t":"alt"}\n{"uuid":"3","t":"y"}\n');
  assert.equal(unionLines(a, b, { byUuid: true }).toString(), '{"uuid":"1","t":"neu"}\n{"uuid":"2","t":"x"}\n{"uuid":"3","t":"y"}\n');
  assert.equal(unionLines(a, b).toString().split('\n').filter(Boolean).length, 4, 'ohne byUuid zeilenweise wie bisher');
});

test('3.-5. map --add stellt nur die Chats des Projekts um, fragt nach, respektiert arbeitende Chats und sichert dauerhaft', async () => {
  // Gamy: Chats vom anderen PC liegen unter OLD (dort heisst der Ordner so), die
  // eigenen Aegis-Chats unter NEW. Andere Chats und das Memory erwaehnen OLD nur.
  const G = path.join(tmp, 'G');
  const HG = path.join(tmp, 'home-g');
  const OLD = path.join(tmp, 'AegisAlt');
  const NEW = path.join(tmp, 'Aegis');
  const Y = path.join(tmp, 'Anderes');
  fs.mkdirSync(NEW, { recursive: true });
  const [kOld, kNew, kY] = [OLD, NEW, Y].map((p) => pathVariants(p).KEY);
  const K1 = '11111111-1111-4111-8111-111111111111';
  const G1 = '22222222-2222-4222-8222-222222222222';
  const Y1 = '33333333-3333-4333-8333-333333333333';
  const P = (...s) => path.join(G, ...s);
  write(P('projects', kOld, `${K1}.jsonl`), jsonl([{ uuid: 'a', cwd: OLD, sessionId: K1, message: `arbeite in ${OLD}` }, { uuid: 'b', message: 'fertig' }]));
  write(P('projects', kOld, K1, 'tool-results', 't.txt'), `Ausgabe aus ${OLD}\n`);
  write(P('projects', kNew, `${G1}.jsonl`), jsonl([{ uuid: 'c', cwd: NEW, message: `Umzug von ${OLD} nach ${NEW}` }]));
  write(P('projects', kY, `${Y1}.jsonl`), jsonl([{ uuid: 'd', cwd: Y, message: `frueher lag das unter ${OLD}` }]));
  write(P('projects', kY, 'memory', 'MEMORY.md'), `- ${OLD} gibt es nicht mehr, alles liegt unter ${NEW}\n`);
  write(P('sessions', 'local_k1.json'), JSON.stringify({ cwd: OLD, originCwd: OLD, title: 'Aegis vom anderen PC', cliSessionId: K1 }));
  write(P('sessions', 'local_g1.json'), JSON.stringify({ cwd: NEW, title: 'Aegis hier', cliSessionId: G1 }));
  write(P('sessions', 'local_y1.json'), JSON.stringify({ cwd: Y, title: 'Anderes', cliSessionId: Y1 }));
  write(P('history.jsonl'), jsonl([{ display: 'a', project: OLD }, { display: 'b', project: Y }]));
  const old = new Date('2026-09-20T10:00:00Z');
  fs.utimesSync(P('projects', kOld, `${K1}.jsonl`), old, old);
  const SRV = await startServer('server-g');
  let cfg = useConfig(G, HG, { server: SRV, keep: 1 });
  await push(cfg, {}, quiet);
  const before = snapshotTree(G);
  const origK1 = read(P('projects', kOld, `${K1}.jsonl`));
  const untouched = [P('projects', kNew, `${G1}.jsonl`), P('projects', kY, `${Y1}.jsonl`), P('projects', kY, 'memory', 'MEMORY.md'), P('sessions', 'local_g1.json'), P('sessions', 'local_y1.json')];
  const untouchedSha = untouched.map(sha);

  // Trockenlauf: Plan mit Zahlen und Warnungen, nichts geaendert
  const out = [];
  const L = { info: (s) => out.push(s), warn: (s) => out.push(`WARN ${s}`), debug() {} };
  const dry = await map(cfg, { add: true, dryRun: true, args: [OLD, NEW] }, L);
  assert.deepEqual(dry.plan.chats, ['Aegis vom anderen PC']);
  assert.equal(dry.plan.moved, 2, 'Transkript und Tool-Ergebnis des Chats');
  assert.equal(dry.plan.rewritten, 2, 'Sidebar-Eintrag und Eingabe-Historie');
  assert.equal(dry.plan.mentionsElsewhere, 3, 'eigener Aegis-Chat, anderer Chat und Memory erwaehnen OLD nur');
  const text = out.join('\n');
  assert.ok(/schon Projektordner von 1 Chat/.test(text) && text.includes('Aegis hier'), text);
  assert.ok(text.includes('bleiben unveraendert'), text);
  assert.deepEqual(snapshotTree(G), before, 'Trockenlauf aendert nichts');

  // 3. ohne Bestaetigung (Plugin, kein Terminal) passiert nichts
  await assert.rejects(map(cfg, { add: true, noAsk: true, args: [OLD, NEW] }, quiet), /--yes/);
  assert.deepEqual(snapshotTree(G), before);
  assert.deepEqual(loadConfig().pathMap, {});

  // 4. ein Chat des Projekts arbeitet gerade: Abbruch, nichts geaendert
  const sessionFile = path.join(tmp, 'claude', 'sessions', `${process.pid}.json`);
  write(sessionFile, JSON.stringify({ pid: process.pid, sessionId: K1, status: 'busy', name: 'Aegis vom anderen PC' }));
  await assert.rejects(map(cfg, { add: true, yes: true, args: [OLD, NEW] }, quiet), /arbeiten gerade/);
  assert.deepEqual(snapshotTree(G), before);
  // ein anderer, nicht betroffener Chat darf arbeiten
  write(sessionFile, JSON.stringify({ pid: process.pid, sessionId: Y1, status: 'busy', name: 'Anderes' }));

  // mit Bestaetigung: nur die Dateien des Chats werden umgestellt
  await map(cfg, { add: true, yes: true, args: [OLD, NEW] }, quiet);
  fs.rmSync(sessionFile);
  cfg = loadConfig();
  assert.deepEqual(cfg.pathMap, { [OLD]: NEW });
  assert.ok(!fs.existsSync(P('projects', kOld)), 'alter Transkript-Ordner ist leer und weg');
  const moved = read(P('projects', kNew, `${K1}.jsonl`)).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(moved[0].cwd, NEW);
  assert.equal(moved[0].message, `arbeite in ${NEW}`);
  assert.equal(moved[1].message, 'fertig');
  assert.equal(fs.statSync(P('projects', kNew, `${K1}.jsonl`)).mtimeMs, old.getTime(), 'Aenderungszeit bleibt');
  assert.equal(read(P('projects', kNew, K1, 'tool-results', 't.txt')), `Ausgabe aus ${NEW}\n`);
  assert.equal(JSON.parse(read(P('sessions', 'local_k1.json'))).cwd, NEW);
  assert.deepEqual(untouched.map(sha), untouchedSha, 'andere Chats und Memory bleiben byte-gleich (kein "von NEW nach NEW")');
  assert.equal(read(P('history.jsonl')), jsonl([{ display: 'a', project: NEW }, { display: 'b', project: Y }]), 'nur die Historienzeile des Projekts');

  // 5. dauerhafte Sicherung der Originale, von Pull-Sicherungen unberuehrt
  const mapBackup = fs.readdirSync(backupsDir()).find((d) => d.startsWith('map-'));
  assert.ok(mapBackup, 'Sicherung map-... angelegt');
  assert.equal(read(path.join(backupsDir(), mapBackup, 'claude-projects', kOld, `${K1}.jsonl`)), origK1, 'Original gesichert');
  for (let i = 0; i < 3; i++) await makeBackup(cfg, quiet);
  const left = fs.readdirSync(backupsDir());
  assert.ok(left.includes(mapBackup), 'Pull-Sicherungen raeumen map-Sicherungen nicht weg');
  assert.equal(left.filter((d) => /^\d{4}-/.test(d)).length, 1, 'Pull-Sicherungen bleiben auf backupsToKeep begrenzt');

  // Pull danach: Dateien, die OLD nur erwaehnen, werden nicht "vorsorglich" umgeschrieben
  const warns = [];
  await pull(cfg, { noAsk: true }, { info() {}, debug() {}, warn: (s) => warns.push(s) });
  assert.deepEqual(untouched.map(sha), untouchedSha);
  assert.ok(warns.some((w) => w.includes('nicht verlustfrei')), warns.join('\n'));
});
