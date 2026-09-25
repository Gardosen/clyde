// Home-Verzeichnis, Projektlaufwerk und Projekt-Zuordnungen <-> Platzhalter.
//
// Claude schreibt das Home-Verzeichnis des Benutzers in Ordnernamen
// (C--Users-warro-Nextcloud-Aegis), in Transkripte ("cwd":"C:\\Users\\warro\\...")
// und in den Sidebar-Index der Desktop-App. Projekte ausserhalb des Home liegen
// je PC auf verschiedenen Laufwerken (D:\Aegis vs. C:\Aegis) oder ganz woanders.
// Damit ein Snapshot auf einem PC mit anderem Benutzerkonto, Laufwerk oder
// Projektpfad nutzbar ist, ersetzt jeder Client beim Scannen seine eigenen Werte
// durch neutrale Platzhalter und setzt beim Pull seine eigenen Werte wieder ein.
// Der Server sieht nur die neutrale Form; dadurch bleiben Chunk-Hashes zwischen
// PCs vergleichbar.
//
// Die Ersetzung arbeitet auf Bytes: alle Muster sind ASCII, UTF-8-Mehrbytezeichen
// koennen keine ASCII-Bytes enthalten, also ist das fuer jede Kodierung sicher.
import path from 'node:path';

const BS = String.fromCharCode(92);
const KINDS = ['J2', 'J1', 'RAW', 'FWD', 'POSIX', 'KEY'];
export const TEXT_EXTENSIONS = new Set(['.jsonl', '.json', '.md', '.txt']);

export function normalizeHome(h) {
  return String(h || '').replace(/[\\/]+$/, '');
}

export function normalizeDrive(d) {
  const L = String(d || '').trim().replace(/:.*$/, '').toUpperCase();
  return /^[A-Z]$/.test(L) ? L : null;
}

export function isTextFile(p) {
  return TEXT_EXTENSIONS.has(path.extname(p).toLowerCase());
}

// Die sechs Schreibweisen eines Pfads (roh, mit Backslashes). Der Pfad darf mit
// einem RAW-Platzhalter beginnen (@@CLYDE_HOME_RAW@@ oder @@CLYDE_DRIVE_RAW@@);
// der wird je Schreibweise mitgefuehrt.
export function pathVariants(raw) {
  const m = /^(@@CLYDE_(?:HOME|DRIVE)_RAW@@)?(.*)$/.exec(raw);
  const tag = m[1] || '';
  const rest = m[2];
  const withTag = (k, body) => (tag ? tag.replace('_RAW@@', `_${k}@@`) : '') + body;
  const sep = (s) => rest.split(BS).join(s);
  const drive = !tag && /^([A-Za-z]):/.exec(rest);
  return {
    J2: withTag('J2', sep(BS + BS + BS + BS)),
    J1: withTag('J1', sep(BS + BS)),
    RAW: withTag('RAW', rest),
    FWD: withTag('FWD', sep('/')),
    POSIX: withTag('POSIX', drive ? `/${drive[1].toLowerCase()}${sep('/').slice(2)}` : sep('/')),
    KEY: withTag('KEY', rest.replace(/[^A-Za-z0-9]/g, '-')),
  };
}

// value: lokale Schreibweise, tag: neutrale Schreibweise.
// before/after: Wortgrenze vor/nach dem lokalen Treffer pruefen,
// tagAfter: Wortgrenze nach dem neutralen Treffer pruefen (nur Zuordnungen,
// deren neutrale Form kein @@...@@-Token, sondern ein Pfad ist).
const mk = (kind, tag, value, { before = false, after = true, tagAfter = false } = {}) =>
  ({ kind, tag, value, valueBuf: Buffer.from(value), tagBuf: Buffer.from(tag), before, after, tagAfter });

// Alle Schreibweisen des Home-Verzeichnisses, laengste zuerst, damit "C:\\Users"
// nicht schon als "C:\Users" halb ersetzt wird. Nach dem Treffer darf kein
// Wortzeichen folgen (C:\Users\warro2 bleibt).
export function homeForms(home) {
  const raw = normalizeHome(home);
  if (!raw) return [];
  const v = pathVariants(raw);
  const seen = new Set();
  const out = [];
  for (const k of KINDS) {
    if (seen.has(v[k])) continue;
    seen.add(v[k]);
    out.push(mk(k, `@@CLYDE_HOME_${k}@@`, v[k]));
  }
  return out;
}

// Schreibweisen des Projektlaufwerks (D:\, D:\\, D:/, /d/, D--). Vor dem Treffer
// darf kein Wortzeichen stehen (/mnt/d/ und ID:\ bleiben unangetastet).
export function driveForms(letter) {
  const L = normalizeDrive(letter);
  if (!L) return [];
  const v = { J2: `${L}:${BS}${BS}${BS}${BS}`, J1: `${L}:${BS}${BS}`, RAW: `${L}:${BS}`, FWD: `${L}:/`, POSIX: `/${L.toLowerCase()}/`, KEY: `${L}--` };
  return KINDS.map((k) => mk(k, `@@CLYDE_DRIVE_${k}@@`, v[k], { before: true, after: false }));
}

// Zuordnungen einzelner Projekte: neutrale Form (wie im Snapshot) -> lokaler Pfad.
// Laengste zuerst, damit Unterordner vor Oberordnern greifen.
export function pathMapForms(pathMap) {
  const out = [];
  const entries = Object.entries(pathMap || {})
    .filter(([c, l]) => c && l)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [canonRaw, localRaw] of entries) {
    const c = pathVariants(normalizeHome(canonRaw));
    const l = pathVariants(normalizeHome(localRaw));
    for (const k of KINDS) {
      if (c[k] === l[k]) continue;
      out.push(mk(`MAP_${k}`, c[k], l[k], { after: true, tagAfter: true }));
    }
  }
  return out;
}

// Reihenfolge: Zuordnungen (spezifischste), dann Home, dann Laufwerk
export function allForms(home, projectDrive, pathMap) {
  return [...pathMapForms(pathMap), ...homeForms(home), ...driveForms(projectDrive)];
}

const isWordByte = (b) => (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95;

function replaceBuf(buf, from, to, before, after) {
  let idx = buf.indexOf(from);
  if (idx === -1) return buf;
  const parts = [];
  let last = 0;
  while (idx !== -1) {
    const end = idx + from.length;
    const okBefore = !before || idx === 0 || !isWordByte(buf[idx - 1]);
    const okAfter = !after || end >= buf.length || !isWordByte(buf[end]);
    if (okBefore && okAfter) {
      parts.push(buf.subarray(last, idx), to);
      last = end;
    }
    idx = buf.indexOf(from, end);
  }
  parts.push(buf.subarray(last));
  return Buffer.concat(parts);
}

export function canonicalizeBuf(buf, forms) {
  for (const f of forms) buf = replaceBuf(buf, f.valueBuf, f.tagBuf, f.before, f.after);
  return buf;
}
export function localizeBuf(buf, forms) {
  for (const f of forms) buf = replaceBuf(buf, f.tagBuf, f.valueBuf, false, f.tagAfter);
  return buf;
}
export function canonicalize(text, forms) {
  return forms.length ? canonicalizeBuf(Buffer.from(text), forms).toString() : text;
}
export function localize(text, forms) {
  return forms.length ? localizeBuf(Buffer.from(text), forms).toString() : text;
}

// Wandelt einen Byte-Strom stueckweise um. Die Muster enthalten keinen
// Zeilenumbruch, deshalb wird immer nur bis zum letzten Zeilenumbruch verarbeitet
// und der Rest bis zum naechsten Stueck aufgehoben. So kann kein Treffer an einer
// Stueckgrenze zerrissen werden.
export async function* transformStream(source, fn) {
  const parts = [];
  let total = 0;
  for await (const piece of source) {
    if (!piece.length) continue;
    parts.push(piece);
    total += piece.length;
    if (piece.indexOf(10) === -1) continue;
    const buf = Buffer.concat(parts);
    parts.length = 0;
    total = 0;
    const cut = buf.lastIndexOf(10);
    yield fn(buf.subarray(0, cut + 1));
    const rest = buf.subarray(cut + 1);
    if (rest.length) { parts.push(Buffer.from(rest)); total = rest.length; }
  }
  if (total) yield fn(Buffer.concat(parts));
}
