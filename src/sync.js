// Push und Pull als Zusammenfuehren (Standard seit 0.4) und das Fusionieren
// zweier gespeicherter Staende ("clyde merge").
import os from 'node:os';
import { Client } from './client.js';
import { buildLocalManifest, absFor, formsFor } from './scan.js';
import { applyPlan } from './restore.js';
import { canonicalSource, chunkStream } from './chunker.js';
import { localize } from './rewrite.js';
import { pathBelongsTo } from './session.js';
import { readAppGroups, reconcileGroups, loadGroupLinks, saveGroupLinks } from './appgroups.js';
import { loadBase, saveBase, flatten, decide, unionLines, chunksOf, sigOf, isSidebarEntry, mergeEntry, loadBaseEntries } from './merge.js';
import { fmtBytes } from './log.js';
import { syncRefs, describeProblem } from './refs.js';
import { checkVersions } from './version.js';

// v3 (0.4.2): woertliche Platzhalter im Inhalt sind maskiert (@@CLYDE_ESC_).
// Staende v2 lassen sich weiter lesen; Clyde < 0.4.2 lehnt v3 ab und kann so
// maskierte Inhalte nicht falsch einsetzen.
export const MANIFEST_VERSION = 3;
const READABLE = [2, 3];

export async function fetchLatest(client, id) {
  try {
    const snap = await client.getSnapshot(id || 'latest');
    if (!READABLE.includes(snap.version)) throw new Error(`Snapshot ${snap.id} hat Format v${snap.version}, dieser Client kennt v${READABLE.join(', v')}. ${snap.version > MANIFEST_VERSION ? 'Clyde auf diesem PC aktualisieren.' : 'Auf einem PC mit aktuellem Clyde neu pushen.'}`);
    return snap;
  } catch (e) {
    if (!id && /HTTP 404/.test(e.message)) return null;
    throw e;
  }
}

async function readAll(stream) { const parts = []; for await (const c of stream) parts.push(c); return Buffer.concat(parts); }
async function localCanonical(cfg, l) {
  const root = cfg.roots[l.root];
  return readAll(canonicalSource(absFor(root, l.lp), formsFor(cfg, root, l.lp)));
}
async function remoteContent(client, f) {
  const parts = new Map();
  for (let i = 0; i < f.c.length; i += 16) {
    await client.fetchBlobs(f.c.slice(i, i + 16), async ({ hash, data }) => { parts.set(hash, data); });
  }
  return Buffer.concat(f.c.map((h) => parts.get(h)));
}

// Zusammengefuehrte Inhalte bilden; liefert Zusatz-Chunks (Hash -> Daten)
// getBase (optional): Inhalt zur Basis, fuer Chat-Eintraege der Seitenleiste
async function resolveUnions(decisions, getA, getB, getBase = null) {
  const extra = new Map();
  for (const d of decisions) {
    if (!d.union) continue;
    const [a, b] = [await getA(d), await getB(d)];
    const aNewer = (d.l.m || 0) >= (d.r.m || 0);
    if (isSidebarEntry(d.root, d.p)) {
      const base = getBase ? await getBase(d) : null;
      const buf = (aNewer ? mergeEntry(a, b, base) : mergeEntry(b, a, base)) || (aNewer ? a : b);
      const chunks = await chunksOf(buf);
      for (const c of chunks) extra.set(c.hash, c.data);
      d.merged = { root: d.root, p: d.p, s: buf.length, m: Math.max(d.l.m || 0, d.r.m || 0), c: chunks.map((c) => c.hash) };
      continue;
    }
    const byUuid = d.p.toLowerCase().endsWith('.jsonl');
    const buf = aNewer ? unionLines(a, b, { byUuid }) : unionLines(b, a, { byUuid });
    const chunks = await chunksOf(buf);
    for (const c of chunks) extra.set(c.hash, c.data);
    d.merged = { root: d.root, p: d.p, s: buf.length, m: Math.max(d.l.m || 0, d.r.m || 0), c: chunks.map((c) => c.hash) };
  }
  return extra;
}

function mergeLinks(...lists) {
  const byPath = new Map();
  for (const list of lists) for (const ln of list || []) byPath.set(ln.p, ln);
  return [...byPath.values()];
}
// Gruppen zusammenfuehren. Gleichnamige Gruppen sind dieselbe Gruppe, auch wenn ein
// anderer PC sie mit eigener ID angelegt hat (etwa per /clyde:groups): b's
// Zuordnungen werden auf die ID aus a umgeschrieben, damit keine Doppelten entstehen.
export function mergeAppGroups(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const scopes = { ...a.scopes };
  const key = (n) => String(n).trim().toLowerCase();
  for (const [s, v] of Object.entries(b.scopes || {})) {
    const cur = scopes[s] || { groups: [], assignments: {}, order: {} };
    const idByName = new Map(cur.groups.map((g) => [key(g.name), g.id]));
    const ids = new Set(cur.groups.map((g) => g.id));
    const remap = new Map();
    const added = [];
    for (const g of v.groups || []) {
      const same = idByName.get(key(g.name));
      if (same) { remap.set(g.id, same); continue; }
      if (!ids.has(g.id)) { added.push(g); ids.add(g.id); idByName.set(key(g.name), g.id); }
    }
    const to = (gid) => remap.get(gid) || gid;
    const assignments = { ...cur.assignments };
    for (const [k, gid] of Object.entries(v.assignments || {})) assignments[k] = to(gid);
    const order = { ...cur.order };
    for (const [gid, list] of Object.entries(v.order || {})) order[to(gid)] = list;
    scopes[s] = { groups: [...cur.groups, ...added], assignments, order };
  }
  return { scopes, starred: [...new Set([...(a.starred || []), ...(b.starred || [])])] };
}

// Manifest aus einer Datei-Map bauen
function buildRoots(M, kinds, links) {
  const roots = {};
  for (const [root, kind] of Object.entries(kinds)) roots[root] = { kind, files: [], links: links[root] || [] };
  for (const f of M.values()) {
    if (!roots[f.root]) roots[f.root] = { kind: kinds[f.root] || 'dir', files: [], links: links[f.root] || [] };
    roots[f.root].files.push({ p: f.p, s: f.s, m: f.m, c: f.c });
  }
  for (const r of Object.values(roots)) r.files.sort((x, y) => (x.p < y.p ? -1 : x.p > y.p ? 1 : 0));
  return roots;
}
const statsOf = (roots) => {
  let files = 0, bytes = 0; const chunks = new Set();
  for (const r of Object.values(roots)) for (const f of r.files) { files++; bytes += f.s; f.c.forEach((h) => chunks.add(h)); }
  return { files, bytes, chunks: chunks.size };
};

function makeId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'host';
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}-${host}`;
}

// Chunks hochladen, die dem Server fehlen: aus lokalen Dateien oder aus Zusatz-Chunks
async function uploadMissing(client, local, extra, hashes, limitBytes, log) {
  const missing = [];
  const all = [...hashes];
  for (let i = 0; i < all.length; i += 5000) missing.push(...(await client.missing(all.slice(i, i + 5000))).missing);
  if (!missing.length) return { chunks: 0, bytes: 0 };
  const bySource = new Map();
  const fromExtra = [];
  for (const h of missing) {
    if (extra.has(h)) { fromExtra.push(h); continue; }
    const loc = local.chunkIndex.get(h);
    if (!loc) throw new Error(`Chunk ${h.slice(0, 12)} ist weder lokal noch auf dem Server vorhanden`);
    if (!bySource.has(loc.abs)) bySource.set(loc.abs, { forms: loc.forms, hashes: new Set() });
    bySource.get(loc.abs).hashes.add(h);
  }
  let batch = [], batchBytes = 0, chunks = 0, bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await client.upload(batch);
    chunks += batch.length; bytes += batchBytes; batch = []; batchBytes = 0;
    log.info(`  hochgeladen ${chunks}/${missing.length} Chunks (${fmtBytes(bytes)})`);
  };
  const add = async (hash, data) => {
    if (batch.length && (batchBytes + data.length > limitBytes || batch.length >= 400)) await flush();
    batch.push({ hash, data }); batchBytes += data.length;
  };
  for (const h of fromExtra) await add(h, extra.get(h));
  for (const [abs, { forms, hashes: hs }] of bySource) {
    for await (const c of chunkStream(canonicalSource(abs, forms))) if (hs.delete(c.hash)) await add(c.hash, c.data);
    if (hs.size) { const e = new Error(`Datei hat sich waehrend des Push geaendert: ${abs}`); e.code = 'CHANGED'; e.abs = abs; throw e; }
  }
  await flush();
  return { chunks, bytes };
}

const describe = (decisions) => {
  const n = (k) => decisions.filter((d) => k.includes(d.kind)).length;
  return { pull: n(['remote', 'conflict-remote', 'conflict-keep-remote']), pullDelete: n(['remote-delete']), push: n(['local', 'conflict-local', 'conflict-keep-local']), pushDelete: n(['local-delete']), union: n(['union']), conflicts: decisions.filter((d) => d.conflict || d.union).length };
};

// Gemeinsame Vorbereitung fuer Push und Pull
export async function prepare(cfg, client, snap, log, scanOpts = {}) {
  const local = await buildLocalManifest(cfg, log, scanOpts);
  const rootsHere = Object.keys(cfg.roots);
  const excluded = (p) => cfg.exclude.length && pathBelongsTo(p, cfg.exclude);
  const L = flatten(local.roots);
  const R = new Map([...flatten(snap?.roots || {}, rootsHere)].filter(([, f]) => !excluded(f.p)));
  const base = loadBase(cfg);
  let baseFiles = base.files;
  // Ist der Stand, mit dem dieser PC zuletzt abgeglichen hat, auf dem Server
  // geloescht (etwa der neueste), passt die Basis nicht mehr zum Konto: dann nur
  // vereinigen. Sonst wuerde alles, was nur in dem geloeschten Stand hinzukam,
  // hier geloescht oder zurueckgedreht.
  let baseMissing = null;
  if (base.snapshotId && snap && base.snapshotId !== snap.id) {
    const { snapshots } = await client.listSnapshots();
    if (!snapshots.some((s) => s.id === base.snapshotId)) {
      baseMissing = base.snapshotId;
      baseFiles = new Map();
      log.warn(`Der Stand ${base.snapshotId}, mit dem dieser PC zuletzt abgeglichen hat, ist auf dem Server geloescht. Dieser Abgleich vereinigt deshalb nur: hier wird nichts geloescht, und Loeschungen anderer PCs kommen diesmal nicht an.`);
    }
  }
  const B = new Map([...baseFiles].filter(([k]) => !excluded(k)));
  const decisions = decide(L, R, B);
  return { local, L, R, decisions, baseMissing };
}

export async function syncPush(cfg, opts, log) {
  const client = new Client(cfg.server, cfg.token);
  checkVersions(await client.health(), log);
  // Verweise (Repos der Chats, Orte je Geraet): eintragen, pruefen, Korrekturen
  // sofort hochladen - unabhaengig davon, ob danach ein neuer Stand entsteht
  let refsRes = null;
  if (!opts.noRepos && cfg.raw?.repos !== false) {
    try { refsRes = await syncRefs(cfg, client); } catch (e) { log.warn(`Verweise nicht aktualisiert: ${e.message}`); }
    if (refsRes?.unsupported) log.warn('Der Server kennt noch keine Verweise (Repos je Chat). Server aktualisieren: git pull, dann docker compose up -d --build');
    for (const w of refsRes?.work || []) {
      const i = w.info;
      const miss = [i.ahead && `${i.ahead} Commit(s) nicht gepusht`, i.dirty && `${i.dirty} geaenderte Datei(en) nicht committet`, i.untracked && `${i.untracked} neue Datei(en)`, i.branch && !i.upstream && `Branch ${i.branch} hat keinen Upstream`].filter(Boolean);
      log.warn(`Git-Repo ${w.root}: ${miss.join(', ')}. Auf den anderen PCs kommt nur an, was auf dem Remote liegt.`);
    }
    for (const pr of refsRes?.problems || []) log.warn(describeProblem(pr));
  }
  const forget = new Set(); // Dateien, deren gecachter Hash nicht mehr stimmt
  for (let attempt = 1; ; attempt++) {
    const snap = await fetchLatest(client);
    log.info(`Scanne lokalen Zustand (Home ${cfg.home}) ...`);
    const { local, L, R, decisions } = await prepare(cfg, client, snap, log, { rehash: opts.rehash, forget });
    const ex = local.stats.excluded ? `, ${local.stats.excluded} Dateien des Clyde-Chats ausgelassen` : '';
    log.info(`  ${local.stats.files} Dateien, ${fmtBytes(local.stats.bytes)} (${local.stats.hashedFiles} neu gehasht${ex})`);
    const entries = loadBaseEntries(cfg);
    const extra = await resolveUnions(decisions, (d) => localCanonical(cfg, d.l), (d) => remoteContent(client, d.r), (d) => (entries.has(d.key) ? Buffer.from(entries.get(d.key)) : null));
    const info = describe(decisions);
    const PUSH_KINDS = ['local', 'local-delete', 'union', 'conflict-local', 'conflict-keep-local'];
    // Gruppen: Umbenennungen und neue Gruppen von hier einbringen (loesen allein
    // einen neuen Stand aus; andere Einordnungen reisen mit dem naechsten Push mit)
    const grp = reconcileGroups(snap?.appGroups || null, readAppGroups(cfg), loadGroupLinks(cfg));
    const groupsChanged = grp.renamed.length > 0 || grp.added.length > 0;
    const changed = !snap ? L.size > 0 : decisions.some((d) => PUSH_KINDS.includes(d.kind)) || groupsChanged;
    if (snap && !changed) {
      saveBase(cfg, L, snap.id);
      saveGroupLinks(cfg, grp.links);
      log.info(`Nichts Neues hochzuladen, der gemeinsame Stand ${snap.id} enthaelt alles von diesem PC.${info.pull || info.pullDelete ? ` Auf dem Server gibt es ${info.pull + info.pullDelete} Aenderungen anderer PCs: "clyde pull" holt sie.` : ''}`);
      return { id: snap.id, uploadedChunks: 0, uploadedBytes: 0, unchanged: true, stats: snap.stats, excluded: local.stats.excluded };
    }
    const M = new Map();
    for (const d of decisions) if (d.merged) M.set(d.key, { ...d.merged, root: d.root, p: d.p });
    // Bereiche, die dieser PC nicht kennt, bleiben wie im gemeinsamen Stand
    const kinds = Object.fromEntries(Object.entries(cfg.roots).map(([n, r]) => [n, r.kind]));
    const foreign = Object.entries(snap?.roots || {}).filter(([n]) => !cfg.roots[n]);
    const links = {};
    for (const n of Object.keys(kinds)) links[n] = mergeLinks(snap?.roots?.[n]?.links, local.roots[n]?.links);
    const roots = buildRoots(M, kinds, links);
    for (const [n, r] of foreign) roots[n] = r;
    const needed = new Set();
    for (const r of Object.values(roots)) for (const f of r.files) f.c.forEach((h) => needed.add(h));
    let up;
    try { up = await uploadMissing(client, local, extra, needed, cfg.uploadBatchMiB * 1024 * 1024, log); }
    catch (e) {
      if (e.code === 'CHANGED' && attempt < 3) { forget.add(e.abs); log.warn(`${e.message}; wird neu gehasht und erneut erfasst.`); continue; }
      throw e;
    }
    const { collectProjects } = await import('./commands.js');
    const manifest = {
      version: MANIFEST_VERSION, id: makeId(), createdAt: new Date().toISOString(), parent: snap?.id || null,
      host: os.hostname(), user: os.userInfo().username, home: cfg.home, projectDrive: cfg.projectDrive, platform: process.platform,
      rootPaths: Object.fromEntries(Object.entries(cfg.roots).map(([n, r]) => [n, r.path])),
      projects: [...new Set([...(snap?.projects || []), ...(await collectProjects(cfg))])].sort(),
      appGroups: grp.appGroups,
      refsRev: refsRes?.refs?.rev ?? null,
      roots,
      stats: statsOf(roots),
    };
    try { await client.putSnapshot(manifest); }
    catch (e) {
      if (/HTTP 409/.test(e.message) && /geaendert|geändert/.test(e.message) && attempt < 3) { log.warn('Ein anderer PC hat gerade hochgeladen; fuehre erneut zusammen ...'); continue; }
      // Aufraeumen (gc) auf dem Server hat inzwischen Chunks entfernt: erneut hochladen
      if (/HTTP 409/.test(e.message) && /fehlen/.test(e.message) && attempt < 3) { log.warn('Auf dem Server fehlen Chunks (gerade aufgeraeumt?); lade erneut hoch ...'); continue; }
      if (/HTTP 400/.test(e.message) && /Manifest ungueltig/.test(e.message)) throw new Error(`Der Server kennt das Stand-Format v${MANIFEST_VERSION} noch nicht. Server aktualisieren (git pull, dann docker compose up -d --build) und erneut pushen.`);
      throw e;
    }
    saveBase(cfg, L, manifest.id);
    saveGroupLinks(cfg, grp.links);
    for (const r of grp.renamed) log.info(`Gruppe umbenannt: "${r.from}" -> "${r.to}" (die anderen PCs uebernehmen das mit /clyde:pull)`);
    log.info(`Gemeinsamer Stand ${manifest.id} gespeichert: ${manifest.stats.files} Dateien. Von diesem PC: ${info.push} neu/geaendert, ${info.pushDelete} geloescht${info.union ? `, ${info.union} zusammengefuehrt` : ''}${refsRes?.facts?.repos.size ? `, Verweise auf ${refsRes.facts.repos.size} Git-Repo(s) aktuell` : ''}; ${up.chunks} Chunks / ${fmtBytes(up.bytes)} uebertragen.`);
    return { id: manifest.id, uploadedChunks: up.chunks, uploadedBytes: up.bytes, stats: manifest.stats, projects: manifest.projects, excluded: local.stats.excluded, info };
  }
}

// Lokale Schreib-/Loeschliste aus den Entscheidungen (auch fuer verschobene Dateien).
// Dateien, deren Inhalt sich nicht verlustfrei neutral und zurueck wandeln laesst
// (stale), werden nur gezaehlt, nie "vorsorglich" neu geschrieben.
export function localPlan(cfg, decisions, snap) {
  const plan = { write: [], delete: [], links: [], unchanged: 0, bytesToWrite: 0, stale: 0 };
  for (const d of decisions) {
    const root = cfg.roots[d.root];
    if (!root) continue;
    const lp = localize(d.p, cfg.forms);
    const moved = d.l && d.local !== 'delete' && d.l.lp !== lp;
    // seen: Stand der lokalen Datei beim Scan; hat sie sich bis zum Schreiben
    // geaendert, laesst der Pull sie aus, statt die Aenderung zu ueberschreiben
    const seen = d.l ? { m: d.l.m, ct: d.l.ct } : null;
    if (d.local === 'delete') { plan.delete.push({ root: d.root, p: d.p, lp: d.l.lp, abs: absFor(root, d.l.lp), seen }); continue; }
    if (d.local === 'write' || moved) {
      const f = d.local === 'write' ? d.merged : d.l;
      plan.write.push({ root: d.root, p: d.p, lp, s: f.s, m: f.m, c: f.c, abs: absFor(root, lp), isNew: !d.l, seen: moved ? null : seen });
      plan.bytesToWrite += f.s;
      if (moved) plan.delete.push({ root: d.root, p: d.p, lp: d.l.lp, abs: absFor(root, d.l.lp) });
    } else {
      plan.unchanged++;
      if (d.l?.stale) plan.stale++;
    }
  }
  for (const [name, r] of Object.entries(snap?.roots || {})) {
    const root = cfg.roots[name];
    if (!root) continue;
    for (const ln of r.links || []) { const lp = localize(ln.p, cfg.forms); plan.links.push({ root: name, p: ln.p, lp, t: localize(ln.t, cfg.forms), abs: absFor(root, lp) }); }
  }
  return plan;
}

// Zwei (oder mehr) gespeicherte Staende zu einem neuen gemeinsamen Stand fusionieren
export async function mergeSnapshots(cfg, opts, log) {
  const ids = opts.args || [];
  if (ids.length < 2) throw new Error('Aufruf: clyde merge STAND-ID STAND-ID [...]   (IDs siehe clyde list)');
  const client = new Client(cfg.server, cfg.token);
  const snaps = [];
  for (const id of ids) snaps.push(await fetchLatest(client, id));
  let acc = snaps[0];
  let accFiles = flatten(acc.roots);
  let accLinks = {};
  for (const [n, r] of Object.entries(acc.roots)) accLinks[n] = r.links || [];
  const kinds = {};
  for (const s of snaps) for (const [n, r] of Object.entries(s.roots)) kinds[n] = kinds[n] || r.kind;
  let appGroups = acc.appGroups || null;
  let projects = [...(acc.projects || [])];
  let unions = 0, conflicts = 0;
  for (const s of snaps.slice(1)) {
    const decisions = decide(accFiles, flatten(s.roots), new Map());
    const extra = await resolveUnions(decisions, (d) => remoteContent(client, d.l), (d) => remoteContent(client, d.r));
    if (extra.size) await client.upload([...extra].map(([hash, data]) => ({ hash, data })));
    unions += decisions.filter((d) => d.union).length;
    conflicts += decisions.filter((d) => d.conflict).length;
    const M = new Map();
    for (const d of decisions) if (d.merged) M.set(d.key, { ...d.merged, root: d.root, p: d.p });
    accFiles = M;
    for (const [n, r] of Object.entries(s.roots)) accLinks[n] = mergeLinks(accLinks[n], r.links);
    appGroups = mergeAppGroups(appGroups, s.appGroups);
    projects = [...new Set([...projects, ...(s.projects || [])])];
  }
  const latest = await fetchLatest(client);
  const roots = buildRoots(accFiles, kinds, accLinks);
  const manifest = {
    version: MANIFEST_VERSION, id: makeId(), createdAt: new Date().toISOString(), parent: latest?.id || null,
    host: [...new Set(snaps.map((s) => s.host))].join('+'), user: snaps[0].user, home: snaps[0].home, projectDrive: snaps[0].projectDrive || null,
    platform: snaps[0].platform, rootPaths: snaps[0].rootPaths, mergedFrom: ids,
    projects: projects.sort(), appGroups, roots, stats: statsOf(roots),
  };
  if (opts.dryRun) { log.info(`Trockenlauf: fusionierter Stand haette ${manifest.stats.files} Dateien (${unions} zusammengefuehrt, ${conflicts} Konflikte nach Datum entschieden).`); return { manifest }; }
  await client.putSnapshot(manifest);
  log.info(`Fusionierter Stand ${manifest.id} gespeichert: ${manifest.stats.files} Dateien, ${fmtBytes(manifest.stats.bytes)} aus ${ids.join(' + ')} (${unions} Dateien zeilenweise zusammengefuehrt, ${conflicts} Konflikte nach Datum entschieden).`);
  return { manifest };
}

// Welche Chats gehoeren zu welchem Projektordner? Aus der Chatliste im Stand
// (neutrale Pfade wie in snap.projects) -> Titel
export async function projectChats(client, snap) {
  const out = new Map();
  out.byId = new Map(); // Chat-ID -> Titel
  const root = snap?.roots?.['desktop-sessions'];
  if (!root) return out;
  const files = root.files.filter((f) => /(^|\/)local_[^/]*\.json$/.test(f.p) && f.s < 256 * 1024);
  const need = [...new Set(files.flatMap((f) => f.c))];
  const data = new Map();
  for (let i = 0; i < need.length; i += 16) await client.fetchBlobs(need.slice(i, i + 16), async ({ hash, data: d }) => { data.set(hash, d); });
  const unJson = (s) => s.replace(/_(J1|J2)@@/g, (m, k) => (k === 'J1' ? '_RAW@@' : '_J1@@'));
  for (const f of files) {
    try {
      const j = JSON.parse(Buffer.concat(f.c.map((h) => data.get(h))).toString('utf8'));
      out.byId.set(f.p.split('/').pop().slice(0, -'.json'.length), j.title || null);
      if (typeof j.cwd !== 'string') continue;
      const key = unJson(j.cwd).replace(/[\\/]+$/, '');
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(j.title || j.cliSessionId || f.p);
    } catch { /* kein Chat-Eintrag */ }
  }
  return out;
}

export { sigOf, applyPlan, resolveUnions, describe, remoteContent, localCanonical };
