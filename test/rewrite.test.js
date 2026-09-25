import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeForms, driveForms, allForms, pathVariants, canonicalize, localize, canonicalizeBuf, transformStream, isTextFile, normalizeDrive } from '../src/rewrite.js';

const WARRO = homeForms('C:\\Users\\warro');
const MARCO = homeForms('C:\\Users\\marco');

test('homeForms kennt alle sechs Schreibweisen eines Windows-Home', () => {
  assert.deepEqual(WARRO.map((f) => f.value), [
    'C:\\\\\\\\Users\\\\\\\\warro', 'C:\\\\Users\\\\warro', 'C:\\Users\\warro',
    'C:/Users/warro', '/c/Users/warro', 'C--Users-warro',
  ]);
  assert.deepEqual(homeForms('/Users/marco').map((f) => f.value), ['/Users/marco', '-Users-marco'], 'auf POSIX fallen RAW/FWD/J1/J2/POSIX zusammen');
  assert.equal(homeForms('').length, 0);
});

test('Transkript-Zeile: Home -> Platzhalter -> anderes Home, exakt und ohne Rest', () => {
  const line = '{"cwd":"C:\\\\Users\\\\warro\\\\Nextcloud\\\\Aegis","key":"C--Users-warro-Nextcloud-Aegis",'
    + '"sh":"/c/Users/warro/x","fwd":"C:/Users/warro/y","raw":"C:\\Users\\warro\\z","nested":"C:\\\\\\\\Users\\\\\\\\warro\\\\\\\\n"}';
  const canon = canonicalize(line, WARRO);
  assert.ok(!canon.includes('warro'), `Home nicht vollstaendig ersetzt: ${canon}`);
  assert.ok(canon.includes('@@CLYDE_HOME_J1@@\\\\Nextcloud'));
  assert.ok(canon.includes('@@CLYDE_HOME_KEY@@-Nextcloud'));
  assert.ok(canon.includes('@@CLYDE_HOME_J2@@\\\\\\\\n'));
  assert.equal(localize(canon, WARRO), line, 'Rueckweg muss byteidentisch sein');
  const asMarco = localize(canon, MARCO);
  assert.ok(asMarco.includes('"cwd":"C:\\\\Users\\\\marco\\\\Nextcloud'));
  assert.ok(asMarco.includes('C--Users-marco-Nextcloud-Aegis'));
  assert.ok(!asMarco.includes('warro'));
});

test('Wortgrenze: andere Konten mit gleichem Praefix bleiben unangetastet', () => {
  const s = 'C:\\Users\\warro2\\a C--Users-warrox-b C:\\Users\\warro\\ok';
  const c = canonicalize(s, WARRO);
  assert.ok(c.includes('warro2') && c.includes('warrox'));
  assert.ok(c.endsWith('@@CLYDE_HOME_RAW@@\\ok'));
});

test('Platzhalter in Ordnernamen', () => {
  assert.equal(canonicalize('C--Users-warro-Nextcloud-Aegis/abc.jsonl', WARRO), '@@CLYDE_HOME_KEY@@-Nextcloud-Aegis/abc.jsonl');
  assert.equal(localize('@@CLYDE_HOME_KEY@@-Nextcloud-Aegis/abc.jsonl', MARCO), 'C--Users-marco-Nextcloud-Aegis/abc.jsonl');
  assert.equal(canonicalize('D--Aegis-episode1/x.jsonl', WARRO), 'D--Aegis-episode1/x.jsonl');
});

test('Projektlaufwerk: D auf PC A wird zu C auf PC B, andere Laufwerke bleiben', () => {
  const A = allForms('C:\\Users\\warro', 'D');
  const B = allForms('C:\\Users\\marco', 'c:');
  assert.equal(normalizeDrive('d:'), 'D');
  assert.equal(normalizeDrive('DE'), null);
  assert.equal(driveForms('').length, 0);
  const line = '{"cwd":"D:\\\\Aegis\\\\episode1","key":"D--Aegis-episode1","sh":"/d/Aegis","fwd":"D:/Aegis",'
    + '"raw":"D:\\Aegis","home":"C:\\\\Users\\\\warro\\\\x","other":"E:\\\\Other","wsl":"/mnt/d/x","id":"ID:\\\\y"}';
  const canon = canonicalize(line, A);
  for (const rest of ['D:\\\\Aegis', 'D:\\Aegis', 'D:/Aegis', '/d/Aegis', 'D--Aegis']) assert.ok(!canon.includes(rest), `${rest} nicht ersetzt: ${canon}`);
  assert.ok(canon.includes('"cwd":"@@CLYDE_DRIVE_J1@@Aegis') && canon.includes('"key":"@@CLYDE_DRIVE_KEY@@Aegis-episode1"'));
  assert.ok(canon.includes('"other":"E:\\\\Other"') && canon.includes('/mnt/d/x') && canon.includes('ID:\\\\y'));
  assert.equal(localize(canon, A), line);
  const asB = localize(canon, B);
  assert.ok(asB.includes('"cwd":"C:\\\\Aegis\\\\episode1"') && asB.includes('"key":"C--Aegis-episode1"') && asB.includes('/c/Aegis'));
  assert.ok(asB.includes('C:\\\\Users\\\\marco\\\\x'));
  assert.equal(canonicalize('D--Aegis-episode1/x.jsonl', A), '@@CLYDE_DRIVE_KEY@@Aegis-episode1/x.jsonl');
  assert.equal(localize('@@CLYDE_DRIVE_KEY@@Aegis-episode1/x.jsonl', B), 'C--Aegis-episode1/x.jsonl');
  // Auf PC B liegt das Home auf dem Projektlaufwerk: Home gewinnt, der Rest wird Laufwerk
  assert.equal(canonicalize('C--Users-marco-p C--Tools', B), '@@CLYDE_HOME_KEY@@-p @@CLYDE_DRIVE_KEY@@Tools');
});

test('pathVariants fuehrt Platzhalter je Schreibweise mit', () => {
  const d = pathVariants('@@CLYDE_DRIVE_RAW@@Aegis\\x');
  assert.equal(d.J1, '@@CLYDE_DRIVE_J1@@Aegis\\\\x');
  assert.equal(d.KEY, '@@CLYDE_DRIVE_KEY@@Aegis-x');
  assert.equal(d.POSIX, '@@CLYDE_DRIVE_POSIX@@Aegis/x');
  const h = pathVariants('@@CLYDE_HOME_RAW@@\\Projekte\\x');
  assert.equal(h.KEY, '@@CLYDE_HOME_KEY@@-Projekte-x');
  assert.equal(h.POSIX, '@@CLYDE_HOME_POSIX@@/Projekte/x');
  assert.equal(h.J2, '@@CLYDE_HOME_J2@@\\\\\\\\Projekte\\\\\\\\x');
  const e = pathVariants('E:\\Games\\Aegis');
  assert.equal(e.KEY, 'E--Games-Aegis');
  assert.equal(e.POSIX, '/e/Games/Aegis');
  assert.equal(e.FWD, 'E:/Games/Aegis');
});

test('Projekt-Zuordnung: ein Projekt liegt auf PC B ganz woanders', () => {
  const alice = allForms('C:\\Users\\alice', 'D', {});
  const bob = allForms('C:\\Users\\bob', 'C', { '@@CLYDE_DRIVE_RAW@@Aegis\\episode1': 'E:\\Games\\Aegis' });
  const onAlice = '{"cwd":"D:\\\\Aegis\\\\episode1","key":"D--Aegis-episode1","sh":"/d/Aegis/episode1","other":"D:\\\\Aegis\\\\episode10","raw":"D:\\Aegis\\episode1\\sub"}';
  const canon = canonicalize(onAlice, alice);
  const onBob = localize(canon, bob);
  assert.equal(onBob, '{"cwd":"E:\\\\Games\\\\Aegis","key":"E--Games-Aegis","sh":"/e/Games/Aegis","other":"C:\\\\Aegis\\\\episode10","raw":"E:\\Games\\Aegis\\sub"}');
  assert.equal(canonicalize(onBob, bob), canon, 'bobs Schreibweise muss dieselbe neutrale Form ergeben');
  assert.equal(localize('@@CLYDE_DRIVE_KEY@@Aegis-episode1/chat.jsonl', bob), 'E--Games-Aegis/chat.jsonl');
  assert.equal(canonicalize('E--Games-Aegis/chat.jsonl', bob), '@@CLYDE_DRIVE_KEY@@Aegis-episode1/chat.jsonl');
});

test('transformStream ersetzt auch Treffer, die ueber Stueckgrenzen laufen', async () => {
  const text = Array.from({ length: 50 }, (_, i) => `{"i":${i},"p":"C:\\\\Users\\\\warro\\\\f${i}"}`).join('\n') + '\nkein Umbruch am Ende C--Users-warro';
  const bytes = Buffer.from(text);
  for (const size of [1, 7, 64, 1000, 100000]) {
    const pieces = [];
    for (let o = 0; o < bytes.length; o += size) pieces.push(bytes.subarray(o, o + size));
    const out = [];
    for await (const b of transformStream(pieces, (x) => canonicalizeBuf(x, WARRO))) out.push(b);
    const joined = Buffer.concat(out).toString();
    assert.ok(!joined.includes('warro'), `Stueckgroesse ${size}: ${joined.slice(-80)}`);
    assert.equal(localize(joined, WARRO), text);
  }
});

test('nur Textdateien werden umgeschrieben', () => {
  assert.ok(isTextFile('a/b.jsonl') && isTextFile('x.JSON') && isTextFile('n.md') && isTextFile('t.txt'));
  assert.ok(!isTextFile('bild.png') && !isTextFile('abc@v2') && !isTextFile('ohne'));
});
