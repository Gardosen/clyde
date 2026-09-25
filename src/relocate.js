// Chats einem anderen Projektordner zuordnen ("clyde relocate").
//
// Claude merkt sich den Projektordner eines Chats an zwei Stellen:
//  1. im Eintrag der Chatliste (cwd, originCwd, Ordner-Freigaben)
//  2. am Ablageort des Transkripts: ~/.claude/projects/<Schluessel des Ordners>/<id>.jsonl
//     (Schluessel = Pfad mit jedem Nicht-Buchstaben/Ziffer als "-")
// Beides wird umgestellt. Die Projektdateien selbst bleiben, wo sie sind. Hat der
// alte Projektordner ein Memory, bekommt der neue eine Verknuepfung darauf, damit
// das Wissen erhalten bleibt. Vorher wird gesichert; --undo macht alles rueckgaengig.
import fs from 'node:fs';
import path from 'node:path';
import { backupsDir } from './paths.js';

export const projectKey = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-');
const norm = (p) => path.resolve(String(p).trim().replace(/^["']|["']$/g, '')).replace(/[\\/]+$/, '');

function listChats(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^local_.*\.json$/.test(e.name)) {
        try { out.push({ file: p, j: JSON.parse(fs.readFileSync(p, 'utf8')) }); } catch { /* defekt */ }
      }
    }
  };
  walk(dir);
  return out;
}

// Chat per ID der App (local_...), Session-ID oder Teil des Titels finden
function findChat(chats, sel) {
  const s = String(sel || '').trim();
  if (!s) throw new Error('Kein Chat angegeben');
  const exact = chats.filter((c) => c.j.sessionId === s || c.j.cliSessionId === s);
  if (exact.length === 1) return exact[0];
  const byTitle = chats.filter((c) => typeof c.j.title === 'string' && c.j.title.toLowerCase().includes(s.toLowerCase()));
  if (byTitle.length === 1) return byTitle[0];
  if (!byTitle.length) throw new Error(`Kein Chat passt zu "${s}"`);
  throw new Error(`"${s}" passt zu mehreren Chats: ${byTitle.map((c) => `"${c.j.title}"`).join(', ')}. Genauer angeben oder die ID nehmen.`);
}

export function planRelocation(cfg, items) {
  const sidebarDir = cfg.roots['desktop-sessions']?.path;
  const projectsDir = cfg.roots['claude-projects']?.path;
  if (!sidebarDir || !projectsDir) throw new Error('Chatliste oder Projektablage ist in der Konfiguration abgeschaltet');
  const chats = listChats(sidebarDir);
  const projectDirs = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir).map((n) => path.join(projectsDir, n)) : [];
  const steps = [];
  const targets = new Set();
  for (const it of items) {
    const chat = findChat(chats, it.chat);
    const to = norm(it.to);
    let st = null;
    try { st = fs.statSync(to); } catch { /* fehlt */ }
    if (!st || !st.isDirectory()) throw new Error(`Zielordner ${to} existiert nicht`);
    const sid = chat.j.cliSessionId;
    if (!sid) throw new Error(`Chat "${chat.j.title}" hat keine Session-ID`);
    if (targets.has(sid)) throw new Error(`Chat "${chat.j.title}" steht doppelt im Plan`);
    targets.add(sid);
    const oldDir = projectDirs.find((d) => fs.existsSync(path.join(d, `${sid}.jsonl`))) || null;
    const newDir = path.join(projectsDir, projectKey(to));
    const moves = [];
    if (oldDir && path.resolve(oldDir) !== path.resolve(newDir)) {
      for (const name of [`${sid}.jsonl`, sid, `${sid}.desktop-released.json`]) {
        const from = path.join(oldDir, name);
        if (!fs.existsSync(from)) continue;
        const dest = path.join(newDir, name);
        if (fs.existsSync(dest)) throw new Error(`Ziel ${dest} existiert schon, Chat "${chat.j.title}" wird nicht verschoben`);
        moves.push({ from, to: dest });
      }
    }
    let link = null;
    const oldMem = oldDir ? path.join(oldDir, 'memory') : null;
    const newMem = path.join(newDir, 'memory');
    if (oldMem && fs.existsSync(oldMem) && !fs.existsSync(newMem) && path.resolve(oldDir) !== path.resolve(newDir)) {
      link = { path: newMem, target: fs.realpathSync(oldMem) };
    }
    const oldCwd = chat.j.cwd || null;
    steps.push({
      title: chat.j.title || sid, sid, appId: chat.j.sessionId, sidebarFile: chat.file,
      oldCwd, to, oldDir, newDir, moves, link,
      unchanged: oldCwd && norm(oldCwd) === to && !moves.length,
    });
  }
  // Mehrere Chats in denselben neuen Ordner: die Memory-Verknuepfung nur einmal anlegen
  const linked = new Set();
  for (const s of steps) {
    if (!s.link) continue;
    if (linked.has(s.link.path)) s.link = null; else linked.add(s.link.path);
  }
  return steps;
}

// Ersetzt den alten Projektordner im Chat-Eintrag durch den neuen
function rewriteEntry(j, oldCwd, to) {
  const same = (v) => typeof v === 'string' && oldCwd && norm(v).toLowerCase() === norm(oldCwd).toLowerCase();
  j.cwd = to;
  if (!j.originCwd || same(j.originCwd)) j.originCwd = to;
  for (const u of Array.isArray(j.sessionPermissionUpdates) ? j.sessionPermissionUpdates : []) {
    if (u && Array.isArray(u.directories)) u.directories = u.directories.map((d) => (same(d) ? to : d));
  }
  return j;
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.clyde-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

export function applyRelocation(steps, log) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bdir = path.join(backupsDir(), `relocate-${ts}`);
  fs.mkdirSync(bdir, { recursive: true });
  const undo = { version: 1, createdAt: new Date().toISOString(), steps: [] };
  const saveUndo = () => fs.writeFileSync(path.join(bdir, 'undo.json'), JSON.stringify(undo, null, 2));
  for (const s of steps) {
    if (s.unchanged) { log.info(`  = ${s.title}: liegt schon in ${s.to}`); continue; }
    const rec = { title: s.title, sidebarFile: s.sidebarFile, backup: path.join(bdir, path.basename(s.sidebarFile)), moves: [], link: null };
    fs.copyFileSync(s.sidebarFile, rec.backup);
    undo.steps.push(rec);
    saveUndo();
    fs.mkdirSync(s.newDir, { recursive: true });
    for (const m of s.moves) { fs.renameSync(m.from, m.to); rec.moves.push(m); saveUndo(); }
    if (s.link) {
      fs.symlinkSync(s.link.target, s.link.path, process.platform === 'win32' ? 'junction' : 'dir');
      rec.link = s.link.path;
      saveUndo();
    }
    const j = JSON.parse(fs.readFileSync(s.sidebarFile, 'utf8'));
    writeJsonAtomic(s.sidebarFile, rewriteEntry(j, s.oldCwd, s.to));
    log.info(`  ✓ ${s.title}: ${s.oldCwd} -> ${s.to}`);
  }
  saveUndo();
  return bdir;
}

export function undoRelocation(dir, log) {
  const file = fs.existsSync(path.join(dir, 'undo.json')) ? path.join(dir, 'undo.json') : dir;
  const undo = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const rec of [...undo.steps].reverse()) {
    if (rec.link && fs.existsSync(rec.link)) fs.rmSync(rec.link, { recursive: false, force: true });
    for (const m of [...rec.moves].reverse()) {
      if (fs.existsSync(m.to) && !fs.existsSync(m.from)) fs.renameSync(m.to, m.from);
    }
    if (fs.existsSync(rec.backup)) fs.copyFileSync(rec.backup, rec.sidebarFile);
    log.info(`  ↺ ${rec.title}`);
  }
  return undo.steps.length;
}
