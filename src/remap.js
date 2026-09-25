// Projekt-Zuordnungen setzen oder entfernen (clyde map --add / --remove, Pull)
// ohne Kollateralschaden.
//
// Eine Zuordnung "neutral C -> hier X" gilt beim Abgleich fuer allen Inhalt. Beim
// Setzen oder Entfernen stellt Clyde nur die Dateien der Chats dieses Projekts auf
// den neuen Ort um: ihren Transkript-Ordner, ihre Sidebar-Eintraege, ihre Todos und
// die Zeilen der Eingabe-Historie mit diesem Projekt. Alle anderen Dateien bleiben
// byte-gleich, auch wenn sie den Pfad erwaehnen. Zeilen, die sich schon jetzt nicht
// verlustfrei umschreiben lassen, und Zeilen, die dabei ungueltiges JSON wuerden,
// bleiben ebenfalls unveraendert.
//
// Vorher zeigt ein Plan, was sich aendert und wo zwei Bedeutungen zusammenfallen
// wuerden. Chats des Projekts, die gerade arbeiten, blockieren. Die Originale
// landen in ~/.clyde/backups/map-<Zeit>/ (wird nie automatisch geloescht).
import fs from 'node:fs';
import path from 'node:path';
import { walkDir, absFor, formsFor } from './scan.js';
import { canonicalize, canonicalizeBuf, localizeBuf, localize, pathVariants, textMode, normalizeHome } from './rewrite.js';
import { liveSessions, ownSession, describeSession, sessionIds, pathBelongsTo } from './session.js';
import { backupFiles, pruneEmptyDirs } from './restore.js';
import { checkGuard } from './guard.js';

const win = process.platform === 'win32';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIDEBAR = /(^|\/)local_[^/]*\.json$/;

// Pfadvergleich: Trenner und (unter Windows) Gross/Klein egal; J1/J2-Platzhalter
// (so stehen sie nach JSON.parse im Text) zaehlen wie RAW
function norm(p) {
  const s = normalizeHome(String(p || ''))
    .replace(/@@CLYDE_(HOME|DRIVE)_J[12]@@/g, '@@CLYDE_$1_RAW@@')
    .replace(/[\\/]+/g, '/');
  return win ? s.toLowerCase() : s;
}
export function isUnder(p, dir) {
  const P = norm(p);
  const D = norm(dir);
  return !!D && (P === D || P.startsWith(`${D}/`));
}
const samePath = (a, b) => (win ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

const validJson = (b) => { try { JSON.parse(b.toString('utf8')); return true; } catch { return false; } };

// Inhalt einer Datei des Projekts umstellen: neutral mit den alten Regeln, lokal
// mit den neuen. lineFilter: nur passende Zeilen (Eingabe-Historie).
export function remapContent(raw, oldForms, newForms, mode, lineFilter, stats = {}) {
  stats.lines = stats.lines || 0;
  stats.kept = stats.kept || 0;
  if (!oldForms.length || !newForms.length) return raw;
  const parts = [];
  let start = 0;
  let changed = false;
  while (start <= raw.length) {
    const nl = raw.indexOf(10, start);
    const stop = nl === -1 ? raw.length : nl;
    const line = raw.subarray(start, stop);
    let out = line;
    if (line.length && (!lineFilter || lineFilter(line))) {
      const n = canonicalizeBuf(line, oldForms);
      if (!localizeBuf(n, oldForms).equals(line)) stats.kept++; // schon jetzt nicht verlustfrei: nicht anfassen
      else {
        const loc = localizeBuf(n, newForms);
        if (!loc.equals(line)) {
          if (mode === 'jsonl' && validJson(line) && !validJson(loc)) stats.kept++;
          else { out = loc; stats.lines++; changed = true; }
        }
      }
    }
    parts.push(out);
    if (nl === -1) break;
    parts.push(raw.subarray(nl, nl + 1));
    start = nl + 1;
  }
  if (!changed) return raw;
  const result = Buffer.concat(parts);
  if (mode === 'json' && validJson(raw) && !validJson(result)) { stats.kept++; return raw; }
  return result;
}

const mentions = (buf, needles) => needles.some((n) => buf.includes(n));

// Lokale Dateien mit neutralem Pfad (ohne Hashen; Clyde-Chats ausgenommen)
async function listLocal(cfg) {
  const roots = {};
  for (const [name, root] of Object.entries(cfg.roots)) {
    let files = [];
    try {
      const st = await fs.promises.stat(root.path);
      if (root.kind === 'file') files = st.isFile() ? [{ lp: path.basename(root.path) }] : [];
      else if (st.isDirectory()) files = (await walkDir(root.path)).files.map((f) => ({ lp: f.p }));
    } catch { /* fehlt */ }
    if (cfg.exclude?.length) files = files.filter((f) => !pathBelongsTo(f.lp, cfg.exclude));
    roots[name] = { files: files.map((f) => ({ lp: f.lp, p: canonicalize(f.lp, cfg.forms) })) };
  }
  return { roots };
}

// Plan: welche Dateien gehoeren zu den Chats, deren Projektordner "from" ist, und
// wohin kommen sie ("to")?
export async function planRemap(oldCfg, newCfg, { from, to }, log) {
  const local = await listLocal(oldCfg);
  const variants = (p) => [...new Set(Object.values(pathVariants(normalizeHome(p))))].filter((v) => v.length > 3).map((v) => Buffer.from(v));
  const fromV = variants(from);
  const toV = variants(to);
  const items = new Map();
  const ids = new Set();
  const chats = [];
  const chatsAtTarget = [];
  const add = (root, f, extra = {}) => {
    const key = `${root}|${f.lp}`;
    if (items.has(key)) return;
    const lpNew = localize(f.p, newCfg.forms);
    items.set(key, { root, lp: f.lp, lpNew, abs: absFor(oldCfg.roots[root], f.lp), absNew: absFor(newCfg.roots[root], lpNew), ...extra });
  };

  // 1. Sidebar-Eintraege mit diesem Projektordner
  const sbRoot = oldCfg.roots['desktop-sessions'];
  const sidebar = [];
  for (const f of local.roots['desktop-sessions']?.files || []) {
    if (!SIDEBAR.test(f.lp)) continue;
    let j;
    try { j = JSON.parse(await fs.promises.readFile(absFor(sbRoot, f.lp), 'utf8')); } catch { continue; }
    const cwds = [j.cwd, j.originCwd].filter((s) => typeof s === 'string' && s);
    const entry = { f, title: j.title || j.cliSessionId || path.basename(f.lp), id: path.basename(f.lp, '.json'), sid: j.cliSessionId || null };
    sidebar.push(entry);
    if (cwds.some((c) => isUnder(c, from))) {
      chats.push(entry.title);
      ids.add(entry.id);
      if (entry.sid) ids.add(entry.sid);
      add('desktop-sessions', f);
      entry.inScope = true;
    } else if (!samePath(from, to) && cwds.some((c) => isUnder(c, to))) chatsAtTarget.push(entry.title);
  }

  // 2. Dateien, deren Ablageort sich aendert (Transkript-Ordner des Projekts)
  for (const [name, r] of Object.entries(local.roots)) {
    if (!newCfg.roots[name]) continue;
    for (const f of r.files) {
      if (localize(f.p, newCfg.forms) === f.lp) continue;
      add(name, f);
      if (name === 'claude-projects') {
        const sid = (f.lp.split('/')[1] || '').replace(/\.jsonl$/, '');
        if (UUID.test(sid)) ids.add(sid);
      }
    }
  }
  // Sidebar-Eintraege dieser Transkripte, auch wenn ihr Ordner anders geschrieben ist
  for (const e of sidebar) {
    if (e.inScope || !e.sid || !ids.has(e.sid)) continue;
    chats.push(e.title);
    ids.add(e.id);
    add('desktop-sessions', e.f);
  }

  // 3. Weitere Dateien dieser Chats (Todos und aehnliches mit der Session-ID im Namen)
  for (const [name, r] of Object.entries(local.roots)) {
    const root = oldCfg.roots[name];
    if (!root || root.kind === 'file' || !newCfg.roots[name]) continue;
    for (const f of r.files) {
      if (!formsFor(oldCfg, root, f.lp).length) continue;
      if ([...ids].some((id) => f.lp.includes(id))) add(name, f);
    }
  }

  // 4. Eingabe-Historie: nur die Zeilen mit diesem Projekt
  const lineFilter = (line) => {
    try { const j = JSON.parse(line.toString('utf8')); return typeof j.project === 'string' && isUnder(j.project, from); } catch { return false; }
  };
  for (const [name, root] of Object.entries(oldCfg.roots)) {
    if (root.kind !== 'file' || !newCfg.roots[name]) continue;
    for (const f of local.roots[name]?.files || []) add(name, f, { lineFilter });
  }

  // Wirkung je Datei berechnen (noch nichts schreiben)
  const stats = { lines: 0, kept: 0 };
  let moved = 0, rewritten = 0, targetMentions = 0, conflicts = [];
  for (const it of items.values()) {
    const raw = await fs.promises.readFile(it.abs);
    const oldForms = formsFor(oldCfg, oldCfg.roots[it.root], it.lp);
    const newForms = formsFor(newCfg, newCfg.roots[it.root], it.lpNew);
    const before = stats.lines;
    const out = remapContent(raw, oldForms, newForms, textMode(it.lp), it.lineFilter, stats);
    it.moved = it.lpNew !== it.lp;
    it.changed = !out.equals(raw);
    if (it.moved && !samePath(it.abs, it.absNew) && fs.existsSync(it.absNew)) { conflicts.push(it); it.skip = true; continue; }
    if (it.moved) moved++;
    else if (it.changed) rewritten++;
    if (stats.lines > before && oldForms.length && !it.lineFilter && mentions(raw, toV)) targetMentions++;
  }
  const todo = [...items.values()].filter((it) => !it.skip && (it.moved || it.changed));

  // Andere Dateien, die den bisherigen Ort nur erwaehnen: bleiben, wie sie sind
  let mentionsElsewhere = 0;
  for (const [name, r] of Object.entries(local.roots)) {
    const root = oldCfg.roots[name];
    if (!root || root.kind === 'file') continue;
    for (const f of r.files) {
      if (items.has(`${name}|${f.lp}`) || !formsFor(oldCfg, root, f.lp).length) continue;
      try { if (mentions(await fs.promises.readFile(absFor(root, f.lp)), fromV)) mentionsElsewhere++; } catch { /* weg */ }
    }
  }

  const own = ownSession();
  const inScope = liveSessions().filter((s) => s.sessionId !== own?.sessionId && sessionIds(s).some((id) => ids.has(id)));
  const warnings = [];
  if (!samePath(from, to) && fs.existsSync(from) && (moved || rewritten)) warnings.push(`${from} gibt es auf diesem PC als Ordner. Die Chats oben zeigen danach trotzdem auf ${to}.`);
  if (chatsAtTarget.length) warnings.push(`${to} ist hier schon Projektordner von ${chatsAtTarget.length} Chat(s): ${chatsAtTarget.slice(0, 6).join(' | ')}${chatsAtTarget.length > 6 ? ' | ...' : ''}. Beide Gruppen gelten danach als dasselbe Projekt, auch auf den anderen PCs.`);
  if (targetMentions) warnings.push(`${targetMentions} der umzustellenden Dateien erwaehnen ${to} bereits. Danach ist dort nicht mehr zu unterscheiden, was vorher ${from} war.`);
  if (conflicts.length) warnings.push(`${conflicts.length} Datei(en) gibt es am neuen Ort schon; sie werden nicht ueberschrieben und bleiben am alten Ort: ${conflicts.slice(0, 3).map((c) => c.lpNew).join(', ')}`);
  return {
    from, to, chats, ids: [...ids], todo, moved, rewritten, lines: stats.lines, kept: stats.kept,
    mentionsElsewhere, warnings,
    busy: inScope.filter((s) => s.status !== 'idle').map(describeSession),
    open: inScope.filter((s) => s.status === 'idle').map(describeSession),
  };
}

export function describeRemap(plan) {
  const info = [];
  info.push(plan.chats.length ? `  Chats mit Projektordner ${plan.from}: ${plan.chats.length} (${plan.chats.slice(0, 8).join(' | ')}${plan.chats.length > 8 ? ' | ...' : ''})` : `  Hier gibt es keine Chats mit Projektordner ${plan.from}.`);
  info.push(`  Dateien: ${plan.moved} nach ${plan.to} verschieben, ${plan.rewritten} weitere mit neuem Pfad; ${plan.lines} Zeilen aendern sich.`);
  if (plan.kept) info.push(`  ${plan.kept} Zeilen lassen sich nicht verlustfrei umschreiben und bleiben unveraendert.`);
  if (plan.mentionsElsewhere) info.push(`  ${plan.mentionsElsewhere} andere Dateien erwaehnen ${plan.from}; sie gehoeren nicht zu diesen Chats und bleiben unveraendert.`);
  if (plan.open.length) info.push(`  In der App geoeffnet (danach die App neu starten, bevor du dort weiterschreibst): ${plan.open.join(', ')}`);
  const warn = plan.warnings.map((w) => `Achtung: ${w}`);
  if (plan.busy.length) warn.push(`Diese Chats des Projekts arbeiten gerade und blockieren: ${plan.busy.join(', ')}`);
  return { info, warn };
}

export const remapNeedsConfirm = (plan) => plan.todo.length > 0 || plan.warnings.length > 0;

// Plan umsetzen. Unmittelbar vorher wird erneut geprueft, ob ein Chat des Projekts
// arbeitet; die Originale werden gesichert, die Aenderungszeit bleibt erhalten.
export async function applyRemap(plan, oldCfg, newCfg, opts, log) {
  if (!plan.todo.length) return { written: 0, backupDir: null };
  const own = ownSession();
  const ids = new Set(plan.ids);
  const busy = liveSessions().filter((s) => s.sessionId !== own?.sessionId && s.status !== 'idle' && sessionIds(s).some((id) => ids.has(id)));
  if (busy.length && !opts.force) throw new Error(`Umstellen abgebrochen, diese Chats des Projekts arbeiten gerade:\n${busy.map((s) => `  - ${describeSession(s)}`).join('\n')}\nWarten, bis sie fertig sind, dann erneut aufrufen.`);
  checkGuard('Umstellen der Zuordnung', opts.force, log);
  const backupDir = await backupFiles('map', plan.todo.map((it) => ({ root: it.root, lp: it.lp, abs: it.abs })), log);
  const rootSet = new Set(Object.values(oldCfg.roots).map((r) => path.resolve(r.path)));
  const parents = new Set();
  for (const it of plan.todo) {
    const raw = await fs.promises.readFile(it.abs);
    const st = await fs.promises.stat(it.abs);
    const out = remapContent(raw, formsFor(oldCfg, oldCfg.roots[it.root], it.lp), formsFor(newCfg, newCfg.roots[it.root], it.lpNew), textMode(it.lp), it.lineFilter);
    await fs.promises.mkdir(path.dirname(it.absNew), { recursive: true });
    const tmp = `${it.absNew}.clyde-tmp`;
    await fs.promises.writeFile(tmp, out);
    await fs.promises.rename(tmp, it.absNew);
    await fs.promises.utimes(it.absNew, st.atime, st.mtime);
    if (!samePath(it.abs, it.absNew)) { await fs.promises.rm(it.abs, { force: true }); parents.add(path.dirname(it.abs)); }
    log.debug(`umgestellt ${it.root}/${it.lp}${it.moved ? ` -> ${it.lpNew}` : ''}`);
  }
  for (const dir of parents) await pruneEmptyDirs(dir, rootSet);
  log.info(`${plan.moved} Dateien verschoben, ${plan.rewritten} mit neuem Pfad versehen. Originale gesichert unter ${backupDir}`);
  return { written: plan.todo.length, backupDir };
}

// Zuordnung aendern: Plan zeigen, bei Bedarf bestaetigen lassen, umsetzen.
// Liefert {applied, plan}; die Konfiguration speichert der Aufrufer (nur wenn applied).
// Ohne Terminal (Plugin) wird ohne --yes nichts geaendert.
// onlyOnWarnings: nur bei Warnungen nachfragen (der Nutzer hat den Pfad gerade selbst gewaehlt)
export async function changeMapping({ oldCfg, newCfg, from, to, title, opts, log, ask, onlyOnWarnings = false }) {
  const plan = await planRemap(oldCfg, newCfg, { from, to }, log);
  const { info, warn } = describeRemap(plan);
  log.info(title);
  for (const l of info) log.info(l);
  for (const w of warn) log.warn(w);
  if (opts.dryRun) { log.info('Trockenlauf, nichts geaendert.'); return { applied: false, plan }; }
  if (plan.busy.length && !opts.force) throw new Error('Abgebrochen: Chats des Projekts arbeiten gerade. Warten, bis sie fertig sind, dann erneut aufrufen.');
  const needs = onlyOnWarnings ? plan.warnings.length > 0 : remapNeedsConfirm(plan);
  if (needs && !opts.yes) {
    if (!ask) throw new Error('Nichts geaendert. Plan oben pruefen und mit --yes bestaetigen.');
    const a = String(await ask('Ausfuehren? [j/N] ')).trim().toLowerCase();
    if (!['j', 'ja', 'y', 'yes'].includes(a)) { log.info('Abgebrochen, nichts geaendert.'); return { applied: false, plan }; }
  }
  await applyRemap(plan, oldCfg, newCfg, opts, log);
  return { applied: true, plan };
}
