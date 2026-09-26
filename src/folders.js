// Chats, deren Arbeitsordner es auf diesem PC nicht gibt.
//
// Die Claude-App laesst solche Chats nicht weiterlaufen. Waehlt man dort einen
// anderen Ordner, legt sie eine Kopie ("(fork)") ohne Gruppe an und archiviert
// das Original. Clyde loest das ohne Kopie:
//   - Ordner anlegen: den erwarteten Ordner leer anlegen; der Chat laeuft sofort
//     weiter.
//   - Umstellen: der erwartete Ordner ist hier ein anderer (Zuordnung wie bei
//     "clyde map --add"); nur die Dateien dieser Chats werden umgestellt. Die
//     laufende App sieht das erst nach einem Neustart.
//   - Zurueckgeschrieben: oeffnet man einen umgestellten Chat vor dem Neustart,
//     schreibt die App ihren alten Ordner in die Datei zurueck. Die Zuordnung
//     kennt den neuen Ordner noch; "wieder umstellen" stellt ihn erneut ein.
import fs from 'node:fs';
import path from 'node:path';
import { localChats } from './refs.js';
import { canonicalize, localize } from './rewrite.js';
import { isUnder } from './remap.js';

// Werte aus geparstem JSON: J1 -> RAW, J2 -> J1 (die Datei enthielt die escapte Form)
const unJson = (s) => s.replace(/_(J1|J2)@@/g, (m, k) => (k === 'J1' ? '_RAW@@' : '_J1@@'));
const driveExists = (p) => { try { return fs.existsSync(path.parse(path.resolve(p)).root); } catch { return false; } };
const samePath = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

// Zuordnung (neutraler Pfad), die diesen Ordner abdeckt; die laengste gewinnt
export function mappingFor(cfg, canonical) {
  return Object.keys(cfg.pathMap || {}).filter((k) => isUnder(canonical, k)).sort((a, b) => b.length - a.length)[0] || null;
}

// Fehlende Ordner, je Ordner mit den Chats, die ihn brauchen. target: der Ordner,
// auf den eine Zuordnung ihn umgestellt hat (reverted: den gibt es, die App hat
// den alten Ordner zurueckgeschrieben).
export async function missingFolders(cfg, chats = null) {
  const byKey = new Map();
  for (const c of chats || await localChats(cfg)) {
    if (!c.cwd || fs.existsSync(c.cwd)) continue;
    const unresolved = c.cwd.includes('@@CLYDE_');
    const canonical = unresolved ? unJson(c.cwd) : canonicalize(c.cwd, cfg.forms);
    let e = byKey.get(canonical);
    if (!e) {
      const mappedBy = unresolved ? null : mappingFor(cfg, canonical);
      const target = mappedBy ? localize(canonical, cfg.forms) : null;
      const moved = !!target && !target.includes('@@CLYDE_') && !samePath(target, c.cwd);
      e = { canonical, cwd: c.cwd, creatable: !unresolved && path.isAbsolute(c.cwd) && driveExists(c.cwd), target: moved ? target : null, reverted: moved && fs.existsSync(target), mappedBy: moved ? mappedBy : null, chats: [] };
    }
    e.chats.push({ id: c.id, title: c.title });
    byKey.set(canonical, e);
  }
  return [...byKey.values()].sort((a, b) => (a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0));
}

// Eintrag anhand von Ordner (lokal oder neutral) oder Chat-Titel finden
export function resolveMissing(list, ref) {
  const s = String(ref || '').trim();
  const low = s.toLowerCase().replace(/[\\/]+$/, '');
  const same = list.filter((e) => [e.cwd, e.canonical].some((x) => x.toLowerCase().replace(/[\\/]+$/, '') === low));
  if (same.length) return same[0];
  const byTitle = list.filter((e) => e.chats.some((c) => c.title.toLowerCase().includes(low)));
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) throw new Error(`"${s}" passt auf mehrere Chats: ${byTitle.flatMap((e) => e.chats.map((c) => c.title)).join(' | ')}`);
  throw new Error(`"${s}" ist kein fehlender Ordner eines Chats (siehe clyde folders).`);
}

export function describeMissing(e) {
  const chats = e.chats.map((c) => c.title).join(' | ');
  if (e.reverted) return `${e.cwd}: ${chats} -- war schon auf ${e.target} umgestellt; die App hat den alten Ordner zurueckgeschrieben (Chat vor dem Neustart geoeffnet)`;
  if (e.target) return `${e.cwd}: ${chats} -- umgestellt auf ${e.target}, den es hier aber nicht gibt`;
  return `${e.cwd}${e.creatable ? '' : ' (hier nicht anlegbar)'}: ${chats}`;
}
