// Verweise: welcher Chat zu welchem Git-Repo gehoert und wo das Repo auf jedem
// Geraet liegt. Kein Durchsuchen von Ordnern: Clyde schaut nur in den
// Arbeitsordner (cwd) jedes Chats.
//
// Die Verweise liegen auf dem Server als eigenes Dokument je Benutzer (refs.json)
// mit Revision, unabhaengig von den Staenden. So lassen sie sich im Dashboard
// bearbeiten; gleichzeitige Aenderungen fuehren zu einem Konflikt statt zu
// stillem Ueberschreiben.
//
//   repos:   { <key>: { remote, name, branch, head, root (neutral),
//                       locations: { <deviceId>: { device, path, status, by, at } } } }
//   chats:   { <local_id>: { repo: <key>, sub, by, at } }
//   devices: { <deviceId>: { name, platform, home, projectDrive, pathMap, memory, seenAt } }
//
// key = Remote ohne Zugangsdaten und Schema (github.com/gardosen/clyde).
// status: ok | unverified (im Dashboard gesetzt, noch nicht geprueft) | missing |
//         not-a-repo | wrong-remote | skipped
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { saveConfig, configFromRaw } from './config.js';
import { git, gitAvailable, inspectRepo, remoteKey, sanitizeRemote, allowedRemote, tooBroad } from './repos.js';
import { canonicalize, localize, normalizeHome } from './rewrite.js';
import { pathBelongsTo } from './session.js';
import { isUnder, changeMapping } from './remap.js';

const now = () => new Date().toISOString();
const firstLine = (s) => String(s || '').split(/\r?\n/).filter(Boolean).pop() || 'unbekannter Fehler';

// Dieses Geraet: feste ID in ~/.clyde/config.json, Name = Rechnername
export function device(cfg) {
  let id = cfg.raw?.deviceId;
  if (!id) {
    id = crypto.randomUUID();
    cfg.raw = { ...(cfg.raw || {}), deviceId: id };
    saveConfig(cfg.raw);
  }
  return { id, name: os.hostname() };
}

// Chats dieses PCs (Clyde-Chats ausgenommen) mit Titel und Arbeitsordner
export async function localChats(cfg) {
  const root = cfg.roots['desktop-sessions'];
  const out = [];
  if (!root) return out;
  const walk = async (dir) => {
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.name.startsWith('local_') || !e.name.endsWith('.json') || pathBelongsTo(e.name, cfg.exclude || [])) continue;
      try {
        const j = JSON.parse(await fs.promises.readFile(p, 'utf8'));
        out.push({ id: e.name.slice(0, -5), title: j.title || e.name.slice(0, -5), cwd: typeof j.cwd === 'string' && j.cwd ? normalizeHome(j.cwd) : null });
      } catch { /* kein Eintrag */ }
    }
  };
  await walk(root.path);
  return out;
}

// Memory-Ordner der Projekte, die auf ein anderes Ziel zeigen (Junction/Symlink)
const UNC = String.fromCharCode(92, 92, 63, 92);
function memoryLinks(cfg) {
  const root = cfg.roots['claude-projects'];
  const out = {};
  let dirs = [];
  try { dirs = fs.readdirSync(root.path, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()); } catch { return out; }
  for (const d of dirs) {
    const m = path.join(root.path, d.name, 'memory');
    try {
      if (!fs.lstatSync(m).isSymbolicLink()) continue;
      let t = fs.readlinkSync(m);
      if (t.startsWith(UNC)) t = t.slice(UNC.length);
      out[canonicalize(d.name, cfg.forms)] = canonicalize(normalizeHome(t), cfg.forms);
    } catch { /* kein Link */ }
  }
  return out;
}

// Was dieser PC selbst weiss: Repos, in denen seine Chats arbeiten
export async function localFacts(cfg) {
  const chats = await localChats(cfg);
  const repos = new Map();
  const links = new Map();
  if (!(await gitAvailable())) return { chats, repos, links };
  const known = [];
  const notRepo = new Set();
  for (const c of chats) {
    if (!c.cwd || notRepo.has(c.cwd) || !fs.existsSync(c.cwd)) continue;
    let info = known.find((i) => isUnder(c.cwd, i.root));
    if (!info) {
      info = await inspectRepo(c.cwd);
      if (!info || !info.remote || tooBroad(info.rootAbs, cfg.home)) { notRepo.add(c.cwd); continue; }
      known.push(info);
    }
    const key = remoteKey(info.remote);
    if (!repos.has(key)) {
      repos.set(key, { key, remote: sanitizeRemote(info.remote), name: path.basename(info.rootAbs), root: info.root, rootCanonical: canonicalize(info.root, cfg.forms), branch: info.branch, head: info.head, info });
    }
    const sub = path.relative(info.rootAbs, path.resolve(c.cwd)).split(path.sep).join('/');
    links.set(c.id, { repo: key, sub });
  }
  return { chats, repos, links };
}

// Liegt unter p das Repo mit diesem Schluessel?
export async function verifyLocation(p, key) {
  if (!p || !fs.existsSync(p)) return { status: 'missing' };
  const info = await inspectRepo(p);
  if (!info) return { status: 'not-a-repo' };
  if (!info.remote || remoteKey(info.remote) !== key) return { status: 'wrong-remote', remote: info.remote ? sanitizeRemote(info.remote) : null };
  return { status: 'ok', root: info.root };
}

// Lesen, aendern, mit Revision zurueckschreiben; bei Konflikt neu versuchen.
// write=false: nur berechnen (Trockenlauf). Liefert null, wenn der Server keine
// Verweise kennt.
export async function updateRefs(client, mutate, { write = true } = {}) {
  const strip = (r) => JSON.stringify({ repos: r.repos || {}, chats: r.chats || {}, devices: r.devices || {} });
  for (let attempt = 1; ; attempt++) {
    const cur = await client.getRefs();
    if (!cur) return null;
    const next = JSON.parse(JSON.stringify(cur));
    next.repos = next.repos || {}; next.chats = next.chats || {}; next.devices = next.devices || {};
    await mutate(next);
    if (!write || strip(next) === strip(cur)) return { refs: write ? cur : next, changed: false };
    try { return { refs: await client.putRefs({ ...next, rev: cur.rev || 0 }), changed: true }; }
    catch (e) { if (e.code !== 'REFS_CONFLICT' || attempt >= 4) throw e; }
  }
}

// Vorschlag fuer den Ort eines Repos hier: wie auf dem Quell-PC, sonst ~/ClydeProjekte/<Name>
export function suggestPath(cfg, repo) {
  const same = repo.root ? localize(repo.root, cfg.forms) : null;
  if (same && !same.includes('@@CLYDE_') && path.isAbsolute(same) && fs.existsSync(path.parse(path.resolve(same)).root)) return normalizeHome(same);
  return normalizeHome(path.join(cfg.home, 'ClydeProjekte', repo.name || 'repo'));
}

// Probleme dieses Geraets: eingetragene Orte, die nicht stimmen, und Repos von
// Chats, die hier (noch) keinen Ort haben
export function problemsFor(cfg, refs, me, chatIds, titles = new Map()) {
  const out = [];
  const chatsOf = (key) => [...chatIds].filter((id) => refs.chats?.[id]?.repo === key).map((id) => titles.get(id) || id);
  const needed = new Set([...chatIds].map((id) => refs.chats?.[id]?.repo).filter(Boolean));
  for (const [key, e] of Object.entries(refs.repos || {})) {
    const loc = e.locations?.[me.id];
    if (loc?.status === 'skipped') continue;
    if (loc && loc.status === 'ok') continue;
    if (!loc && !needed.has(key)) continue;
    out.push({
      key, name: e.name || key.split('/').pop(), remote: e.remote, branch: e.branch || null,
      status: loc ? loc.status : 'unknown', path: loc?.path || null, by: loc?.by || null,
      suggested: suggestPath(cfg, e), chats: chatsOf(key),
    });
  }
  return out;
}

export function describeProblem(p) {
  const what = { unknown: 'ist hier nicht eingetragen', missing: `fehlt hier (${p.path})`, 'not-a-repo': `${p.path} ist kein Git-Repo`, 'wrong-remote': `${p.path} hat einen anderen Remote`, unverified: `${p.path} (im Dashboard eingetragen) ist noch ungeprueft` }[p.status] || p.status;
  return `Repo ${p.name} (${p.remote}) ${what}${p.chats.length ? `; Chats: ${p.chats.join(' | ')}` : ''}. `
    + `Klonen: clyde refs --clone ${p.name} [--to PFAD] | liegt hier: clyde refs --set ${p.name} PFAD | ueberspringen: clyde refs --skip ${p.name}`;
}

// Push/Pull: Fakten dieses Geraets eintragen, eingetragene Orte pruefen (auch im
// Dashboard gesetzte), Probleme melden. Korrekturen gehen sofort an den Server.
export async function syncRefs(cfg, client, { write = true, extraChatIds = [], extraTitles = null } = {}) {
  const me = device(cfg);
  const f = await localFacts(cfg);
  const at = now();
  const res = await updateRefs(client, async (refs) => {
    refs.devices[me.id] = { name: me.name, platform: process.platform, home: cfg.home, projectDrive: cfg.projectDrive || null, pathMap: cfg.pathMap || {}, memory: memoryLinks(cfg), seenAt: at };
    for (const [key, r] of f.repos) {
      const e = refs.repos[key] || (refs.repos[key] = { remote: r.remote, name: r.name, root: r.rootCanonical, locations: {} });
      Object.assign(e, { remote: r.remote, name: e.name || r.name, root: e.root || r.rootCanonical, branch: r.branch, head: r.head });
      e.locations = e.locations || {};
      const loc = e.locations[me.id];
      if (!loc || loc.path !== r.root || loc.status !== 'ok') e.locations[me.id] = { device: me.name, path: r.root, status: 'ok', by: 'device', at };
    }
    for (const [id, l] of f.links) {
      const cur = refs.chats[id];
      if (!cur || cur.repo !== l.repo || cur.sub !== l.sub) refs.chats[id] = { repo: l.repo, sub: l.sub, by: 'device', at };
    }
    for (const [key, e] of Object.entries(refs.repos)) {
      const loc = e.locations?.[me.id];
      if (!loc || loc.status === 'skipped' || f.repos.has(key)) continue;
      const v = await verifyLocation(loc.path, key);
      if (v.status === 'ok') {
        if (loc.status !== 'ok' || loc.path !== v.root) e.locations[me.id] = { ...loc, path: v.root, status: 'ok', checkedAt: at };
      } else if (loc.status !== v.status) e.locations[me.id] = { ...loc, status: v.status, checkedAt: at };
    }
  }, { write });
  if (!res) return { unsupported: true, refs: null, problems: [], work: [], device: me, facts: f };
  const titles = new Map([...(extraTitles || []), ...f.chats.map((c) => [c.id, c.title])]);
  const chatIds = new Set([...f.chats.map((c) => c.id), ...extraChatIds]);
  const work = [...f.repos.values()].filter((r) => r.info.dirty || r.info.untracked || r.info.ahead || (r.info.branch && !r.info.upstream));
  return { refs: res.refs, changed: res.changed, problems: problemsFor(cfg, res.refs, me, chatIds, titles), work, device: me, facts: f };
}

// Repo anhand von Schluessel, Remote-Adresse oder Name finden
export function resolveRepo(refs, ref) {
  const all = Object.entries(refs?.repos || {});
  const s = String(ref || '').trim();
  if (!s) throw new Error('Welches Repo? Name, Remote oder Schluessel angeben (siehe clyde refs).');
  const byKey = all.find(([k]) => k === s.toLowerCase()) || all.find(([k]) => k === remoteKey(s));
  if (byKey) return byKey;
  const byName = all.filter(([k, e]) => (e.name || k.split('/').pop()).toLowerCase() === s.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`"${s}" ist mehrdeutig: ${byName.map(([k]) => k).join(', ')}. Den Schluessel angeben.`);
  throw new Error(`Repo "${s}" ist nicht bekannt. Bekannt: ${all.map(([k, e]) => e.name || k).join(', ') || 'keine'} (siehe clyde refs).`);
}

// Neutralen Repo-Ordner auf den Ort hier zuordnen, damit die Chats dorthin zeigen
async function applyRepoMapping(cfg, repo, localPath, opts, log) {
  if (!repo.root) return cfg;
  const from = localize(repo.root, cfg.forms);
  if (isUnder(from, localPath) && isUnder(localPath, from)) return cfg;
  const raw = { ...cfg.raw, pathMap: { ...(cfg.raw.pathMap || {}), [repo.root]: localPath } };
  const newCfg = configFromRaw(raw);
  const r = await changeMapping({ oldCfg: cfg, newCfg, from, to: localPath, title: `Zuordnung ${repo.root} -> ${localPath}`, opts, log, ask: null, onlyOnWarnings: true });
  if (!r.applied) { log.warn(`Zuordnung fuer ${repo.name} nicht gesetzt; die Chats zeigen weiter auf ${from}.`); return cfg; }
  saveConfig(raw);
  log.info(`Die Chats von ${repo.name} zeigen hier jetzt auf ${localPath}.`);
  return newCfg;
}

// clyde refs --set REPO PFAD: Ort pruefen und sofort hochladen
export async function setLocation(cfg, client, ref, p, opts, log) {
  const me = device(cfg);
  const refs = await client.getRefs();
  if (!refs) throw new Error('Der Server kennt noch keine Verweise; Server auf 0.6.0 aktualisieren.');
  const [key, repo] = resolveRepo(refs, ref);
  const abs = normalizeHome(path.resolve(String(p).replace(/^["']|["']$/g, '')));
  const v = await verifyLocation(abs, key);
  if (v.status === 'missing') throw new Error(`${abs} gibt es nicht. Zum Klonen: clyde refs --clone ${repo.name} --to "${abs}"`);
  if (v.status === 'not-a-repo') throw new Error(`${abs} ist kein Git-Repo.`);
  if (v.status === 'wrong-remote') throw new Error(`${abs} ist ein anderes Repo (Remote ${v.remote || 'keiner'}, erwartet ${repo.remote}).`);
  await updateRefs(client, (r) => {
    r.repos[key].locations = r.repos[key].locations || {};
    r.repos[key].locations[me.id] = { device: me.name, path: v.root, status: 'ok', by: 'device', at: now() };
  });
  log.info(`${repo.name} liegt auf ${me.name} unter ${v.root} (hochgeladen).`);
  return applyRepoMapping(cfg, repo, v.root, opts, log);
}

// clyde refs --clone REPO [--to PFAD]
export async function cloneRepo(cfg, client, ref, to, opts, log) {
  const refs = await client.getRefs();
  if (!refs) throw new Error('Der Server kennt noch keine Verweise; Server auf 0.6.0 aktualisieren.');
  const [key, repo] = resolveRepo(refs, ref);
  const target = normalizeHome(path.resolve(to ? String(to).replace(/^["']|["']$/g, '') : suggestPath(cfg, repo)));
  let exists = false;
  try { exists = fs.readdirSync(target).length > 0; } catch { /* fehlt oder leer */ }
  if (exists) {
    const v = await verifyLocation(target, key);
    if (v.status === 'ok') { log.info(`${target} enthaelt ${repo.name} schon.`); return setLocation(cfg, client, key, target, opts, log); }
    throw new Error(`${target} ist nicht leer. Einen anderen Ordner angeben: clyde refs --clone ${repo.name} --to PFAD`);
  }
  if (!allowedRemote(repo.remote)) throw new Error(`Remote-Adresse nicht erlaubt: ${repo.remote}`);
  const branch = typeof repo.branch === 'string' && /^[\w][\w./-]*$/.test(repo.branch) && !repo.branch.includes('..') ? repo.branch : null;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  log.info(`Klone ${repo.remote} nach ${target} ...`);
  let r = await git(['clone', ...(branch ? ['--branch', branch] : []), '--', repo.remote, target], { timeout: 0 });
  if (!r.ok && branch && /not found|nicht gefunden/i.test(r.err)) r = await git(['clone', '--', repo.remote, target], { timeout: 0 });
  if (!r.ok) throw new Error(`Klonen fehlgeschlagen: ${firstLine(r.err)}. Fuer ${repo.remote.split(/[/:@]/).filter(Boolean)[1] || 'den Remote'} braucht dieser PC Zugang (SSH-Schluessel oder Git-Anmeldung).`);
  return setLocation(cfg, client, key, target, opts, log);
}

// clyde refs --skip REPO: auf diesem Geraet nicht mehr nachfragen
export async function skipRepo(cfg, client, ref, log) {
  const me = device(cfg);
  const refs = await client.getRefs();
  if (!refs) throw new Error('Der Server kennt noch keine Verweise; Server auf 0.6.0 aktualisieren.');
  const [key, repo] = resolveRepo(refs, ref);
  await updateRefs(client, (r) => {
    r.repos[key].locations = r.repos[key].locations || {};
    r.repos[key].locations[me.id] = { device: me.name, path: null, status: 'skipped', by: 'device', at: now() };
  });
  log.info(`${repo.name} wird auf ${me.name} uebersprungen (wieder aufnehmen: clyde refs --set oder --clone).`);
}

// clyde refs --link CHAT REPO / --unlink CHAT: Chat von Hand einem Repo zuordnen
export async function linkChat(cfg, client, chatRef, repoRef, log) {
  const chats = await localChats(cfg);
  const s = String(chatRef || '').trim().toLowerCase();
  const hits = chats.filter((c) => c.id.toLowerCase() === s || c.id.toLowerCase() === `local_${s}` || c.title.toLowerCase().includes(s));
  if (!s || !hits.length) throw new Error(`Chat "${chatRef}" nicht gefunden.`);
  if (hits.length > 1) throw new Error(`"${chatRef}" passt auf mehrere Chats: ${hits.map((c) => c.title).join(' | ')}`);
  const chat = hits[0];
  const refs = await client.getRefs();
  if (!refs) throw new Error('Der Server kennt noch keine Verweise; Server auf 0.6.0 aktualisieren.');
  if (repoRef === null) {
    await updateRefs(client, (r) => { delete r.chats[chat.id]; });
    log.info(`"${chat.title}" ist keinem Repo mehr zugeordnet.`);
    return;
  }
  const [key, repo] = resolveRepo(refs, repoRef);
  await updateRefs(client, (r) => { r.chats[chat.id] = { repo: key, sub: '', by: 'device', at: now() }; });
  log.info(`"${chat.title}" gehoert jetzt zu ${repo.name}.`);
}
