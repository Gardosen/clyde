// Versionen von Clyde auf diesem PC (CLI und Plugin in der App) und auf dem
// Server vergleichen.
//
// Der Server meldet unter /health seine Version und (ab 0.4.7) die aelteste
// Client-Version, mit der er sicher arbeitet (minClient). Umgekehrt kennt der
// Client die aelteste Server-Version, die er braucht (MIN_SERVER). Die Version
// des Plugins steht in Claudes Plugin-Liste (installed_plugins.json).
import fs from 'node:fs';
import path from 'node:path';
import { claudeHome } from './paths.js';

export const CLIENT_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; }
})();
// Staende im Format v3 (maskierte Platzhalter) speichert der Server ab 0.4.2
export const MIN_SERVER = '0.4.2';
export const PLUGIN_ID = 'clyde@clyde';

const parts = (v) => String(v || '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
export function cmpVersion(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
export const isVersion = (v) => /^\d+\.\d+\.\d+/.test(String(v || ''));

// Version des Clyde-Plugins in der App (hoechste installierte), sonst null
export function installedPluginVersion() {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(claudeHome(), 'plugins', 'installed_plugins.json'), 'utf8')); } catch { return null; }
  const entries = (j?.plugins || j || {})[PLUGIN_ID];
  const list = (Array.isArray(entries) ? entries : [entries]).map((e) => e?.version).filter(isVersion);
  return list.sort(cmpVersion).pop() || null;
}

const SERVER_UPDATE = 'auf dem Server im Clyde-Ordner: git pull, dann docker compose up -d --build';
const LOCAL_UPDATE = '"clyde update" (oder /clyde:update in der App)';

// Hinweise zum Versionsstand. level: 'block' (dieser Client darf nicht weiter),
// 'warn' (sollte aktualisiert werden)
export function versionNotes(health, client = CLIENT_VERSION, plugin = installedPluginVersion()) {
  const server = isVersion(health?.version) ? health.version : null;
  const notes = [];
  if (server) {
    if (isVersion(health.minClient) && cmpVersion(client, health.minClient) < 0) {
      notes.push({ level: 'block', text: `Dieses Clyde (${client}) ist zu alt fuer den Server, er braucht mindestens ${health.minClient}. Aktualisieren: ${LOCAL_UPDATE}` });
    } else if (cmpVersion(client, server) < 0) {
      notes.push({ level: 'warn', text: `Dieses Clyde ist veraltet: auf dem Server laeuft ${server}, hier ${client}. Aktualisieren: ${LOCAL_UPDATE}` });
    }
    if (cmpVersion(server, MIN_SERVER) < 0) {
      notes.push({ level: 'warn', text: `Der Server (${server}) ist zu alt fuer dieses Clyde (${client}), Push schlaegt fehl. Server aktualisieren: ${SERVER_UPDATE}` });
    } else if (cmpVersion(server, client) < 0) {
      notes.push({ level: 'warn', text: `Der Server laeuft noch mit ${server}, dieser PC mit ${client}. Server aktualisieren: ${SERVER_UPDATE}` });
    }
  }
  const newest = [client, server].filter(Boolean).sort(cmpVersion).pop();
  if (plugin && cmpVersion(plugin, newest) < 0) {
    notes.push({ level: 'warn', text: `Das Clyde-Plugin in der App ist veraltet (${plugin}, aktuell ${newest}); neue Befehle wie /clyde:update fehlen dort. Aktualisieren: ${LOCAL_UPDATE}` });
  }
  return { client, server, plugin, notes };
}

export function versionLine(v) {
  return `Clyde ${v.client} (dieser PC)${v.plugin ? `, Plugin ${v.plugin}` : ''}, Server ${v.server || 'unbekannt'}${v.notes.length ? '' : ' - aktuell'}`;
}

// Fuer push und pull: Hinweise ausgeben, bei 'block' abbrechen
export function checkVersions(health, log) {
  const v = versionNotes(health);
  for (const n of v.notes) {
    if (n.level === 'block') throw new Error(n.text);
    log.warn(n.text);
  }
  return v;
}
