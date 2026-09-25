import { absFor } from './scan.js';
import { localize } from './rewrite.js';
import { pathBelongsTo } from './session.js';

const sameChunks = (a, b) => a.length === b.length && a.every((h, i) => h === b[i]);

// Vergleicht lokalen Zustand mit einem Snapshot (beide in kanonischer Form) und
// liefert, was zu tun ist, damit der lokale Zustand exakt dem Snapshot entspricht.
// Lokale Pfade (lp, abs) entstehen durch Einsetzen der lokalen Werte (Home,
// Projektlaufwerk, Zuordnungen). Liegt eine Datei lokal an einem anderen Ort als
// die Zuordnung vorgibt (neue Zuordnung), wird sie verschoben.
export function planRestore(localRoots, snapRoots, cfgRoots, forms, log, exclude = []) {
  const plan = { write: [], delete: [], links: [], unchanged: 0, moved: 0, relocalized: 0, skippedRoots: [], bytesToWrite: 0 };
  for (const [name, root] of Object.entries(cfgRoots)) {
    const sr = snapRoots[name];
    if (!sr) {
      plan.skippedRoots.push(name);
      log.warn(`Snapshot enthaelt Root "${name}" nicht, bleibt lokal unveraendert`);
      continue;
    }
    const lr = localRoots[name] || { files: [], links: [] };
    const localMap = new Map(lr.files.map((f) => [f.p, f]));
    for (const f of sr.files) {
      if (exclude.length && pathBelongsTo(f.p, exclude)) continue;
      const l = localMap.get(f.p);
      localMap.delete(f.p);
      const lp = localize(f.p, forms);
      const same = l && l.s === f.s && sameChunks(l.c, f.c);
      if (l && l.lp !== lp) {
        plan.delete.push({ root: name, p: l.p, lp: l.lp, abs: absFor(root, l.lp) });
        if (same) plan.moved++;
      } else if (same && l.stale) {
        plan.relocalized++; // Inhalt neutral gleich, aber lokale Werte veraltet (neue Zuordnung)
      } else if (same) {
        plan.unchanged++;
        continue;
      }
      plan.write.push({ root: name, p: f.p, lp, s: f.s, m: f.m, c: f.c, abs: absFor(root, lp), isNew: !l });
      plan.bytesToWrite += f.s;
    }
    for (const l of localMap.values()) {
      const lp = l.lp || localize(l.p, forms);
      plan.delete.push({ root: name, p: l.p, lp, abs: absFor(root, lp) });
    }
    for (const ln of sr.links || []) {
      const lp = localize(ln.p, forms);
      plan.links.push({ root: name, p: ln.p, lp, t: localize(ln.t, forms), abs: absFor(root, lp) });
    }
  }
  return plan;
}
