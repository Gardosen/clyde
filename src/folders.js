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
import fs from 'node:fs';
import path from 'node:path';
import { localChats } from './refs.js';
import { canonicalize } from './rewrite.js';

// Werte aus geparstem JSON: J1 -> RAW, J2 -> J1 (die Datei enthielt die escapte Form)
const unJson = (s) => s.replace(/_(J1|J2)@@/g, (m, k) => (k === 'J1' ? '_RAW@@' : '_J1@@'));
const driveExists = (p) => { try { return fs.existsSync(path.parse(path.resolve(p)).root); } catch { return false; } };

// Fehlende Ordner, je Ordner mit den Chats, die ihn brauchen
export async function missingFolders(cfg) {
  const byKey = new Map();
  for (const c of await localChats(cfg)) {
    if (!c.cwd || fs.existsSync(c.cwd)) continue;
    const unresolved = c.cwd.includes('@@CLYDE_');
    const canonical = unresolved ? unJson(c.cwd) : canonicalize(c.cwd, cfg.forms);
    const e = byKey.get(canonical) || { canonical, cwd: c.cwd, creatable: !unresolved && path.isAbsolute(c.cwd) && driveExists(c.cwd), chats: [] };
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
  return `${e.cwd}${e.creatable ? '' : ' (hier nicht anlegbar)'}: ${e.chats.map((c) => c.title).join(' | ')}`;
}
