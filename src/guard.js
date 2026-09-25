import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { claudeHome } from './paths.js';
import { liveSessions, ownSession, describeSession } from './session.js';

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// Liefert eine Liste von Gruenden, warum ausserhalb der App gerade nicht
// synchronisiert werden sollte. Leer = alles ruhig.
export function claudeRunning() {
  if (process.env.CLYDE_SKIP_GUARD === '1') return [];
  const reasons = [];

  // 1. Lock-Dateien laufender Claude-Code-Sessions (CLI und Desktop-App)
  const dir = path.join(claudeHome(), 'sessions');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const pid = Number(j.pid);
      if (pid && pidAlive(pid)) {
        reasons.push(`Claude-Code-Session PID ${pid}${j.name ? ` ("${j.name}")` : ''}`);
      }
    }
  } catch { /* kein sessions-Ordner */ }

  // 2. Desktop-App-Prozess
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Claude.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
      if (/"Claude\.exe"/i.test(out)) reasons.push('Claude-Desktop-App (Claude.exe)');
    } else {
      const out = execFileSync('pgrep', ['-x', 'Claude'], { encoding: 'utf8' });
      if (out.trim()) reasons.push('Claude-Desktop-App');
    }
  } catch { /* pgrep ohne Treffer wirft; tasklist fehlt evtl. */ }

  return [...new Set(reasons)];
}

// Andere Chats, die gerade arbeiten (Clyde-Chat-Modus: die App darf offen sein,
// aber kein anderer Chat darf mitten in einer Antwort stecken)
export function busyOtherSessions(own = ownSession()) {
  return liveSessions().filter((s) => s.sessionId !== own?.sessionId && s.status !== 'idle');
}

// Prueft vor push/pull, ob synchronisiert werden darf.
// - Aufruf aus einem Chat der App (Clyde-Chat): App bleibt offen, nur andere
//   Chats, die gerade arbeiten, blockieren.
// - Aufruf aus einem normalen Terminal: Claude muss komplett geschlossen sein.
export function checkGuard(action, force, log) {
  if (process.env.CLYDE_SKIP_GUARD === '1') return;
  const own = ownSession();
  if (own) {
    const busy = busyOtherSessions(own);
    if (!busy.length) return;
    const list = busy.map((s) => `  - ${describeSession(s)} (${s.status})`).join('\n');
    if (!force) throw new Error(`${action} abgebrochen, diese Chats arbeiten gerade:\n${list}\nWarten, bis sie fertig sind, dann erneut aufrufen.`);
    log.warn(`Andere Chats arbeiten gerade, ${action} wird erzwungen:\n${list}`);
    return;
  }
  const r = claudeRunning();
  if (!r.length) return;
  const list = r.map((x) => `  - ${x}`).join('\n');
  if (!force) throw new Error(`${action} abgebrochen, Claude laeuft noch:\n${list}\nErst die Claude-App und offene Claude-Code-Terminals schliessen, oder aus einem Clyde-Chat in der App heraus aufrufen.`);
  log.warn(`Claude laeuft noch, ${action} wird erzwungen:\n${list}`);
}
