// Bericht nach dem Push: was dieser PC an bekannten Aenderungen eingebracht hat.
//
//   Neuer Content        Chat -> +N Zeilen (Transkripte, auch Unteragenten)
//   Neuer Chat           Chat (+N Zeilen)
//   Neues Repo           Chat -> Remote (seit dem letzten Push verknuepft)
//   Umbenannt            Chat alt -> neu, Gruppe alt -> neu
//   In Gruppe verschoben Chat: von -> nach
//   Angeheftet / Geloest / Archiviert / Wiederhergestellt / Geloescht
//
// Zeilen stehen seit 0.6.3 im Stand (n); fehlen sie im alten Stand, nennt der
// Bericht die Groessenaenderung.
import fs from 'node:fs';
import path from 'node:path';
import { clydeHome } from './paths.js';
import { absFor } from './scan.js';
import { fmtBytes } from './log.js';

const PUSHED = ['local', 'union', 'conflict-local', 'conflict-keep-local'];
const isEntry = (d) => d.root === 'desktop-sessions' && /(^|\/)local_[^/]+\.json$/.test(d.p);
const entryId = (p) => p.split('/').pop().slice(0, -'.json'.length);
const parse = (buf) => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } };

const recordFile = () => path.join(clydeHome(), 'last-push-report.json');
function loadSince() {
  try { return JSON.parse(fs.readFileSync(recordFile(), 'utf8')).at || null; } catch { return null; }
}
export function saveReportTime(at) {
  try { fs.mkdirSync(clydeHome(), { recursive: true }); fs.writeFileSync(recordFile(), JSON.stringify({ at })); } catch { /* nur fuer den naechsten Bericht */ }
}

// Gruppenname je Chat-Schluessel ("code:local_...") in einem appGroups-Stand
function groupNames(appGroups) {
  const out = new Map();
  for (const s of Object.values(appGroups?.scopes || {})) {
    const names = new Map((s.groups || []).map((g) => [g.id, g.name]));
    for (const [k, gid] of Object.entries(s.assignments || {})) if (names.has(gid)) out.set(k.replace(/^code:/, ''), names.get(gid));
  }
  return out;
}

// decisions: Entscheidungen des Pushs; extra: zusammengefuehrte Inhalte (Hash ->
// Daten); remote(d): Inhalt im bisherigen Stand; titles: Chat-ID -> Titel,
// byCli: CLI-Session-ID -> Chat-ID
export async function buildPushReport({ cfg, decisions, extra, remote, titles, byCli, oldGroups, newGroups, renamedGroups = [], refs, lastPushAt }) {
  const rep = { content: [], newChats: [], repos: [], renamed: [], moved: [], pinned: [], unpinned: [], archived: [], unarchived: [], deleted: [] };
  const title = (id) => titles.get(id) || id;
  const contentOf = async (d, which) => {
    if (which === 'new') {
      if (d.kind === 'union') return Buffer.concat(d.merged.c.map((h) => extra.get(h) || Buffer.alloc(0)));
      try { return fs.readFileSync(absFor(cfg.roots[d.root], d.l.lp)); } catch { return null; }
    }
    return d.r ? remote(d).catch(() => null) : null;
  };

  // Chat-Eintraege: neu, geloescht, Titel, Anheften, Archiv
  const newChatIds = new Set();
  for (const d of decisions) {
    if (!isEntry(d)) continue;
    const id = entryId(d.p);
    if (d.kind === 'local-delete') { const o = parse((await contentOf(d, 'old')) || Buffer.alloc(0)); rep.deleted.push(o?.title || title(id)); continue; }
    if (!PUSHED.includes(d.kind)) continue;
    const n = parse((await contentOf(d, 'new')) || Buffer.alloc(0));
    if (!n) continue;
    if (!d.r) {
      newChatIds.add(id);
      rep.newChats.push({ id, title: n.title || title(id), lines: 0 });
      if (n.isStarred) rep.pinned.push(n.title || title(id));
      continue;
    }
    const o = parse((await contentOf(d, 'old')) || Buffer.alloc(0));
    if (!o) continue;
    const t = n.title || title(id);
    if (o.title && n.title && o.title !== n.title) rep.renamed.push({ kind: 'chat', from: o.title, to: n.title });
    if (!!o.isStarred !== !!n.isStarred) (n.isStarred ? rep.pinned : rep.unpinned).push(t);
    if (!!o.isArchived !== !!n.isArchived) (n.isArchived ? rep.archived : rep.unarchived).push(t);
  }

  // Transkripte: Zeilen je Chat (Hauptverlauf und Unteragenten)
  const perChat = new Map();
  for (const d of decisions) {
    if (d.root !== 'claude-projects' || !d.p.toLowerCase().endsWith('.jsonl') || !PUSHED.includes(d.kind) || !d.merged) continue;
    const parts = d.p.split('/');
    if (parts.length < 2) continue;
    const cli = parts[1].replace(/\.jsonl$/i, '');
    const id = byCli.get(cli) || cli;
    const acc = perChat.get(id) || { lines: 0, bytes: 0, exact: true };
    const oldN = d.r ? d.r.n : 0;
    if (Number.isFinite(d.merged.n) && Number.isFinite(oldN)) acc.lines += d.merged.n - oldN;
    else acc.exact = false;
    acc.bytes += d.merged.s - (d.r?.s || 0);
    perChat.set(id, acc);
  }
  for (const [id, a] of perChat) {
    const nc = rep.newChats.find((c) => c.id === id);
    if (nc) { nc.lines = a.exact ? a.lines : null; nc.bytes = a.bytes; continue; }
    if (a.exact ? a.lines <= 0 : a.bytes <= 0) continue;
    rep.content.push({ title: title(id), lines: a.exact ? a.lines : null, bytes: a.bytes });
  }

  // Gruppen: umbenannt, Chats verschoben
  for (const r of renamedGroups) rep.renamed.push({ kind: 'group', from: r.from, to: r.to });
  const before = groupNames(oldGroups);
  const renamedFrom = new Map(renamedGroups.map((r) => [r.from, r.to]));
  for (const [id, to] of groupNames(newGroups)) {
    if (!titles.has(id) || newChatIds.has(id)) continue; // nur bekannte Chats dieses PCs
    const from = before.get(id) || null;
    if (from === to || (from && renamedFrom.get(from) === to)) continue;
    rep.moved.push({ title: title(id), from, to });
  }

  // Repos: seit dem letzten Push verknuepfte Chats
  const since = loadSince() || lastPushAt;
  if (since && refs) {
    for (const [id, l] of Object.entries(refs.chats || {})) {
      if (!l?.at || l.at <= since) continue;
      const e = refs.repos?.[l.repo];
      if (e) rep.repos.push({ title: title(id), remote: e.remote });
    }
  }
  return rep;
}

export function reportEmpty(rep) {
  return !Object.values(rep).some((v) => Array.isArray(v) && v.length);
}

const delta = (x) => (Number.isFinite(x.lines) && x.lines !== null ? `+${x.lines} Zeilen` : `+${fmtBytes(Math.max(0, x.bytes || 0))}`);
export function formatReport(rep) {
  const out = [];
  const section = (head, items) => { if (!items.length) return; out.push(`${head}:`); for (const i of items) out.push(`  * ${i}`); };
  section('Neuer Content', rep.content.map((c) => `${c.title} -> ${delta(c)}`));
  section('Neuer Chat', rep.newChats.map((c) => (c.lines || c.bytes ? `${c.title} (${delta(c)})` : c.title)));
  section('Neues Repo registriert', rep.repos.map((r) => `${r.title} -> ${r.remote}`));
  section('Umbenannt', rep.renamed.map((r) => `${r.kind === 'group' ? 'Gruppe ' : ''}${r.from} -> ${r.to}`));
  section('In Gruppe verschoben', rep.moved.map((m) => `${m.title}: ${m.from || 'ohne Gruppe'} -> ${m.to}`));
  section('Angeheftet', rep.pinned);
  section('Geloest (nicht mehr angeheftet)', rep.unpinned);
  section('Archiviert', rep.archived);
  section('Aus dem Archiv geholt', rep.unarchived);
  section('Geloescht', rep.deleted);
  return out;
}
