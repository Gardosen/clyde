import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Ablage von Clyde selbst (Konfiguration, Cache, Backups)
export function clydeHome() {
  return process.env.CLYDE_HOME || path.join(os.homedir(), '.clyde');
}
export const configPath = () => path.join(clydeHome(), 'config.json');
export const cachePath = () => path.join(clydeHome(), 'cache.json');
export const lastSnapshotPath = () => path.join(clydeHome(), 'last-snapshot.json');
export const backupsDir = () => path.join(clydeHome(), 'backups');
export const chunkCacheDir = () => path.join(clydeHome(), 'chunks');

// Ablage von Claude Code (CLI und Desktop-App teilen sich dieses Verzeichnis)
export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Die Claude-App aus dem Microsoft Store ist ein MSIX-Paket: Windows leitet ihr
// %APPDATA%\Claude in den Paketordner um
// (%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude). Prozesse aus der
// App heraus sehen beide Pfade, ein normales Terminal nur den Paketordner.
export function storeAppRoamingDirs() {
  if (process.platform !== 'win32') return [];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const pkgs = path.join(local, 'Packages');
  let names = [];
  try { names = fs.readdirSync(pkgs).filter((n) => /^Claude_[a-z0-9]+$/i.test(n)); } catch { return []; }
  return names.map((n) => path.join(pkgs, n, 'LocalCache', 'Roaming', 'Claude')).filter((d) => fs.existsSync(d));
}

// Chatliste der Desktop-App (eine kleine JSON-Datei je Chat)
export function desktopSessionsDir() {
  if (process.platform === 'win32') {
    if (process.env.CLYDE_DESKTOP_SESSIONS) return process.env.CLYDE_DESKTOP_SESSIONS;
    for (const d of storeAppRoamingDirs()) {
      const p = path.join(d, 'claude-code-sessions');
      if (fs.existsSync(p)) return p; // Store-App: echter Speicherort
    }
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'Claude', 'claude-code-sessions');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'Claude', 'claude-code-sessions');
}

// Alles, was den "Zustand der Chats" ausmacht. Bewusst NICHT dabei:
// .claude/sessions (laufende Prozesse), .claude.json (Login, Maschinen-ID),
// .credentials.json, shell-snapshots, cache, statsig, telemetry.
// rewrite: false = Home-Pfade in Dateiinhalten NICHT durch Platzhalter ersetzen
// (Datei-Historie enthaelt Kopien von Projektdateien, die unveraendert bleiben muessen).
export function defaultRoots() {
  const ch = claudeHome();
  return {
    'claude-projects':     { path: path.join(ch, 'projects'),      kind: 'dir',  desc: 'Chat-Transkripte (JSONL), Tool-Ergebnisse, Memory' },
    'claude-file-history': { path: path.join(ch, 'file-history'),  kind: 'dir',  desc: 'Datei-Historie fuer Diff und Rewind', rewrite: false },
    'claude-todos':        { path: path.join(ch, 'todos'),         kind: 'dir',  desc: 'Todo-Listen' },
    'claude-plans':        { path: path.join(ch, 'plans'),         kind: 'dir',  desc: 'Plan-Mode-Dateien' },
    'claude-history':      { path: path.join(ch, 'history.jsonl'), kind: 'file', desc: 'Eingabe-Historie' },
    'desktop-sessions':    { path: desktopSessionsDir(),           kind: 'dir',  desc: 'Sidebar-Index der Desktop-App (Titel, Ordner, Archiv)' },
  };
}
