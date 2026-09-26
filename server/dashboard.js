// Daten fuer das Dashboard: Chats eines Snapshots mit Titel, Projektordner,
// Modell, Aktivitaet und Transkript-Groesse, dazu die Pfadwerte des Quell-PCs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allForms, localize } from '../src/rewrite.js';
import { groupLookup } from '../src/appgroups.js';
import { chatPlaces } from '../src/places.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function dashboardHtml() {
  return fs.readFileSync(path.join(here, 'dashboard.html'));
}

async function readSmallFile(store, f) {
  const parts = [];
  for (const h of f.c) parts.push(await store.getBlob(h));
  return Buffer.concat(parts);
}

const toMs = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
};

// Angaben aus dem Anfang eines Transkripts (erster Chunk, hoechstens 4 MiB):
// eigener Titel oder Zusammenfassung, erste Nutzer-Nachricht, Projektordner,
// Modell, Herkunft. Zwischengespeichert nach Chunk-Hash.
const infoCache = new Map();
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join(' ');
  return '';
}
async function transcriptInfo(store, f) {
  if (!f.c.length) return {};
  const key = f.c[0];
  if (infoCache.has(key)) return infoCache.get(key);
  const info = {};
  try {
    let lines = (await store.getBlob(key)).toString('utf8').split('\n');
    if (f.c.length > 1) lines = lines.slice(0, -1); // letzte Zeile ist evtl. abgeschnitten
    for (const line of lines.slice(0, 600)) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || typeof o !== 'object') continue;
      if (!info.customTitle && typeof o.customTitle === 'string') info.customTitle = o.customTitle;
      if (!info.summary && o.type === 'summary' && typeof o.summary === 'string') info.summary = o.summary;
      if (!info.cwd && typeof o.cwd === 'string') info.cwd = o.cwd;
      if (!info.entrypoint && typeof o.entrypoint === 'string') info.entrypoint = o.entrypoint;
      if (!info.gitBranch && typeof o.gitBranch === 'string' && o.gitBranch) info.gitBranch = o.gitBranch;
      if (!info.started && typeof o.timestamp === 'string') info.started = o.timestamp;
      if (!info.model && o.type === 'assistant' && typeof o.message?.model === 'string' && !o.message.model.startsWith('<')) info.model = o.message.model;
      if (!info.firstPrompt && o.type === 'user' && !o.isMeta && o.message?.role === 'user') {
        const t = textOf(o.message.content).trim();
        if (t && !t.startsWith('<')) info.firstPrompt = t.replace(/\s+/g, ' ').slice(0, 120);
      }
      if (info.firstPrompt && info.model && info.cwd && info.entrypoint && (info.summary || info.customTitle)) break;
    }
  } catch { /* Chunk nicht lesbar */ }
  if (infoCache.size > 5000) infoCache.clear();
  infoCache.set(key, info);
  return info;
}

// refs: Verweise des Benutzers (wo die Chats auf welchem Geraet ihr Wissen haben)
export async function chatsForSnapshot(store, man, refs = null) {
  // Platzhalter so darstellen, wie die Pfade auf dem Quell-PC aussahen
  const forms = allForms(man.home, man.projectDrive, {});
  const shown = (s) => (typeof s === 'string' ? localize(s, forms) : s);
  // Werte aus geparstem JSON: die Datei enthielt die JSON-escapte Schreibweise (J1),
  // nach dem Parsen ist der Wert eine Stufe "roher" (J1 -> RAW, J2 -> J1)
  const unJson = (s) => (typeof s === 'string' ? s.replace(/_(J1|J2)@@/g, (m, k) => (k === 'J1' ? '_RAW@@' : '_J1@@')) : s);
  const show = (s) => shown(unJson(s));

  const projRoot = man.roots['claude-projects'] || { files: [] };
  const transcripts = new Map();
  const perProject = new Map();
  for (const f of projRoot.files) {
    const m = /^([^/]+)\/([^/]+)\.jsonl$/.exec(f.p);
    if (!m) continue;
    transcripts.set(f.p, { id: m[2], path: f.p, project: m[1], projectShown: shown(m[1]), size: f.s, mtime: f.m, chunks: f.c.length, file: f });
    const pp = perProject.get(m[1]) || { key: m[1], keyShown: shown(m[1]), transcripts: 0, bytes: 0 };
    pp.transcripts++;
    pp.bytes += f.s;
    perProject.set(m[1], pp);
  }

  // Chats, die in der App geloescht wurden: die App entfernt nur den Eintrag aus
  // der Chatliste und hinterlegt <id>.desktop-released.json, das Transkript bleibt
  const released = new Map();
  for (const f of projRoot.files) {
    const m = /^[^/]+\/([^/]+)\.desktop-released\.json$/.exec(f.p);
    if (!m || f.s > 64 * 1024) continue;
    let reason = 'released';
    try { reason = JSON.parse((await readSmallFile(store, f)).toString('utf8')).reason || reason; } catch { /* egal */ }
    released.set(m[1], reason);
  }

  const byId = new Map();
  for (const t of transcripts.values()) byId.set(t.id, t);
  // Gruppen der Chatliste (vom Quell-PC mitgeschickt, nur Namen und Zuordnungen)
  const groups = groupLookup(man.appGroups);
  const chats = [];
  const seen = new Set();
  const sessRoot = man.roots['desktop-sessions'] || { files: [], missing: true };
  for (const f of sessRoot.files) {
    if (!f.p.endsWith('.json') || f.s > 1024 * 1024) continue;
    let j;
    try { j = JSON.parse((await readSmallFile(store, f)).toString('utf8')); } catch { continue; }
    // Nur Chat-Eintraege; andere Dateien im Ordner (z. B. scheduled-tasks.json) auslassen
    if (!j || typeof j !== 'object' || (typeof j.sessionId !== 'string' && typeof j.cliSessionId !== 'string')) continue;
    const cli = typeof j.cliSessionId === 'string' ? j.cliSessionId : null;
    const linked = cli ? byId.get(cli) : null;
    if (linked) seen.add(linked.path);
    chats.push({
      file: f.p, sidebar: true, kind: 'app',
      sessionId: j.sessionId, cliSessionId: cli,
      title: j.title || null, titleSource: j.titleSource || null,
      cwd: unJson(j.cwd || null), cwdShown: show(j.cwd || null), originCwd: show(j.originCwd || null),
      model: j.model || null, effort: j.effort || null, permissionMode: j.permissionMode || null,
      isArchived: !!j.isArchived,
      createdAt: toMs(j.createdAt), lastActivityAt: toMs(j.lastActivityAt), lastFocusedAt: toMs(j.lastFocusedAt),
      appGroup: (typeof j.sessionId === 'string' && groups.byChat.get(j.sessionId)) || null,
      places: refs && typeof j.sessionId === 'string' ? chatPlaces(refs, j.sessionId, unJson(j.cwd || null)) : [],
      transcript: linked || null,
    });
  }
  for (const t of transcripts.values()) {
    if (seen.has(t.path)) continue;
    const info = await transcriptInfo(store, t.file);
    const kind = released.get(t.id) === 'delete' ? 'deleted' : 'transcript';
    chats.push({
      file: null, sidebar: false, kind, cliSessionId: t.id,
      title: info.customTitle || info.summary || info.firstPrompt || null,
      firstPrompt: info.firstPrompt || null,
      cwd: unJson(info.cwd || null), cwdShown: show(info.cwd || null),
      model: info.model || null, origin: info.entrypoint || null, gitBranch: info.gitBranch || null,
      isArchived: false, createdAt: toMs(info.started), lastActivityAt: t.mtime, transcript: t,
    });
  }
  for (const c of chats) if (c.transcript) delete c.transcript.file;
  chats.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  const counts = { app: 0, deleted: 0, transcript: 0 };
  for (const c of chats) counts[c.kind]++;

  return {
    snapshot: {
      id: man.id, createdAt: man.createdAt, host: man.host, user: man.user, platform: man.platform,
      home: man.home, projectDrive: man.projectDrive || null, claudeHome: man.claudeHome || null,
      rootPaths: man.rootPaths || {}, stats: man.stats,
      chatListMissing: !!sessRoot.missing || !sessRoot.files.length,
      hasAppGroups: groups.ranks.size > 0,
      projects: (man.projects || []).map((p) => ({ canonical: p, shown: shown(p) })),
      roots: Object.fromEntries(Object.entries(man.roots).map(([n, r]) => [n, { files: r.files.length, bytes: r.files.reduce((a, f) => a + f.s, 0), links: (r.links || []).length, missing: !!r.missing }])),
    },
    projects: [...perProject.values()].sort((a, b) => b.bytes - a.bytes),
    chats,
    counts,
    transcriptsTotal: transcripts.size,
  };
}
