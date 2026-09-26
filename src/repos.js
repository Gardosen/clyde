// Git-Hilfen fuer die Repos der Chats (welches Repo zu welchem Chat gehoert und wo
// es je Geraet liegt, steht in src/refs.js).
//
// - inspectRepo: Stand eines Ordners (Remote, Branch, Aenderungen, Upstream)
// - applyRepos: vorhandene saubere Klone vorspulen (nur fast-forward); lokale
//   Aenderungen und eigene Commits werden nie angefasst
// - workItems, commitAndPush, pushRepo: Vergessenes vor dem Push nachholen
//
// Sicherheit: Zugangsdaten werden aus HTTP(S)-Adressen entfernt, bevor sie den PC
// verlassen. Geklont werden nur uebliche Adressen (https, ssh, git,
// user@host:pfad, absolute Pfade), nie "ext::" oder etwas, das wie eine Option
// aussieht. Git fragt nie im Terminal nach Passwoertern.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { canonicalize, localize, normalizeHome } from './rewrite.js';
import { pathBelongsTo, liveSessions, ownSession, describeSession } from './session.js';
import { isUnder } from './remap.js';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
export function git(args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-c', 'protocol.ext.allow=never', ...args], { timeout, env: GIT_ENV, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() });
    });
  });
}
let gitChecked = null;
export async function gitAvailable() {
  if (gitChecked === null) gitChecked = (await git(['--version'])).ok;
  return gitChecked;
}
const firstLine = (s) => String(s || '').split(/\r?\n/).filter(Boolean).pop() || 'unbekannter Fehler';

// Projektordner der Chats (aus der Chatliste der App), lokal; Clyde-Chats zaehlen nicht
export async function sidebarCwds(cfg) {
  const root = cfg.roots['desktop-sessions'];
  if (!root) return [];
  const names = [];
  const walk = async (dir) => {
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
      else if (e.name.endsWith('.json')) names.push(path.join(dir, e.name));
    }
  };
  await walk(root.path);
  const out = new Set();
  for (const f of names) {
    if (pathBelongsTo(path.basename(f), cfg.exclude)) continue;
    try {
      const j = JSON.parse(await fs.promises.readFile(f, 'utf8'));
      for (const k of ['cwd', 'originCwd']) if (typeof j[k] === 'string' && j[k]) out.add(normalizeHome(j[k]));
    } catch { /* kein JSON */ }
  }
  return [...out];
}

// Zugangsdaten aus der Adresse entfernen: bei http(s) den ganzen Benutzerteil,
// sonst nur ein Passwort (ssh://git@host bleibt nutzbar)
export function sanitizeRemote(url) {
  const s = String(url || '').trim();
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/@]*@)?(.*)$/i.exec(s);
  if (!m) return s;
  if (!m[2]) return s;
  if (/^https?$/i.test(m[1])) return `${m[1]}://${m[3]}`;
  return `${m[1]}://${m[2].replace(/:[^@]*@$/, '@')}${m[3]}`;
}

// Vergleichsschluessel: dasselbe Repo ueber https oder ssh ergibt denselben Schluessel
export function remoteKey(url) {
  const s = sanitizeRemote(url).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/, '');
  if (/^[a-z]:\//.test(s) || s.startsWith('/') || s.startsWith('file://')) return `file:${s.replace(/^file:\/\//, '')}`;
  let m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/.exec(s);
  if (m) return `${m[1]}/${m[2]}`;
  m = /^(?:[^@/]+@)?([^:/]+):(.*)$/.exec(s);
  if (m) return `${m[1]}/${m[2].replace(/^\/+/, '')}`;
  return s;
}

// Nur uebliche Adressen klonen
export function allowedRemote(u) {
  if (!u || typeof u !== 'string' || u.startsWith('-') || /[\r\n]/.test(u) || /^[a-z]+::/i.test(u)) return false;
  return /^(https?|ssh|git|file):\/\//i.test(u) || /^[\w.-]+@[\w.-]+:[^:]/.test(u) || path.isAbsolute(u);
}
const allowedBranch = (b) => typeof b === 'string' && /^[\w][\w./-]*$/.test(b) && !b.includes('..');

// Git-Stand eines Ordners (oder null, wenn er in keinem Repo liegt)
export async function inspectRepo(dir) {
  const top = await git(['-C', dir, 'rev-parse', '--show-toplevel']);
  if (!top.ok || !top.out) return null;
  const rootAbs = path.resolve(top.out);
  const root = normalizeHome(rootAbs);
  const run = (...a) => git(['-C', root, ...a]);
  const remotes = (await run('remote')).out.split(/\s+/).filter(Boolean);
  const name = remotes.includes('origin') ? 'origin' : remotes[0];
  const remote = name ? (await run('remote', 'get-url', name)).out : null;
  const branch = (await run('rev-parse', '--abbrev-ref', 'HEAD')).out || null;
  const head = (await run('rev-parse', 'HEAD')).out || null;
  const status = await run('status', '--porcelain');
  const lines = status.ok ? status.out.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean) : [];
  const upstream = await run('rev-parse', '--abbrev-ref', '@{u}');
  const count = async (range) => { const r = await run('rev-list', '--count', range); return r.ok ? Number(r.out) : null; };
  return {
    root, rootAbs, remote, remoteName: name || null, branch: branch === 'HEAD' ? null : branch, head,
    dirty: lines.filter((l) => !l.startsWith('??')).length, // geaenderte, versionierte Dateien
    untracked: lines.filter((l) => l.startsWith('??')).length, // neue, noch nicht versionierte
    files: lines.slice(0, 12),
    upstream: upstream.ok ? upstream.out : null,
    ahead: upstream.ok ? await count('@{u}..HEAD') : null,
    behind: upstream.ok ? await count('HEAD..@{u}') : null,
  };
}

// Zu weit gefasst: ein Repo im Home oder auf einem Laufwerk selbst wird nie geklont
export function tooBroad(rootAbs, home) {
  const r = path.resolve(rootAbs);
  return r === path.parse(r).root || r.toLowerCase() === path.resolve(home).toLowerCase();
}

// Pull: klonen und vorspulen. Liefert eine Zusammenfassung.
export async function applyRepos(actions, log) {
  const res = { cloned: [], updated: [], current: [], skipped: [], failed: [] };
  for (const a of actions) {
    if (a.action === 'skip') { res.skipped.push(`${a.local}: ${a.reason}`); continue; }
    if (a.action === 'clone') {
      log.info(`Git: klone ${a.remote} nach ${a.local} ...`);
      fs.mkdirSync(path.dirname(path.resolve(a.local)), { recursive: true });
      let r = await git(['clone', ...(a.branch ? ['--branch', a.branch] : []), '--', a.remote, a.local], { timeout: 0 });
      if (!r.ok && a.branch && /not found|nicht gefunden/i.test(r.err)) r = await git(['clone', '--', a.remote, a.local], { timeout: 0 });
      if (!r.ok) { res.failed.push(`${a.local}: ${firstLine(r.err)}`); log.warn(`Git: Klonen von ${a.remote} fehlgeschlagen: ${firstLine(r.err)}`); continue; }
      if (a.head && !(await git(['-C', a.local, 'cat-file', '-e', `${a.head}^{commit}`])).ok) {
        log.warn(`Git: ${a.local} ist geklont, aber der letzte Commit vom anderen PC (${a.head.slice(0, 10)}) liegt nicht auf dem Remote (dort nicht gepusht).`);
      }
      res.cloned.push(a.local);
      continue;
    }
    const f = await git(['-C', a.local, 'fetch', '--quiet'], { timeout: 0 });
    if (!f.ok) { res.failed.push(`${a.local}: ${firstLine(f.err)}`); log.warn(`Git: Holen fuer ${a.local} fehlgeschlagen: ${firstLine(f.err)}`); continue; }
    const info = await inspectRepo(a.local);
    if (!info) { res.failed.push(`${a.local}: kein Git-Repo mehr`); continue; }
    const why = !info.upstream ? `Branch ${info.branch || '(losgeloest)'} hat keinen Upstream`
      : info.dirty ? `${info.dirty} geaenderte Datei(en), nicht vorgespult`
        : info.ahead ? `${info.ahead} eigene Commit(s), nicht vorgespult` : null;
    if (why) { res.skipped.push(`${a.local}: ${why}`); continue; }
    if (!info.behind) { res.current.push(a.local); continue; }
    const m = await git(['-C', a.local, 'merge', '--ff-only', '--quiet', '@{u}']);
    if (!m.ok) { res.failed.push(`${a.local}: ${firstLine(m.err)}`); log.warn(`Git: Vorspulen von ${a.local} fehlgeschlagen: ${firstLine(m.err)}`); continue; }
    res.updated.push(`${a.local} (+${info.behind})`);
  }
  const parts = [res.cloned.length && `${res.cloned.length} geklont`, res.updated.length && `${res.updated.length} vorgespult`, res.current.length && `${res.current.length} aktuell`,
    res.skipped.length && `${res.skipped.length} uebersprungen`, res.failed.length && `${res.failed.length} fehlgeschlagen`].filter(Boolean);
  if (parts.length) log.info(`Git-Repos: ${parts.join(', ')}.`);
  for (const s of res.skipped) log.info(`  uebersprungen: ${s}`);
  if (res.failed.length) log.warn('Fuer Klonen und Holen braucht dieser PC Zugriff auf die Remotes (SSH-Schluessel oder Git-Anmeldung).');
  return res;
}

// Chats, die gerade in diesem Repo arbeiten (ausser dem aufrufenden): dort nie
// committen oder pushen, der Chat koennte mitten in einer Aenderung stecken
export function busyInRepo(root) {
  const own = ownSession();
  return liveSessions().filter((s) => s.sessionId !== own?.sessionId && s.status !== 'idle' && s.cwd && isUnder(s.cwd, root)).map(describeSession);
}

// Vor dem Push: Arbeit in diesen Repos, die nicht auf dem Remote liegt (geaenderte
// und neue Dateien, nicht gepushte Commits, Branch ohne Upstream). Liest nur.
export async function workItems(roots) {
  const items = [];
  const seen = new Set();
  for (const root of roots) {
    const r = root && fs.existsSync(root) ? await inspectRepo(root) : null;
    if (!r || seen.has(r.root)) continue;
    seen.add(r.root);
    const noUpstream = !!(r.branch && r.head && r.remote && !r.upstream);
    if (!(r.dirty || r.untracked || r.ahead || noUpstream || !r.remote)) continue;
    items.push({
      kind: 'work', repo: r.root, name: path.basename(r.rootAbs), remote: r.remote ? sanitizeRemote(r.remote) : null, branch: r.branch,
      upstream: r.upstream, changed: r.dirty, untracked: r.untracked, ahead: r.ahead || 0, noUpstream, noRemote: !r.remote, files: r.files,
      busyChats: busyInRepo(r.root),
    });
  }
  return items;
}

// Commits auf den Remote bringen; ohne Upstream mit -u. Kein Zusammenfuehren,
// kein Ueberschreiben: hat der Remote neuere Commits, bricht es mit Hinweis ab.
export async function pushRepo(dir, { force = false } = {}) {
  const info = await inspectRepo(dir);
  if (!info) throw new Error(`${dir} ist kein Git-Repo.`);
  const busy = busyInRepo(info.root);
  if (busy.length && !force) throw new Error(`${info.root}: Darin arbeitet gerade ${busy.join(', ')}; spaeter erneut.`);
  if (!info.remoteName) throw new Error(`${info.root} hat keinen Remote.`);
  if (!info.branch) throw new Error(`${info.root}: kein Branch ausgecheckt (losgeloester HEAD).`);
  const r = info.upstream ? await git(['-C', info.root, 'push'], { timeout: 0 }) : await git(['-C', info.root, 'push', '-u', info.remoteName, info.branch], { timeout: 0 });
  if (!r.ok) {
    if (/rejected|non-fast-forward|fetch first/i.test(r.err)) throw new Error(`${info.root}: Der Remote hat neuere Commits. Erst im Repo holen und zusammenfuehren (git pull), dann erneut.`);
    throw new Error(`${info.root}: git push fehlgeschlagen: ${firstLine(r.err)}`);
  }
  return { root: info.root, branch: info.branch };
}

// Alles committen (git add -A beachtet .gitignore) und pushen
export async function commitAndPush(dir, message, { force = false } = {}) {
  const info = await inspectRepo(dir);
  if (!info) throw new Error(`${dir} ist kein Git-Repo.`);
  const busy = busyInRepo(info.root);
  if (busy.length && !force) throw new Error(`${info.root}: Darin arbeitet gerade ${busy.join(', ')}; nicht committet.`);
  if (!info.branch) throw new Error(`${info.root}: kein Branch ausgecheckt (losgeloester HEAD).`);
  for (const ref of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']) {
    if ((await git(['-C', info.root, 'rev-parse', '-q', '--verify', ref])).ok) throw new Error(`${info.root}: Es laeuft gerade ein Merge oder Rebase; bitte erst im Repo abschliessen.`);
  }
  const msg = String(message || '').trim() || `Stand von ${os.hostname()} (${new Date().toISOString().slice(0, 16).replace('T', ' ')}), ueber Clyde`;
  let committed = false;
  if (info.dirty || info.untracked) {
    const a = await git(['-C', info.root, 'add', '-A']);
    if (!a.ok) throw new Error(`${info.root}: git add fehlgeschlagen: ${firstLine(a.err)}`);
    const c = await git(['-C', info.root, 'commit', '-m', msg], { timeout: 0 });
    if (!c.ok) throw new Error(`${info.root}: git commit fehlgeschlagen: ${firstLine(c.err || c.out)}`);
    committed = true;
  }
  const p = await pushRepo(info.root, { force });
  return { ...p, committed, message: committed ? msg : null };
}
