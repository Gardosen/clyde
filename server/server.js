import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decodeBlobs, encodeBlob, isHash, sha256 } from '../src/framing.js';
import { Store, httpError, validId, manifestHashes } from './store.js';
import { Users, validUserName } from './users.js';
import { makeSessionCookie, clearSessionCookie, readCookie, verifySessionCookie, tokensEqual, isSecure, clientIp, LoginLimiter } from './auth.js';
import { dashboardHtml, chatsForSnapshot } from './dashboard.js';

async function readJson(req, limit = 256 * 1024 * 1024) {
  const parts = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw httpError(413, 'Body zu gross'); parts.push(c); }
  const t = Buffer.concat(parts).toString('utf8');
  try { return t ? JSON.parse(t) : {}; } catch { throw httpError(400, 'Ungueltiges JSON'); }
}
function send(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...headers });
  res.end(body);
}
function hashList(body) {
  const { hashes } = body;
  if (!Array.isArray(hashes) || hashes.length > 100000 || !hashes.every(isHash)) throw httpError(400, 'hashes ungueltig');
  return hashes;
}
const summary = (m) => ({ id: m.id, createdAt: m.createdAt, host: m.host, user: m.user, platform: m.platform, stats: m.stats });
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return 'unbekannt'; } })();

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

// Alte Einzelbenutzer-Ablage (<data>/blobs, <data>/snapshots) zum Admin verschieben
function migrateLegacy(dataDir, adminUser, log) {
  for (const sub of ['blobs', 'snapshots']) {
    const from = path.join(dataDir, sub);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dataDir, 'u', adminUser, sub);
    if (fs.existsSync(to) && fs.readdirSync(to).length) { log.log(`Alte Ablage ${from} bleibt liegen, ${to} ist nicht leer`); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
    log.log(`Alte Ablage ${sub} nach u/${adminUser}/${sub} verschoben`);
  }
}

// dataDir: Ablage; token: optionaler Alt-Token (gilt als Client-Token des Admins);
// adminUser/adminPassword: legen beim ersten Start den Admin an
export function createServer({ dataDir, token, adminUser = 'admin', adminPassword, log = console, loginLimit } = {}) {
  if (!validUserName(adminUser)) throw new Error(`Ungueltiger Admin-Name "${adminUser}"`);
  fs.mkdirSync(dataDir, { recursive: true });
  migrateLegacy(dataDir, adminUser, log);
  const users = new Users(dataDir);
  const limiter = new LoginLimiter(loginLimit);
  const ready = (async () => {
    if (users.count()) return;
    const pw = adminPassword || crypto.randomBytes(15).toString('base64url');
    await users.create(adminUser, pw, { admin: true });
    if (adminPassword) log.log(`Admin-Benutzer "${adminUser}" angelegt.`);
    else log.log(`Admin-Benutzer "${adminUser}" angelegt, Passwort: ${pw}  (im Dashboard aendern)`);
  })();

  const stores = new Map();
  const storeFor = (name) => {
    if (!validUserName(name)) throw httpError(400, 'Ungueltiger Benutzer');
    if (!stores.has(name)) stores.set(name, new Store(path.join(dataDir, 'u', name)));
    return stores.get(name);
  };
  const userDir = (name) => path.join(dataDir, 'u', name);

  function authenticate(req) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) {
      const t = h.slice(7).trim();
      if (token && tokensEqual(t, token)) return { name: adminUser, admin: true, via: 'token' };
      return users.userForToken(t);
    }
    const c = verifySessionCookie(users.secret, readCookie(req));
    if (!c) return null;
    const u = users.get(c.u);
    if (!u || (u.epoch || 1) !== c.e) return null;
    return { name: c.u, admin: !!u.admin, via: 'session' };
  }
  const needSession = (who) => { if (who.via !== 'session') throw httpError(403, 'Nur nach Anmeldung im Dashboard moeglich'); };
  const needAdmin = (who) => { needSession(who); if (!who.admin) throw httpError(403, 'Nur fuer Admins'); };

  async function handle(req, res) {
    await ready;
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;
    const secure = isSecure(req);

    if (p === '/health' && m === 'GET') return send(res, 200, { ok: true, service: 'clyde', version: VERSION });
    if ((p === '/' || p === '/dashboard') && m === 'GET') {
      const html = dashboardHtml();
      res.writeHead(200, { ...HTML_HEADERS, 'content-length': html.length });
      return res.end(html);
    }
    // Browser-Anfragen, die etwas aendern, muessen diesen Header tragen (Schutz vor CSRF)
    const fromDashboard = req.headers['x-clyde'] === '1';

    if (p === '/login' && m === 'POST') {
      if (!fromDashboard) throw httpError(403, 'Header X-Clyde fehlt');
      const ip = clientIp(req);
      if (limiter.blocked(ip)) throw httpError(429, 'Zu viele Fehlversuche, bitte 15 Minuten warten');
      const { user, password } = await readJson(req, 64 * 1024);
      const ok = await users.checkLogin(String(user || '').trim().toLowerCase(), String(password || ''));
      if (!ok) { limiter.fail(ip); throw httpError(401, 'Benutzername oder Passwort falsch'); }
      limiter.success(ip);
      log.log(`Anmeldung ${ok.name} von ${ip}`);
      return send(res, 200, { user: ok.name, admin: ok.admin }, { 'set-cookie': makeSessionCookie(users.secret, ok, secure) });
    }
    if (p === '/logout' && m === 'POST') return send(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie(secure) });

    const who = authenticate(req);
    if (!who) return send(res, 401, { error: 'Nicht angemeldet oder Token ungueltig' });
    if (who.via === 'session' && m !== 'GET' && !fromDashboard) throw httpError(403, 'Header X-Clyde fehlt');

    // --- eigenes Konto ---
    if (p === '/me' && m === 'GET') return send(res, 200, { user: who.name, admin: who.admin, via: who.via, tokens: users.tokens(who.name) });
    if (p === '/me/tokens' && m === 'POST') {
      needSession(who);
      const { label } = await readJson(req, 64 * 1024);
      return send(res, 200, users.addToken(who.name, label));
    }
    const tm = p.match(/^\/me\/tokens\/([a-f0-9]{1,32})$/);
    if (tm && m === 'DELETE') {
      needSession(who);
      if (!users.revokeToken(who.name, tm[1])) throw httpError(404, 'Token nicht gefunden');
      return send(res, 200, { ok: true });
    }
    if (p === '/me/password' && m === 'POST') {
      needSession(who);
      const { current, next } = await readJson(req, 64 * 1024);
      if (!(await users.checkLogin(who.name, String(current || '')))) throw httpError(403, 'Aktuelles Passwort stimmt nicht');
      await users.setPassword(who.name, String(next || ''));
      const u = users.get(who.name);
      return send(res, 200, { ok: true }, { 'set-cookie': makeSessionCookie(users.secret, { name: who.name, epoch: u.epoch }, secure) });
    }

    // --- Benutzerverwaltung (Admin) ---
    if (p === '/users' && m === 'GET') {
      needAdmin(who);
      const list = await Promise.all(users.list().map(async (u) => {
        let snapshots = 0;
        try { snapshots = (await fs.promises.readdir(path.join(userDir(u.name), 'snapshots'))).filter((f) => f.endsWith('.json')).length; } catch { /* leer */ }
        return { ...u, snapshots };
      }));
      return send(res, 200, { users: list });
    }
    if (p === '/users' && m === 'POST') {
      needAdmin(who);
      const { name, password, admin } = await readJson(req, 64 * 1024);
      const created = await users.create(String(name || '').trim().toLowerCase(), String(password || ''), { admin: !!admin });
      log.log(`Benutzer ${created.name} angelegt von ${who.name}`);
      return send(res, 200, created);
    }
    const um = p.match(/^\/users\/([a-z0-9._-]{1,40})(\/password)?$/);
    if (um) {
      needAdmin(who);
      const name = um[1];
      if (um[2] && m === 'POST') {
        const { password } = await readJson(req, 64 * 1024);
        await users.setPassword(name, String(password || ''));
        return send(res, 200, { ok: true });
      }
      if (!um[2] && m === 'DELETE') {
        if (name === who.name) throw httpError(400, 'Das eigene Konto kann nicht geloescht werden');
        if (!users.remove(name)) throw httpError(404, `Benutzer ${name} nicht gefunden`);
        stores.delete(name);
        await fs.promises.rm(userDir(name), { recursive: true, force: true });
        log.log(`Benutzer ${name} samt Daten geloescht von ${who.name}`);
        return send(res, 200, { ok: true });
      }
    }

    // --- Snapshots und Chunks: immer die eigenen; Admins duerfen lesend ?user= angeben ---
    const asked = url.searchParams.get('user');
    let target = who.name;
    if (asked && asked !== who.name) {
      if (!who.admin || m !== 'GET') throw httpError(403, 'Nur Admins duerfen fremde Snapshots ansehen');
      if (!users.get(asked)) throw httpError(404, `Benutzer ${asked} nicht gefunden`);
      target = asked;
    }
    const store = storeFor(target);

    const cm = p.match(/^\/snapshots\/([^/]+)\/chats$/);
    if (cm && m === 'GET') {
      const id = decodeURIComponent(cm[1]);
      const man = id === 'latest' ? (await store.listSnapshots())[0] : (validId(id) ? await store.getSnapshot(id) : null);
      if (!man) throw httpError(404, `Snapshot ${id} nicht gefunden`);
      return send(res, 200, await chatsForSnapshot(store, man));
    }
    if (p === '/blobs/missing' && m === 'POST') {
      return send(res, 200, { missing: await store.missing(hashList(await readJson(req))) });
    }
    if (p === '/blobs/upload' && m === 'POST') {
      let src = req;
      if (req.headers['content-encoding'] === 'gzip') { const g = zlib.createGunzip(); pipeline(req, g).catch((e) => g.destroy(e)); src = g; }
      let stored = 0, skipped = 0, bytes = 0;
      for await (const { hash, data } of decodeBlobs(src)) {
        if (sha256(data) !== hash) throw httpError(400, `Hash stimmt nicht: ${hash}`);
        bytes += data.length;
        if (await store.putBlob(hash, data)) stored++; else skipped++;
      }
      return send(res, 200, { stored, skipped, bytes });
    }
    if (p === '/blobs/fetch' && m === 'POST') {
      const hashes = hashList(await readJson(req));
      const missing = await store.missing(hashes);
      if (missing.length) return send(res, 404, { error: `${missing.length} Chunks fehlen auf dem Server`, missing: missing.slice(0, 20) });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' });
      const gen = (async function* () {
        for (const h of hashes) { const [hd, d] = encodeBlob(h, await store.getBlob(h)); yield hd; yield d; }
      })();
      await pipeline(Readable.from(gen), zlib.createGzip({ level: 6 }), res);
      return;
    }
    if (p === '/snapshots' && m === 'GET') return send(res, 200, { user: target, snapshots: (await store.listSnapshots()).map(summary) });

    const sm = p.match(/^\/snapshots\/([^/]+)$/);
    if (sm) {
      const id = decodeURIComponent(sm[1]);
      if (m === 'GET' && id === 'latest') {
        const all = await store.listSnapshots();
        if (!all.length) throw httpError(404, 'Noch kein Snapshot vorhanden');
        return send(res, 200, all[0]);
      }
      if (!validId(id)) throw httpError(400, 'Snapshot-ID ungueltig');
      if (m === 'GET') {
        const man = await store.getSnapshot(id);
        if (!man) throw httpError(404, `Snapshot ${id} nicht gefunden`);
        return send(res, 200, man);
      }
      if (m === 'PUT') {
        const man = await readJson(req);
        if (man.id !== id || ![1, 2].includes(man.version) || typeof man.roots !== 'object') throw httpError(400, 'Manifest ungueltig');
        const hashes = [...manifestHashes(man)];
        if (!hashes.every(isHash)) throw httpError(400, 'Chunk-Hash ungueltig');
        const missing = await store.missing(hashes);
        if (missing.length) return send(res, 409, { error: `${missing.length} Chunks fehlen auf dem Server, Push wiederholen`, missing: missing.slice(0, 20) });
        await store.putSnapshot(man);
        log.log(`Snapshot ${id} von ${man.host} fuer ${target} gespeichert (${man.stats?.files} Dateien)`);
        return send(res, 200, { ok: true, id });
      }
      if (m === 'DELETE') {
        if (!(await store.deleteSnapshot(id))) throw httpError(404, `Snapshot ${id} nicht gefunden`);
        return send(res, 200, { ok: true });
      }
    }
    if (p === '/gc' && m === 'POST') return send(res, 200, await store.gc());
    throw httpError(404, `Unbekannter Endpunkt ${m} ${p}`);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e.status || 500;
      if (status >= 500) log.error(e);
      if (!res.headersSent) send(res, status, { error: e.message });
      else res.destroy();
    });
  });
  server.requestTimeout = 0; // grosse Uploads ueber langsame Leitungen
  server.headersTimeout = 60000;
  server.ready = ready;
  return server;
}
