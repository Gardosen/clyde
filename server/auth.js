// Anmeldung: signierte Sitzungs-Cookies fuer das Dashboard, Bearer-Tokens fuer
// die Clients, Bremse gegen Passwort-Raten.
import crypto from 'node:crypto';

export const COOKIE = 'clyde_session';
const SESSION_MS = 7 * 24 * 3600e3;

const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');
const sign = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function makeSessionCookie(secret, { name, epoch }, secure) {
  const payload = b64(JSON.stringify({ u: name, e: epoch, x: Date.now() + SESSION_MS }));
  const value = `${payload}.${sign(secret, payload)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function readCookie(req, name = COOKIE) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Liefert {u, e} bei gueltigem, nicht abgelaufenem Cookie, sonst null
export function verifySessionCookie(secret, value) {
  if (!value) return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return null;
  const expected = sign(secret, payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(unb64(payload));
    if (typeof p.u !== 'string' || typeof p.x !== 'number' || p.x < Date.now()) return null;
    return p;
  } catch { return null; }
}

export function tokensEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Laeuft die Verbindung aussen per HTTPS (Traefik setzt X-Forwarded-Proto)?
export function isSecure(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

export function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '?';
}

// Hoechstens `max` Fehlversuche je Schluessel (IP) im Zeitfenster
export class LoginLimiter {
  constructor({ max = 10, windowMs = 15 * 60e3 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.fails = new Map();
  }
  blocked(key) {
    const f = this.fails.get(key);
    if (!f) return false;
    if (Date.now() - f.first > this.windowMs) { this.fails.delete(key); return false; }
    return f.count >= this.max;
  }
  fail(key) {
    const now = Date.now();
    const f = this.fails.get(key);
    if (!f || now - f.first > this.windowMs) this.fails.set(key, { first: now, count: 1 });
    else f.count++;
    if (this.fails.size > 10000) this.fails.clear();
  }
  success(key) { this.fails.delete(key); }
}
