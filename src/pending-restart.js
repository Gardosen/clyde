// Chats, deren Arbeitsordner Clyde umgestellt hat, solange die App das noch nicht
// nachweislich uebernommen hat.
//
// Die laufende App haelt den Ordner jedes Chats im Speicher und liest die Dateien
// erst beim Start neu. Oeffnet man einen umgestellten Chat vor dem Neustart, meldet
// sie den alten Ordner als fehlend und schreibt ihn in die Datei zurueck. Die Liste
// hier erlaubt dem Skill, bei der App nachzufragen (get_session) und rechtzeitig zu
// warnen.
import fs from 'node:fs';
import path from 'node:path';
import { clydeHome } from './paths.js';

const file = () => path.join(clydeHome(), 'pending-restart.json');

export function loadPending() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch { return {}; }
}

function save(rec) {
  if (!Object.keys(rec).length) { fs.rmSync(file(), { force: true }); return; }
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(rec, null, 1));
}

// chats: [{ id, title, cwd }] mit dem neuen Ordner
export function addPending(chats) {
  if (!chats.length) return;
  const rec = loadPending();
  const at = new Date().toISOString();
  for (const c of chats) rec[c.id] = { title: c.title, cwd: c.cwd, at };
  save(rec);
}

export function settlePending(ids) {
  const rec = loadPending();
  const done = ids.filter((id) => rec[id]);
  for (const id of done) delete rec[id];
  save(rec);
  return done;
}

// Noch offene Eintraege; Chats, die es nicht mehr gibt oder deren Ordner sich
// seitdem geaendert hat (zurueckgeschrieben: das zeigt clyde folders als fehlend),
// fallen heraus. chats: localChats().
export function prunePending(chats) {
  const rec = loadPending();
  const byId = new Map(chats.map((c) => [c.id, c]));
  const same = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
  const out = [];
  for (const [id, r] of Object.entries(rec)) {
    const c = byId.get(id);
    if (!c || !same(c.cwd, r.cwd)) { delete rec[id]; continue; }
    out.push({ id, title: c.title, cwd: r.cwd, at: r.at });
  }
  save(rec);
  return out;
}
