// Zusammenfuehren: jedes Clyde-Konto hat eine eigene Sammlung, in die alle seine
// PCs ihre Chats einbringen. Konten sehen sich nie gegenseitig.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLYDE_QUIET = '1';
process.env.CLYDE_SKIP_GUARD = '1';
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_CODE_HOST_SESSION_ID;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-merge-'));
process.env.CLYDE_HOME = path.join(tmp, 'clydehome');

const { createServer } = await import('../server/server.js');
const { Users } = await import('../server/users.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { push, pull } = await import('../src/commands.js');
const { mergeSnapshots } = await import('../src/sync.js');
const { Client } = await import('../src/client.js');
const { sha256 } = await import('../src/framing.js');
const { log } = await import('../src/log.js');

const DATA = path.join(tmp, 'server');
const server = createServer({ dataDir: DATA, token: 'marco-token', adminUser: 'marco', adminPassword: 'x'.repeat(12), gcGraceMs: 0, log: { log() {}, error: console.error } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
await server.ready;
const users = new Users(DATA);
await users.create('frau', 'y'.repeat(12));
const FRAU = users.addToken('frau', 'PC').token;

const W = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d); };
const R = (p) => fs.readFileSync(p, 'utf8');
const pc = (name) => path.join(tmp, name);
function cfgOf(dir, token, home, extra = {}) {
  saveConfig({
    server: URL_, token, home,
    roots: {
      'claude-projects': path.join(dir, 'projects'), 'desktop-sessions': path.join(dir, 'sessions'),
      'claude-history': false, 'claude-file-history': false, 'claude-todos': false, 'claude-plans': false,
    },
    ...extra,
  });
  return loadConfig();
}
// Ein Chat = Transkript im Projektordner + Eintrag in der Chatliste
function chat(dir, id, title, lines, cwd = 'D:\\\\Spiele\\\\X') {
  const key = cwd.replace(/\\\\/g, '\\').replace(/[^A-Za-z0-9]/g, '-');
  W(path.join(dir, 'projects', key, `${id}.jsonl`), lines.map((l) => JSON.stringify({ text: l })).join('\n') + '\n');
  W(path.join(dir, 'sessions', 'org', 'acct', `local_${id}.json`), `{"sessionId":"local_${id}","cliSessionId":"${id}","title":"${title}","cwd":"${cwd}"}`);
  return path.join(dir, 'projects', key, `${id}.jsonl`);
}
const chatsOn = (dir) => {
  const d = path.join(dir, 'sessions', 'org', 'acct');
  return fs.existsSync(d) ? fs.readdirSync(d).map((f) => JSON.parse(R(path.join(d, f))).title).sort() : [];
};
const HOME1 = 'C:\\Users\\warro';
const HOME2 = 'C:\\Users\\marco';

const A1 = pc('Marco-PC1');
const A2 = pc('Marco-PC2');
const F1 = pc('Frau-PC1');
const F2 = pc('Frau-PC2');
const a1 = () => cfgOf(A1, 'marco-token', HOME1, { projectDrive: 'D' });
const a2 = () => cfgOf(A2, 'marco-token', HOME2, { projectDrive: 'D' });
const f1 = () => cfgOf(F1, FRAU, 'C:\\Users\\anna', { projectDrive: 'D' });
const f2 = () => cfgOf(F2, FRAU, 'C:\\Users\\anna', { projectDrive: 'D' });

chat(A1, 'aaaa-1', 'Aegis', ['a1 eins']);
chat(A1, 'aaaa-2', 'Lunia', ['a2 eins']);
chat(A2, 'bbbb-1', 'Talesweaver', ['b1 eins']);
chat(F1, 'ffff-1', 'Rezepte', ['f1 eins']);
chat(F2, 'ffff-2', 'Urlaub', ['f2 eins']);

test('Ersteinrichtung: vorhandene Chats aller PCs landen in der Sammlung des Kontos', async () => {
  await push(a1(), {}, log);
  const r = await push(a2(), {}, log);
  assert.ok(!r.unchanged);
  assert.deepEqual(chatsOn(A2), ['Talesweaver'], 'Push aendert lokal nichts');
  await pull(a1(), { noAsk: true }, log);
  await pull(a2(), { noAsk: true }, log);
  assert.deepEqual(chatsOn(A1), ['Aegis', 'Lunia', 'Talesweaver']);
  assert.deepEqual(chatsOn(A2), ['Aegis', 'Lunia', 'Talesweaver']);
  assert.ok(fs.existsSync(path.join(A2, 'projects', 'D--Spiele-X', 'aaaa-1.jsonl')));
});

test('Konten sind getrennt: die Chats der Frau sieht Marco nie und umgekehrt', async () => {
  await push(f1(), {}, log);
  await push(f2(), {}, log);
  await pull(f1(), { noAsk: true }, log);
  await pull(f2(), { noAsk: true }, log);
  assert.deepEqual(chatsOn(F1), ['Rezepte', 'Urlaub']);
  assert.deepEqual(chatsOn(F2), ['Rezepte', 'Urlaub']);
  assert.deepEqual(chatsOn(A1), ['Aegis', 'Lunia', 'Talesweaver']);
  const marco = JSON.stringify(await new Client(URL_, 'marco-token').getSnapshot('latest'));
  const frau = JSON.stringify(await new Client(URL_, FRAU).getSnapshot('latest'));
  assert.ok(!marco.includes('ffff') && !frau.includes('aaaa') && !frau.includes('bbbb'));
});

test('Nichts Neues: zweiter Push legt keinen Stand an', async () => {
  const before = (await new Client(URL_, 'marco-token').listSnapshots()).snapshots.length;
  const r = await push(a1(), {}, log);
  assert.equal(r.unchanged, true);
  assert.equal((await new Client(URL_, 'marco-token').listSnapshots()).snapshots.length, before);
});

test('Loeschen auf einem PC wirkt auf den anderen, fremde Chats bleiben', async () => {
  fs.rmSync(path.join(A1, 'projects', 'D--Spiele-X', 'aaaa-2.jsonl'));
  fs.rmSync(path.join(A1, 'sessions', 'org', 'acct', 'local_aaaa-2.json'));
  await push(a1(), {}, log);
  const r = await pull(a2(), { noAsk: true }, log);
  assert.equal(r.changed, true);
  assert.deepEqual(chatsOn(A2), ['Aegis', 'Talesweaver']);
});

test('Auf beiden PCs weitergefuehrter Chat: Zeilen beider Seiten bleiben erhalten', async () => {
  fs.appendFileSync(path.join(A1, 'projects', 'D--Spiele-X', 'aaaa-1.jsonl'), JSON.stringify({ text: 'von PC1' }) + '\n');
  fs.appendFileSync(path.join(A2, 'projects', 'D--Spiele-X', 'aaaa-1.jsonl'), JSON.stringify({ text: 'von PC2' }) + '\n');
  await push(a1(), {}, log);
  await push(a2(), {}, log);
  await pull(a1(), { noAsk: true }, log);
  const t = R(path.join(A1, 'projects', 'D--Spiele-X', 'aaaa-1.jsonl'));
  assert.ok(t.includes('von PC1') && t.includes('von PC2') && t.includes('a1 eins'), t);
  assert.equal(t.split('a1 eins').length, 2, 'gemeinsame Zeilen nur einmal');
});

test('Dritter Rechner ohne Laufwerke (wie ein MacBook): holt alles, legt Projektordner an', async () => {
  const MAC = pc('MacBook');
  fs.mkdirSync(path.join(MAC, 'projects'), { recursive: true });
  const cfg = cfgOf(MAC, 'marco-token', '/Users/marco');
  const where = path.join(MAC, 'ClydeProjekte');
  const r = await pull(cfg, { createMissing: where, noAsk: true }, log);
  assert.equal(r.changed, true);
  assert.deepEqual(chatsOn(MAC), ['Aegis', 'Talesweaver']);
  assert.ok(fs.existsSync(path.join(where, 'X')), 'fehlender Projektordner angelegt');
  const entry = JSON.parse(R(path.join(MAC, 'sessions', 'org', 'acct', 'local_aaaa-1.json')));
  assert.equal(entry.cwd, path.join(where, 'X'), 'Chat zeigt auf den angelegten Ordner');
  assert.equal((await push(loadConfig(), {}, log)).unchanged, true, 'Zuordnung aendert die neutrale Form nicht');
});

test('Fehlender Projektordner: Meldung nennt die Chats, Zuordnung per map --add --create verschiebt vorhandene Chats', async () => {
  const P = pc('PC-ohne-D');
  fs.mkdirSync(path.join(P, 'projects'), { recursive: true });
  const warned = [];
  const quiet = { info() {}, debug() {}, warn: (s) => warned.push(s), error() {} };
  const { map } = await import('../src/commands-misc.js');
  await pull(cfgOf(P, 'marco-token', HOME2), { noAsk: true }, quiet);
  const w = warned.find((x) => x.includes('gibt es hier nicht')) || '';
  assert.ok(w.includes('Chats: ') && w.includes('Aegis') && w.includes('Talesweaver'), w);
  const canon = /clyde map --add "([^"]+)"/.exec(w)[1];
  assert.deepEqual(chatsOn(P), ['Aegis', 'Talesweaver'], 'Chats kommen auch ohne Ordner');
  const target = path.join(P, 'Spiele', 'X');
  const before = fs.readdirSync(path.join(P, 'projects')).sort();
  await assert.rejects(map(loadConfig(), { add: true, create: true, noAsk: true, args: [canon, target] }, quiet), /--yes/, 'ohne Bestaetigung wird nichts umgestellt');
  assert.deepEqual(fs.readdirSync(path.join(P, 'projects')).sort(), before);
  assert.ok(!fs.existsSync(target) && !Object.keys(loadConfig().pathMap).length, 'weder Ordner noch Zuordnung');
  await map(loadConfig(), { add: true, create: true, dryRun: true, args: [canon, target] }, quiet);
  assert.ok(!fs.existsSync(target), 'Trockenlauf legt nichts an');
  await map(loadConfig(), { add: true, create: true, yes: true, args: [canon, target] }, quiet);
  assert.ok(fs.existsSync(target), '--create legt den Ordner an');
  assert.ok(fs.existsSync(path.join(P, 'projects', target.replace(/[^A-Za-z0-9]/g, '-'), 'aaaa-1.jsonl')), 'vorhandener Chat an den zugeordneten Ort verschoben');
  assert.equal(JSON.parse(R(path.join(P, 'sessions', 'org', 'acct', 'local_aaaa-1.json'))).cwd, target);
  assert.equal((await push(loadConfig(), {}, log)).unchanged, true, 'neutrale Form unveraendert');
});

test('Zwei alte, getrennte Staende lassen sich zu einem fusionieren', async () => {
  const c = new Client(URL_, FRAU);
  const put = async (id, files, m) => {
    const blobs = Object.values(files).map((txt) => Buffer.from(txt));
    await c.upload(blobs.map((data) => ({ hash: sha256(data), data })));
    const list = Object.entries(files).map(([p, txt]) => ({ p, s: Buffer.byteLength(txt), m, c: [sha256(Buffer.from(txt))] }));
    await c.putSnapshot({ version: 2, id, createdAt: new Date(m).toISOString(), host: id, user: 'anna', home: 'C:\\Users\\anna', roots: { 'claude-projects': { kind: 'dir', files: list, links: [] } }, stats: { files: list.length, bytes: 0, chunks: list.length } });
  };
  await put('20300101-000000000-alt-pc1', { 'k/eins.jsonl': 'a\nb\n', 'k/gemeinsam.jsonl': 'x\n' }, 1000);
  await put('20300101-000000001-alt-pc2', { 'k/zwei.jsonl': 'c\n', 'k/gemeinsam.jsonl': 'y\n' }, 2000);
  const { manifest } = await mergeSnapshots(f1(), { args: ['20300101-000000000-alt-pc1', '20300101-000000001-alt-pc2'] }, log);
  const paths = manifest.roots['claude-projects'].files.map((f) => f.p);
  assert.ok(['k/eins.jsonl', 'k/zwei.jsonl', 'k/gemeinsam.jsonl'].every((p) => paths.includes(p)));
  const latest = await c.getSnapshot('latest');
  assert.equal(latest.id, manifest.id);
  assert.deepEqual(latest.mergedFrom, ['20300101-000000000-alt-pc1', '20300101-000000001-alt-pc2']);
  const g = latest.roots['claude-projects'].files.find((f) => f.p === 'k/gemeinsam.jsonl');
  const body = [];
  await c.fetchBlobs(g.c, async ({ data }) => body.push(data));
  assert.equal(Buffer.concat(body).toString(), 'y\nx\n', 'beide Zeilen, neuere Seite zuerst');
});

test('Gleichzeitiger Push: der Server nimmt nur einen Stand auf dem aktuellen Stand an', async () => {
  const c = new Client(URL_, 'marco-token');
  const latest = await c.getSnapshot('latest');
  const stale = { ...latest, id: '20990101-000000000-alt', parent: 'gibt-es-nicht' };
  await assert.rejects(c.putSnapshot(stale), /409.*geaendert/);
});
