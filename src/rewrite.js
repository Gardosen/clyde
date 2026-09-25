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
// Umkehrbarkeit: Text, der nur so aussieht wie ein Platzhalter (etwa in einem Chat
// ueber Clyde), darf beim Einsetzen nicht ersetzt werden. Deshalb wird beim
// Neutralisieren jedes woertliche "@@CLYDE_" zu "@@CLYDE_ESC_" und beim Einsetzen
// zurueck. Ausnahme: Platzhalter, die dieser PC nicht einsetzen kann (etwa ein
// Projektlaufwerk auf einem Mac), bleiben in beiden Richtungen unveraendert, auch
// maskiert ("@@CLYDE_ESC_DRIVE_RAW@@"). So bleibt die neutrale Form auf jedem PC
// stabil, auch wenn er nicht alle Platzhalter kennt.
// Ersetzt wird in einem Durchgang, am weitesten links beginnend und bei gleichem
// Anfang der laengste Treffer; eingesetzter Text wird nie ein zweites Mal ersetzt.
//
// Die Ersetzung arbeitet auf Bytes: alle Muster sind ASCII, UTF-8-Mehrbytezeichen
// koennen keine ASCII-Bytes enthalten, also ist das fuer jede Kodierung sicher.
import path from 'node:path';

const BS = String.fromCharCode(92);
const KINDS = ['J2', 'J1', 'RAW', 'FWD', 'POSIX', 'KEY'];
export const TEXT_EXTENSIONS = new Set(['.jsonl', '.json', '.md', '.txt']);

// Version der Ersetzungsregeln; aendert sie sich, sind gecachte Hashes ungueltig
export const REWRITE_VERSION = 3;
const PREFIX = Buffer.from('@@CLYDE_');
const ESC = Buffer.from('@@CLYDE_ESC_');
const ESC_PART = Buffer.from('ESC_');
const TOKENS = ['HOME', 'DRIVE'].flatMap((w) => ['J2', 'J1', 'RAW', 'FWD', 'POSIX', 'KEY'].map((k) => `@@CLYDE_${w}_${k}@@`));

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

// Wie wird eine Datei beim Einsetzen geprueft? jsonl: jede geaenderte Zeile muss
// gueltiges JSON bleiben; json: die ganze Datei; sonst keine Pruefung
export function textMode(p) {
  const ext = path.extname(p).toLowerCase();
  return ext === '.jsonl' ? 'jsonl' : ext === '.json' ? 'json' : 'text';
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

// Alle Schreibweisen des Home-Verzeichnisses. Nach dem Treffer darf kein
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

// Muster je Regelsatz einmal vorbereiten
const compiled = new WeakMap();
function compile(forms) {
  let c = compiled.get(forms);
  if (c) return c;
  const canon = [{ from: PREFIX, to: ESC }];
  const local = [{ from: ESC, to: PREFIX }];
  const known = new Set();
  for (const f of forms) {
    canon.push({ from: f.valueBuf, to: f.tagBuf, before: f.before, after: f.after });
    local.push({ from: f.tagBuf, to: f.valueBuf, after: f.tagAfter });
    known.add(f.tag);
  }
  // Folgt auf "@@CLYDE_" (und beliebig viele "ESC_") ein Platzhalter, den dieser PC
  // nicht einsetzen kann, bleibt die Stelle in beiden Richtungen, wie sie ist
  const unknown = TOKENS.filter((t) => !known.has(t)).map((t) => Buffer.from(t.slice(PREFIX.length)));
  if (unknown.length) {
    const guard = (buf, idx) => {
      let p = idx + PREFIX.length;
      while (buf.compare(ESC_PART, 0, 4, p, p + 4) === 0) p += 4;
      return unknown.some((u) => buf.compare(u, 0, u.length, p, p + u.length) === 0);
    };
    canon[0].guard = guard;
    local[0].guard = guard;
  }
  c = { canon, local };
  compiled.set(forms, c);
  return c;
}
const NO_FORMS = [];

// Ein Durchgang: alle Treffer sammeln, von links nach rechts den laengsten nehmen
function rewrite(buf, pats) {
  const hits = [];
  for (let i = 0; i < pats.length; i++) {
    const pt = pats[i];
    if (!pt.from.length) continue;
    let idx = buf.indexOf(pt.from);
    while (idx !== -1) {
      const end = idx + pt.from.length;
      const okBefore = !pt.before || idx === 0 || !isWordByte(buf[idx - 1]);
      const okAfter = !pt.after || end >= buf.length || !isWordByte(buf[end]);
      if (okBefore && okAfter && !(pt.guard && pt.guard(buf, idx))) hits.push([idx, end, i]);
      idx = buf.indexOf(pt.from, idx + 1);
    }
  }
  if (!hits.length) return buf;
  hits.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]) || a[2] - b[2]);
  const parts = [];
  let pos = 0;
  for (const [s, e, i] of hits) {
    if (s < pos) continue;
    parts.push(buf.subarray(pos, s), pats[i].to);
    pos = e;
  }
  parts.push(buf.subarray(pos));
  return Buffer.concat(parts);
}

// Inhalte: lokale Werte -> Platzhalter (mit Maskierung)
export function canonicalizeBuf(buf, forms) {
  return rewrite(buf, compile(forms).canon);
}
// Platzhalter -> lokale Werte, Maskierung aufheben
export function localizeBuf(buf, forms) {
  return rewrite(buf, compile(forms).local);
}

const validJson = (b) => { try { JSON.parse(b.toString('utf8')); return true; } catch { return false; } };

// Einsetzen mit Pruefung: ergibt eine geaenderte JSONL-Zeile kein gueltiges JSON
// mehr (z. B. ein woertlicher Platzhalter aus einem Stand von Clyde < 0.4.2), bleibt
// sie neutral stehen (nur die Maskierung wird aufgehoben), statt das Transkript
// zu beschaedigen.
export function localizeJsonlBuf(buf, forms) {
  const pats = compile(forms).local;
  if (rewrite(buf, pats) === buf) return buf;
  const plainPats = compile(NO_FORMS).local;
  const parts = [];
  let start = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(10, start);
    const stop = nl === -1 ? buf.length : nl;
    const line = buf.subarray(start, stop);
    let out = rewrite(line, pats);
    if (out !== line && !validJson(out)) {
      const plain = rewrite(line, plainPats);
      if (validJson(plain)) out = plain;
    }
    parts.push(out);
    if (nl !== -1) parts.push(buf.subarray(nl, nl + 1));
    start = stop + 1;
  }
  return Buffer.concat(parts);
}
// Dasselbe fuer eine ganze JSON-Datei
export function localizeJsonBuf(buf, forms) {
  const out = localizeBuf(buf, forms);
  if (out === buf || validJson(out)) return out;
  const plain = localizeBuf(buf, NO_FORMS);
  return validJson(plain) ? plain : out;
}
export function localizeFn(mode) {
  return mode === 'jsonl' ? localizeJsonlBuf : mode === 'json' ? localizeJsonBuf : localizeBuf;
}

export function canonicalize(text, forms) {
  const buf = Buffer.from(text);
  const out = rewrite(buf, compile(forms).canon);
  return out === buf ? text : out.toString();
}
export function localize(text, forms) {
  const buf = Buffer.from(text);
  const out = rewrite(buf, compile(forms).local);
  return out === buf ? text : out.toString();
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
