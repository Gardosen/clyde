import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createServer } = await import('../server/server.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-auth-'));
const DATA = path.join(tmp, 'data');

// Alte Einzelbenutzer-Ablage, die beim Start zum Admin wandern muss
fs.mkdirSync(path.join(DATA, 'snapshots'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'blobs'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'snapshots', 'alt-1.json'), JSON.stringify({ version: 2, id: 'alt-1', createdAt: '2026-01-01T00:00:00.000Z', host: 'h', user: 'u', roots: {}, stats: { files: 0, bytes: 0, chunks: 0 } }));

const logs = [];
const server = createServer({ dataDir: DATA, token: 'legacy-token', adminUser: 'marco', adminPassword: 'admin-passwort-1', loginLimit: { max: 3, windowMs: 60e3 }, log: { log: (s) => logs.push(s), error: console.error } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Kleiner Browser: merkt sich das Sitzungs-Cookie
function browser() {
  let cookie = '';
  return async (method, p, body, { csrf = true, ip } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (csrf) headers['x-clyde'] = '1';
    if (cookie) headers.cookie = cookie;
    if (ip) headers['x-forwarded-for'] = ip;
    const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, setCookie: set };
  };
}
const bearer = (tok) => async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const emptySnap = (id) => ({ version: 2, id, createdAt: new Date().toISOString(), host: 'pc', user: 'x', roots: {}, stats: { files: 0, bytes: 0, chunks: 0 } });

test('alte Ablage wandert zum Admin, Alt-Token gilt fuer ihn', async () => {
  assert.ok(fs.existsSync(path.join(DATA, 'u', 'marco', 'snapshots', 'alt-1.json')));
  assert.ok(!fs.existsSync(path.join(DATA, 'snapshots')));
  const r = await bearer('legacy-token')('GET', '/snapshots');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.snapshots.map((s) => s.id), ['alt-1']);
  assert.ok(logs.some((l) => l.includes('Admin-Benutzer "marco" angelegt')));
  assert.ok(!logs.some((l) => l.includes('admin-passwort-1')), 'vorgegebenes Passwort darf nicht im Log stehen');
});

test('Dashboard-Seite ist oeffentlich, Daten nicht', async () => {
  const html = await fetch(BASE + '/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(BASE + '/snapshots')).status, 401);
  assert.equal((await fetch(BASE + '/me')).status, 401);
});

test('Login: falsches Passwort, fehlender CSRF-Header, Erfolg mit sicherem Cookie', async () => {
  const b = browser();
  assert.equal((await b('POST', '/login', { user: 'marco', password: 'falsch-falsch' })).status, 401);
  assert.equal((await b('POST', '/login', { user: 'marco', password: 'admin-passwort-1' }, { csrf: false })).status, 403);
  const ok = await b('POST', '/login', { user: 'Marco', password: 'admin-passwort-1' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { user: 'marco', admin: true });
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Strict/);
  const me = await b('GET', '/me');
  assert.equal(me.body.user, 'marco');
  assert.equal(me.body.via, 'session');
});

test('Cookie hinter HTTPS-Proxy bekommt Secure', async () => {
  const r = await fetch(BASE + '/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-clyde': '1', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ user: 'marco', password: 'admin-passwort-1' }) });
  assert.match(r.headers.get('set-cookie'), /; Secure/);
});

test('Sperre nach zu vielen Fehlversuchen je IP', async () => {
  const b = browser();
  for (let i = 0; i < 3; i++) assert.equal((await b('POST', '/login', { user: 'marco', password: 'nein-nein-nein' }, { ip: '10.9.9.9' })).status, 401);
  assert.equal((await b('POST', '/login', { user: 'marco', password: 'admin-passwort-1' }, { ip: '10.9.9.9' })).status, 429);
  assert.equal((await b('POST', '/login', { user: 'marco', password: 'admin-passwort-1' }, { ip: '10.1.1.1' })).status, 200, 'andere IP nicht betroffen');
});

let bobToken;
test('Admin legt Benutzer an, Benutzer erzeugt eigenen Client-Token', async () => {
  const admin = browser();
  await admin('POST', '/login', { user: 'marco', password: 'admin-passwort-1' });
  assert.equal((await admin('POST', '/users', { name: 'bob', password: 'kurz' })).status, 400);
  assert.equal((await admin('POST', '/users', { name: 'bob', password: 'bobs-passwort-1' })).status, 200);
  assert.equal((await admin('POST', '/users', { name: 'bob', password: 'bobs-passwort-1' })).status, 409);
  const bob = browser();
  assert.equal((await bob('POST', '/login', { user: 'bob', password: 'bobs-passwort-1' })).status, 200);
  assert.equal((await bob('GET', '/users')).status, 403, 'bob ist kein Admin');
  assert.equal((await bob('POST', '/me/tokens', { label: 'Laptop' }, { csrf: false })).status, 403, 'ohne CSRF-Header');
  const t = await bob('POST', '/me/tokens', { label: 'Laptop' });
  assert.equal(t.status, 200);
  assert.match(t.body.token, /^clyde_/);
  bobToken = t.body.token;
  const me = await bob('GET', '/me');
  assert.equal(me.body.tokens.length, 1);
  assert.equal(me.body.tokens[0].label, 'Laptop');
  assert.ok(!JSON.stringify(me.body).includes(bobToken), 'Token wird nur einmal gezeigt');
  const users = await admin('GET', '/users');
  assert.deepEqual(users.body.users.map((u) => [u.name, u.admin, u.snapshots]), [['bob', false, 0], ['marco', true, 1]]);
});

test('Benutzer sind getrennt, Admin darf lesend hineinsehen', async () => {
  const bob = bearer(bobToken);
  assert.equal((await bob('PUT', '/snapshots/bob-1', emptySnap('bob-1'))).status, 200);
  assert.deepEqual((await bob('GET', '/snapshots')).body.snapshots.map((s) => s.id), ['bob-1']);
  assert.equal((await bob('GET', '/snapshots/alt-1')).status, 404, 'bob sieht marcos Snapshot nicht');
  assert.equal((await bob('GET', '/snapshots?user=marco')).status, 403);
  assert.equal((await bob('POST', '/me/tokens', { label: 'x' })).status, 403, 'Client-Token darf keine Tokens erzeugen');
  const admin = bearer('legacy-token');
  assert.deepEqual((await admin('GET', '/snapshots')).body.snapshots.map((s) => s.id), ['alt-1']);
  assert.deepEqual((await admin('GET', '/snapshots?user=bob')).body.snapshots.map((s) => s.id), ['bob-1']);
  assert.equal((await admin('DELETE', '/snapshots/bob-1?user=bob')).status, 403, 'fremde Daten nur lesend');
  assert.ok(fs.existsSync(path.join(DATA, 'u', 'bob', 'snapshots', 'bob-1.json')));
});

test('Token widerrufen, Passwort aendern meldet alte Sitzungen ab', async () => {
  const bob = browser();
  await bob('POST', '/login', { user: 'bob', password: 'bobs-passwort-1' });
  const other = browser();
  await other('POST', '/login', { user: 'bob', password: 'bobs-passwort-1' });
  const me = await bob('GET', '/me');
  assert.equal((await bob('DELETE', `/me/tokens/${me.body.tokens[0].id}`)).status, 200);
  assert.equal((await bearer(bobToken)('GET', '/snapshots')).status, 401);
  assert.equal((await bob('POST', '/me/password', { current: 'falsch-falsch', next: 'neues-passwort-1' })).status, 403);
  assert.equal((await bob('POST', '/me/password', { current: 'bobs-passwort-1', next: 'neues-passwort-1' })).status, 200);
  assert.equal((await bob('GET', '/me')).status, 200, 'eigene Sitzung bekommt neues Cookie');
  assert.equal((await other('GET', '/me')).status, 401, 'andere Sitzungen sind abgemeldet');
  assert.equal((await other('POST', '/logout')).status, 200);
});

test('Admin loescht Benutzer samt Daten, nicht sich selbst', async () => {
  const admin = browser();
  await admin('POST', '/login', { user: 'marco', password: 'admin-passwort-1' });
  assert.equal((await admin('DELETE', '/users/marco')).status, 400);
  assert.equal((await admin('DELETE', '/users/bob')).status, 200);
  assert.ok(!fs.existsSync(path.join(DATA, 'u', 'bob')));
  const bob = browser();
  assert.equal((await bob('POST', '/login', { user: 'bob', password: 'neues-passwort-1' })).status, 401);
});
