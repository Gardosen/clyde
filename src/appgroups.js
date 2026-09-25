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
