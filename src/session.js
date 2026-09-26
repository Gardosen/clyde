// Laufende Claude-Code-Sessions und die Session, aus der Clyde aufgerufen wird.
//
// Claude Code legt fuer jede laufende Session (CLI oder Desktop-App) eine Datei
// ~/.claude/sessions/<pid>.json mit sessionId, hostSessionId (Sidebar-ID der App)
// und status ("busy" waehrend ein Chat arbeitet, sonst "idle") an. Befehle, die
// Claude in einem Chat ausfuehrt, sehen die eigene Session in der Umgebung
// (CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_HOST_SESSION_ID).
import fs from 'node:fs';
import path from 'node:path';
import { claudeHome } from './paths.js';

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

export function liveSessions() {
  const dir = path.join(claudeHome(), 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const pid = Number(j.pid);
    if (!pid || !pidAlive(pid)) continue;
    out.push({
      pid,
      sessionId: j.sessionId || null,
      hostSessionId: j.hostSessionId || null,
      status: j.status || 'unbekannt',
      name: j.name || null,
      cwd: j.cwd || null,
    });
  }
  return out;
}

// Session, aus der Clyde gerade aufgerufen wird (Clyde-Chat), sonst null
export function ownSession() {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID || null;
  if (!sessionId) return null;
  return { sessionId, hostSessionId: process.env.CLAUDE_CODE_HOST_SESSION_ID || null };
}

export const sessionIds = (s) => [s.sessionId, s.hostSessionId].filter(Boolean);

export function describeSession(s) {
  return s.name ? `"${s.name}"` : `Session ${s.sessionId}`;
}

// Gehoert ein (lokaler oder neutraler) Relativpfad zu einer der Sessions?
// Transkripte, Unterordner, Datei-Historie, Todos und Sidebar-Eintraege tragen
// die Session-ID bzw. Sidebar-ID im Pfad.
export function pathBelongsTo(p, ids) {
  for (const id of ids) if (id && p.includes(id)) return true;
  return false;
}
