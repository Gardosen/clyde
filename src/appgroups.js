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
import crypto from 'node:crypto';
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
// entries: { local_...: { title, starred } } so, wie der Pull sie geschrieben hat
export function saveSidebarPull(entries) {
  try {
    fs.mkdirSync(clydeHome(), { recursive: true });
    fs.writeFileSync(lastPullFile(), JSON.stringify({ at: new Date().toISOString(), entries }));
  } catch { /* nur ein Hinweis fuer /clyde:groups */ }
}
export function loadSidebarPull() {
  try { const j = JSON.parse(fs.readFileSync(lastPullFile(), 'utf8')); return j.entries && typeof j.entries === 'object' ? j.entries : {}; } catch { return {}; }
}
export function clearSidebarPull() { try { fs.rmSync(lastPullFile(), { force: true }); } catch { /* egal */ } }

// Anheften: angeheftet sind Chats mit isStarred im eigenen Eintrag (nach dem Pull
// ist das der zusammengefuehrte Stand); aeltere Staende kennen nur die Liste in
// den App-Einstellungen. Loesen nur bei Chats, deren Eintrag der letzte Pull
// geaendert hat und die dort ausdruecklich nicht angeheftet sind.
export function desiredPins(chats, legacyStarred = [], pulled = {}) {
  const legacy = new Set((legacyStarred || []).map((k) => String(k).replace(/^code:/, '')));
  const pin = [];
  const unpin = [];
  for (const [id, c] of chats) {
    if (c.starred === true || (c.starred === null && legacy.has(id))) pin.push(id);
  }
  for (const [id, e] of Object.entries(pulled || {})) if (chats.has(id) && e?.starred === false) unpin.push(id);
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

// ---- Gruppen ueber PCs hinweg: Zuordnung und Umbenennen ----
//
// Jede Gruppe hat in der App eine ID (cg-...). Legt /clyde:groups eine Gruppe auf
// einem anderen PC an, bekommt sie dort eine eigene ID. Clyde merkt sich je PC,
// welche Gruppe hier zu welcher Gruppe im gemeinsamen Stand gehoert, und die
// Namen beider beim letzten Abgleich:
//   { sharedId, localId, sharedName, localName }
// Damit ist ein Umbenennen auf einer Seite von einem Umbenennen auf der anderen
// zu unterscheiden. Bei gleichzeitigem Umbenennen gilt der gemeinsame Stand.
const linksFile = (cfg) => {
  const id = crypto.createHash('sha256').update(JSON.stringify([cfg.server, cfg.roots['desktop-sessions']?.path || ''])).digest('hex').slice(0, 16);
  return path.join(clydeHome(), `groups-${id}.json`);
};
export function loadGroupLinks(cfg) {
  try { const j = JSON.parse(fs.readFileSync(linksFile(cfg), 'utf8')); return j && typeof j.scopes === 'object' ? j.scopes : {}; } catch { return {}; }
}
export function saveGroupLinks(cfg, scopes) {
  try {
    fs.mkdirSync(clydeHome(), { recursive: true });
    fs.writeFileSync(linksFile(cfg), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), scopes }));
  } catch { /* Zuordnung wird beim naechsten Abgleich neu gebildet */ }
}
const nameKey = (n) => String(n || '').trim().toLowerCase();
const clone = (x) => JSON.parse(JSON.stringify(x));

// Push: lokale Gruppen in den gemeinsamen Stand einbringen. Liefert die neuen
// Gruppen des Stands, die neue Zuordnung und die eingebrachten Umbenennungen.
export function reconcileGroups(shared, local, links) {
  if (!local || !Object.keys(local.scopes || {}).length) return { appGroups: shared || null, links, renamed: [], added: [] };
  const out = shared ? clone(shared) : { scopes: {}, starred: [] };
  out.scopes = out.scopes || {};
  const newLinks = { ...links };
  const renamed = [];
  const added = [];
  for (const [scope, L] of Object.entries(local.scopes)) {
    const S = out.scopes[scope] || (out.scopes[scope] = { groups: [], assignments: {}, order: {} });
    S.groups = S.groups || []; S.assignments = S.assignments || {}; S.order = S.order || {};
    const old = links[scope] || [];
    const list = [];
    const toShared = new Map();
    for (const g of L.groups || []) {
      const link = old.find((l) => l.localId === g.id);
      let sg = link ? S.groups.find((x) => x.id === link.sharedId) : null;
      if (link && sg) {
        const localRenamed = g.name !== link.localName;
        const sharedRenamed = sg.name !== link.sharedName;
        if (localRenamed && !sharedRenamed && g.name !== sg.name) { renamed.push({ from: sg.name, to: g.name }); sg.name = g.name; }
      }
      if (!sg) sg = S.groups.find((x) => x.id === g.id) || S.groups.find((x) => nameKey(x.name) === nameKey(g.name));
      if (!sg) { sg = { id: g.id, name: g.name }; S.groups.push(sg); added.push(g.name); }
      toShared.set(g.id, sg.id);
      list.push({ sharedId: sg.id, localId: g.id, sharedName: sg.name, localName: g.name });
    }
    for (const [k, gid] of Object.entries(L.assignments || {})) S.assignments[k] = toShared.get(gid) || gid;
    for (const [gid, order] of Object.entries(L.order || {})) S.order[toShared.get(gid) || gid] = order;
    newLinks[scope] = list;
  }
  out.starred = [...new Set([...(out.starred || []), ...(local.starred || [])])];
  return { appGroups: out, links: newLinks, renamed, added };
}

// Pull: welche Gruppen hier umzubenennen sind (der gemeinsame Stand hat einen
// anderen Namen, und hier wurde seit dem letzten Abgleich nicht umbenannt)
export function groupRenames(shared, local, links) {
  const out = [];
  for (const [scope, list] of Object.entries(links || {})) {
    const S = shared?.scopes?.[scope];
    const L = local?.scopes?.[scope];
    if (!S || !L) continue;
    for (const link of list) {
      const sg = (S.groups || []).find((x) => x.id === link.sharedId);
      const lg = (L.groups || []).find((x) => x.id === link.localId);
      if (!sg || !lg || sg.name === lg.name) continue;
      const localRenamed = lg.name !== link.localName;
      const sharedRenamed = sg.name !== link.sharedName;
      if (localRenamed && !sharedRenamed) continue; // eigene Umbenennung, kommt mit dem naechsten Push
      out.push({ groupId: lg.id, from: lg.name, to: sg.name });
    }
  }
  return out;
}

// Nach /clyde:groups: Zuordnung fuer Gruppen festhalten, die jetzt gleich heissen
// (neu angelegte oder umbenannte). Abweichende bleiben unveraendert, damit ein
// hier noch nicht gepushtes Umbenennen nicht verloren geht.
export function linkMatchingGroups(shared, local, links) {
  const out = { ...links };
  for (const [scope, L] of Object.entries(local?.scopes || {})) {
    const S = shared?.scopes?.[scope];
    if (!S) continue;
    const list = [...(links[scope] || [])];
    for (const lg of L.groups || []) {
      const i = list.findIndex((l) => l.localId === lg.id);
      const sg = i >= 0 ? (S.groups || []).find((x) => x.id === list[i].sharedId) : (S.groups || []).find((x) => x.id === lg.id || nameKey(x.name) === nameKey(lg.name));
      if (!sg || sg.name !== lg.name) continue;
      const entry = { sharedId: sg.id, localId: lg.id, sharedName: sg.name, localName: lg.name };
      if (i >= 0) list[i] = entry; else list.push(entry);
    }
    out[scope] = list;
  }
  return out;
}
