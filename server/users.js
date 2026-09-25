// Benutzerkonten des Servers: Passwort fuer das Dashboard, beliebig viele
// Client-Tokens fuer die PCs. Gespeichert in <data>/users.json; Passwoerter als
// scrypt-Hash, Tokens nur als SHA-256. Die Datei wird bei jeder Nutzung auf
// Aenderungen geprueft, damit auch server/admin.js im laufenden Betrieb wirkt.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const MIN_PASSWORD = 10;
export const validUserName = (n) => typeof n === 'string' && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(n);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, key] = parts;
  const expected = Buffer.from(key, 'base64');
  const got = await scrypt(String(pw), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

export function newToken() {
  return `clyde_${crypto.randomBytes(24).toString('base64url')}`;
}

export class Users {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'users.json');
    this.mtime = -1;
    this.data = null;
    this.refresh();
  }

  refresh() {
    let st = null;
    try { st = fs.statSync(this.file); } catch { /* neu */ }
    if (st && st.mtimeMs === this.mtime) return;
    if (!st) {
      this.data = { version: 1, secret: crypto.randomBytes(32).toString('hex'), users: {} };
      this.save();
      return;
    }
    this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.mtime = st.mtimeMs;
    this.index();
  }

  index() {
    this.byToken = new Map();
    for (const [name, u] of Object.entries(this.data.users)) {
      for (const t of u.tokens || []) this.byToken.set(t.hash, { user: name, id: t.id });
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.mtime = fs.statSync(this.file).mtimeMs;
    this.index();
  }

  get secret() { this.refresh(); return this.data.secret; }
  count() { this.refresh(); return Object.keys(this.data.users).length; }
  get(name) { this.refresh(); return this.data.users[name] || null; }
  names() { this.refresh(); return Object.keys(this.data.users).sort(); }

  list() {
    this.refresh();
    return Object.entries(this.data.users)
      .map(([name, u]) => ({ name, admin: !!u.admin, createdAt: u.createdAt, tokens: (u.tokens || []).length }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(name, password, { admin = false } = {}) {
    this.refresh();
    if (!validUserName(name)) throw Object.assign(new Error('Benutzername: 1-40 Zeichen, a-z, 0-9, . _ -'), { status: 400 });
    if (this.data.users[name]) throw Object.assign(new Error(`Benutzer ${name} gibt es schon`), { status: 409 });
    if (String(password || '').length < MIN_PASSWORD) throw Object.assign(new Error(`Passwort braucht mindestens ${MIN_PASSWORD} Zeichen`), { status: 400 });
    this.data.users[name] = { admin: !!admin, pw: await hashPassword(password), epoch: 1, createdAt: new Date().toISOString(), tokens: [] };
    this.save();
    return { name, admin: !!admin };
  }

  async setPassword(name, password) {
    this.refresh();
    const u = this.data.users[name];
    if (!u) throw Object.assign(new Error(`Benutzer ${name} nicht gefunden`), { status: 404 });
    if (String(password || '').length < MIN_PASSWORD) throw Object.assign(new Error(`Passwort braucht mindestens ${MIN_PASSWORD} Zeichen`), { status: 400 });
    u.pw = await hashPassword(password);
    u.epoch = (u.epoch || 1) + 1; // meldet alle Browser-Sitzungen ab
    this.save();
  }

  setAdmin(name, admin) {
    this.refresh();
    const u = this.data.users[name];
    if (!u) throw Object.assign(new Error(`Benutzer ${name} nicht gefunden`), { status: 404 });
    u.admin = !!admin;
    this.save();
  }

  remove(name) {
    this.refresh();
    if (!this.data.users[name]) return false;
    delete this.data.users[name];
    this.save();
    return true;
  }

  // Prueft Name und Passwort; rechnet auch bei unbekanntem Namen einen Hash,
  // damit die Antwortzeit nichts verraet
  async checkLogin(name, password) {
    const u = this.get(name);
    if (!u) { await verifyPassword(password, this.dummy ||= await hashPassword('dummy-password')); return null; }
    return (await verifyPassword(password, u.pw)) ? { name, admin: !!u.admin, epoch: u.epoch || 1 } : null;
  }

  addToken(name, label) {
    this.refresh();
    const u = this.data.users[name];
    if (!u) throw Object.assign(new Error(`Benutzer ${name} nicht gefunden`), { status: 404 });
    const token = newToken();
    const entry = { id: crypto.randomBytes(6).toString('hex'), hash: sha256(token), label: String(label || 'PC').slice(0, 60), createdAt: new Date().toISOString(), lastUsedAt: null };
    u.tokens = [...(u.tokens || []), entry];
    this.save();
    return { id: entry.id, label: entry.label, token };
  }

  tokens(name) {
    const u = this.get(name);
    return (u?.tokens || []).map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt }));
  }

  revokeToken(name, id) {
    this.refresh();
    const u = this.data.users[name];
    if (!u) return false;
    const before = (u.tokens || []).length;
    u.tokens = (u.tokens || []).filter((t) => t.id !== id);
    if (u.tokens.length === before) return false;
    this.save();
    return true;
  }

  // Client-Token -> Benutzer; merkt sich die letzte Nutzung (hoechstens stuendlich gespeichert)
  userForToken(token) {
    this.refresh();
    const hit = this.byToken.get(sha256(String(token)));
    if (!hit) return null;
    const u = this.data.users[hit.user];
    if (!u) return null;
    const t = u.tokens.find((x) => x.id === hit.id);
    const now = Date.now();
    if (t && (!t.lastUsedAt || now - Date.parse(t.lastUsedAt) > 3600e3)) { t.lastUsedAt = new Date(now).toISOString(); this.save(); }
    return { name: hit.user, admin: !!u.admin, via: 'token' };
  }
}
