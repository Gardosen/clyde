// Gruppen der Chatliste ("Archivar Project", "Finished Projects" ...).
//
// Die Desktop-App speichert sie nicht bei den Chats, sondern in ihrer
// Einstellungsdatei claude_desktop_config.json neben dem Ordner der Chatliste:
//   preferences.epitaxyPrefs["dframe-group-scopes"][<org>/<konto>] =
//     { groups: [{id, name}], assignments: {"code:<chat-id>": <gruppen-id>}, order: {...} }
// Dieselbe Datei enthaelt auch andere Einstellungen der App, etwa MCP-Server mit
// Zugangsdaten. Clyde liest deshalb ausschliesslich diese Gruppen-Angaben und
// gibt sonst nichts aus der Datei weiter.
import fs from 'node:fs';
import path from 'node:path';
import { pathBelongsTo } from './session.js';
import { clydeHome } from './paths.js';

export function desktopConfigPath(cfg) {
  const root = cfg.roots['desktop-sessions'];
  if (!root) return null;
  return cfg.raw?.desktopConfig || path.join(path.dirname(root.path), 'claude_desktop_config.json');
}

const str = (v) => typeof v === 'string' && v.length > 0 && v.length <= 300;

export function readAppGroups(cfg) {
  const file = desktopConfigPath(cfg);
  if (!file) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const ep = j?.preferences?.epitaxyPrefs;
  if (!ep || typeof ep !== 'object') return null;
  const exclude = cfg.exclude || [];
  const scopes = {};
  for (const [scope, s] of Object.entries(ep['dframe-group-scopes'] || {})) {
    if (!s || typeof s !== 'object') continue;
    const groups = (Array.isArray(s.groups) ? s.groups : [])
      .filter((g) => g && str(g.id) && str(g.name))
      .map(({ id, name }) => ({ id, name }));
    const assignments = {};
    for (const [k, v] of Object.entries(s.assignments || {})) {
      if (str(k) && str(v) && !pathBelongsTo(k, exclude)) assignments[k] = v;
    }
    const order = {};
    for (const [g, list] of Object.entries(s.order || {})) {
      if (str(g) && Array.isArray(list)) order[g] = list.filter((x) => str(x) && !pathBelongsTo(x, exclude));
    }
    if (groups.length || Object.keys(assignments).length) scopes[scope] = { groups, assignments, order };
  }
  const starred = Array.isArray(ep['starred-local-code-sessions'])
    ? ep['starred-local-code-sessions'].filter((x) => str(x) && !pathBelongsTo(x, exclude))
    : [];
  return { scopes, starred };
}

// Fuer das Dashboard: Chat-ID der App (local_...) -> {id, name, rank}
export function groupLookup(appGroups) {
  const byChat = new Map();
  const ranks = new Map();
  if (!appGroups || typeof appGroups !== 'object') return { byChat, ranks };
  for (const s of Object.values(appGroups.scopes || {})) {
    const names = new Map();
    (s.groups || []).forEach((g) => {
      names.set(g.id, g.name);
      if (!ranks.has(g.id)) ranks.set(g.id, ranks.size);
    });
    for (const [k, gid] of Object.entries(s.assignments || {})) {
      if (!names.has(gid)) continue;
      byChat.set(k.replace(/^code:/, ''), { id: gid, name: names.get(gid), rank: ranks.get(gid) });
    }
  }
  return { byChat, ranks };
}

// Chat-IDs der Chatliste auf diesem PC (local_...), ohne Clyde-Chats; mit Titel
export async function localSidebarChats(cfg) {
  const root = cfg.roots['desktop-sessions'];
  const out = new Map();
  if (!root) return out;
  const walk = async (dir) => {
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.name.startsWith('local_') || !e.name.endsWith('.json') || pathBelongsTo(e.name, cfg.exclude || [])) continue;
      let j = {};
      try { j = JSON.parse(await fs.promises.readFile(p, 'utf8')) || {}; } catch { /* kein JSON */ }
      // "angeheftet" steht beim Chat selbst (isStarred); fehlt das Feld: unbekannt
      out.set(e.name.slice(0, -5), { title: j.title || null, starred: typeof j.isStarred === 'boolean' ? j.isStarred : null });
    }
  };
  await walk(root.path);
  return out;
}

// Welche Chat-Eintraege hat der letzte Pull an bereits vorhandenen Chats
// geaendert? Haelt die laufende App einen solchen Chat im Speicher, kennt sie die
// Aenderung (etwa angeheftet/geloest auf einem anderen PC) noch nicht und wuerde
// sie beim naechsten Speichern ueberschreiben; /clyde:groups gleicht das an.
const lastPullFile = () => path.join(clydeHome(), 'last-pull-sidebar.json');
export function saveSidebarPull(ids) {
  try {
    fs.mkdirSync(clydeHome(), { recursive: true });
    fs.writeFileSync(lastPullFile(), JSON.stringify({ at: new Date().toISOString(), ids: [...new Set(ids)] }));
  } catch { /* nur ein Hinweis fuer /clyde:groups */ }
}
export function loadSidebarPull() {
  try { const j = JSON.parse(fs.readFileSync(lastPullFile(), 'utf8')); return Array.isArray(j.ids) ? j.ids : []; } catch { return []; }
}

// Anheften: angeheftet sind Chats mit isStarred im eigenen Eintrag (nach dem Pull
// ist das der zusammengefuehrte Stand); aeltere Staende kennen nur die Liste in
// den App-Einstellungen. Loesen nur bei Chats, deren Eintrag der letzte Pull
// geaendert hat und die dort ausdruecklich nicht angeheftet sind.
export function desiredPins(chats, legacyStarred = [], pulledIds = []) {
  const legacy = new Set((legacyStarred || []).map((k) => String(k).replace(/^code:/, '')));
  const pin = [];
  const unpin = [];
  for (const [id, c] of chats) {
    if (c.starred === true || (c.starred === null && legacy.has(id))) pin.push(id);
  }
  for (const id of pulledIds) if (chats.get(id)?.starred === false) unpin.push(id);
  return { pin, unpin };
}

// Soll-Gruppierung aus dem gemeinsamen Stand, nur fuer Chats, die es hier gibt:
// Gruppen nach Namen (gleichnamige aus mehreren Bereichen zusammen), in
// Seitenleisten-Reihenfolge (Anheften: desiredPins)
export function desiredGroups(appGroups, present) {
  const byName = new Map();
  const idOf = (k) => String(k).replace(/^code:/, '');
  for (const s of Object.values(appGroups?.scopes || {})) {
    const names = new Map((s.groups || []).map((g) => [g.id, String(g.name).trim()]));
    for (const name of names.values()) if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { name, sessions: [] });
    const keys = Object.keys(s.assignments || {});
    // Reihenfolge innerhalb der Gruppe wie in der Seitenleiste, sofern bekannt
    const rank = new Map();
    for (const list of Object.values(s.order || {})) list.forEach((k, i) => rank.set(idOf(k), i));
    keys.sort((x, y) => (rank.get(idOf(x)) ?? 1e9) - (rank.get(idOf(y)) ?? 1e9));
    for (const key of keys) {
      if (!/^(code:)?local_/.test(key)) continue;
      const name = names.get(s.assignments[key]);
      const id = idOf(key);
      if (!name || !present(id)) continue;
      const entry = byName.get(name.toLowerCase());
      if (![...byName.values()].some((g) => g.sessions.includes(id))) entry.sessions.push(id);
    }
  }
  return { groups: [...byName.values()].filter((g) => g.sessions.length) };
}
