// Daten fuer das Admin-Dashboard: Chats eines Snapshots mit Titel, Projektpfad,
// Modell, Aktivitaet und Transkript-Groesse, dazu die Pfadwerte des Quell-PCs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allForms, localize } from '../src/rewrite.js';

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

export async function chatsForSnapshot(store, man) {
  // Platzhalter so darstellen, wie die Pfade auf dem Quell-PC aussahen
  const forms = allForms(man.home, man.projectDrive, {});
  const shown = (s) => (typeof s === 'string' ? localize(s, forms) : s);
  // Werte aus geparstem JSON: die Datei enthielt die JSON-escapte Schreibweise (J1),
  // nach dem Parsen ist der Wert eine Stufe "roher" (J1 -> RAW, J2 -> J1)
  const unJson = (s) => (typeof s === 'string' ? s.replace(/_(J1|J2)@@/g, (m, k) => (k === 'J1' ? '_RAW@@' : '_J1@@')) : s);

  const projRoot = man.roots['claude-projects'] || { files: [] };
  const transcripts = new Map();
  const perProject = new Map();
  for (const f of projRoot.files) {
    const m = /^([^/]+)\/([^/]+)\.jsonl$/.exec(f.p);
    if (!m) continue;
    transcripts.set(f.p, { id: m[2], path: f.p, project: m[1], projectShown: shown(m[1]), size: f.s, mtime: f.m, chunks: f.c.length });
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
  const chats = [];
  const seen = new Set();
  const sessRoot = man.roots['desktop-sessions'] || { files: [] };
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
      cwd: unJson(j.cwd || null), cwdShown: shown(unJson(j.cwd || null)), originCwd: shown(unJson(j.originCwd || null)),
      model: j.model || null, effort: j.effort || null, permissionMode: j.permissionMode || null,
      isArchived: !!j.isArchived,
      createdAt: toMs(j.createdAt), lastActivityAt: toMs(j.lastActivityAt), lastFocusedAt: toMs(j.lastFocusedAt),
      transcript: linked || null,
    });
  }
  for (const t of transcripts.values()) {
    if (seen.has(t.path)) continue;
    const kind = released.get(t.id) === 'delete' ? 'deleted' : 'transcript';
    chats.push({ file: null, sidebar: false, kind, cliSessionId: t.id, title: null, cwd: null, cwdShown: null, model: null, isArchived: false, createdAt: null, lastActivityAt: t.mtime, transcript: t });
  }
  chats.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  const counts = { app: 0, deleted: 0, transcript: 0 };
  for (const c of chats) counts[c.kind]++;

  return {
    snapshot: {
      id: man.id, createdAt: man.createdAt, host: man.host, user: man.user, platform: man.platform,
      home: man.home, projectDrive: man.projectDrive || null, claudeHome: man.claudeHome || null,
      rootPaths: man.rootPaths || {}, stats: man.stats,
      projects: (man.projects || []).map((p) => ({ canonical: p, shown: shown(p) })),
      roots: Object.fromEntries(Object.entries(man.roots).map(([n, r]) => [n, { files: r.files.length, bytes: r.files.reduce((a, f) => a + f.s, 0), links: (r.links || []).length, missing: !!r.missing }])),
    },
    projects: [...perProject.values()].sort((a, b) => b.bytes - a.bytes),
    chats,
    counts,
    transcriptsTotal: transcripts.size,
  };
}
