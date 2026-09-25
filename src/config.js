import fs from 'node:fs';
import os from 'node:os';
import { clydeHome, configPath, defaultRoots } from './paths.js';
import { allForms, normalizeHome, normalizeDrive } from './rewrite.js';
import { ownSession, sessionIds } from './session.js';

const SETUP_HINT = 'clyde init --server URL --token TOKEN';

// Server-URL vereinheitlichen: ohne Schema gilt https, Schraegstriche am Ende weg
export function normalizeServerUrl(input) {
  let s = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error(`Ungueltige Server-URL: ${input}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`Server-URL muss mit http:// oder https:// beginnen: ${input}`);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

// Baut die Laufzeit-Konfiguration aus dem rohen Inhalt von config.json
export function configFromRaw(raw) {
  const roots = defaultRoots();
  // Optionale Ueberschreibung je Root: Pfad-String, Objekt {path, kind, rewrite} oder false zum Abschalten
  for (const [name, o] of Object.entries(raw.roots || {})) {
    if (o === false) { delete roots[name]; continue; }
    const base = roots[name] || { kind: 'dir', desc: name };
    roots[name] = { ...base, ...(typeof o === 'string' ? { path: o } : o) };
  }
  // Home-Verzeichnis dieses Kontos, Laufwerk der Projekte ausserhalb des Home und
  // Zuordnungen einzelner Projekte: alles wird in Snapshots durch Platzhalter
  // ersetzt, damit andere PCs mit anderen Konten oder Pfaden dieselben Daten nutzen
  const home = normalizeHome(raw.home || os.homedir());
  const projectDrive = normalizeDrive(raw.projectDrive);
  const pathMap = raw.pathMap && typeof raw.pathMap === 'object' ? raw.pathMap : {};
  // Chats, die nie synchronisiert werden: registrierte Clyde-Chats und der Chat,
  // aus dem Clyde gerade aufgerufen wird. Ihre Dateien werden weder hochgeladen
  // noch beim Pull angefasst.
  const registered = Array.isArray(raw.excludeSessions) ? raw.excludeSessions.filter((x) => typeof x === 'string' && x) : [];
  const own = ownSession();
  const exclude = [...new Set([...registered, ...(own ? sessionIds(own) : [])])];
  return {
    server: raw.server || null,
    token: raw.token,
    backupsToKeep: raw.backupsToKeep ?? 3,
    uploadBatchMiB: raw.uploadBatchMiB ?? 16, // klein genug fuer Proxy-Timeouts (Traefik readTimeout 60 s)
    home,
    projectDrive,
    pathMap,
    forms: allForms(home, projectDrive, pathMap),
    exclude,
    registeredClydeChats: registered,
    roots,
    raw,
  };
}

export function loadConfig({ required = true } = {}) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (required) {
      throw new Error(`Clyde ist hier noch nicht eingerichtet (${configPath()} fehlt).\nErst ausfuehren: ${SETUP_HINT}`);
    }
  }
  if (required && (!raw.server || !raw.token)) {
    throw new Error(`In ${configPath()} fehlen Server-URL oder Token.\nErst ausfuehren: ${SETUP_HINT}`);
  }
  return configFromRaw(raw);
}

export function saveConfig(raw) {
  fs.mkdirSync(clydeHome(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(raw, null, 2) + '\n');
}
