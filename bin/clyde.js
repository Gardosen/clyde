#!/usr/bin/env node
import os from 'node:os';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { log } from '../src/log.js';
import { push, pull } from '../src/commands.js';
import { mergeSnapshots } from '../src/sync.js';
import { init, map, list, status, doctor, gc, del, relocate } from '../src/commands-misc.js';

const HELP = `clyde - synchronisiert den Zustand der Claude-Desktop-App-Chats zwischen PCs

Befehle
  init --server URL --token TOKEN  Ersteinrichtung (fragt im Terminal nach, was fehlt)
       [--project-drive D]          Laufwerk, auf dem hier die Projekte ausserhalb des Home liegen
       [--home PFAD] [--clyde-chat] Home-Verzeichnis ueberschreiben; aufrufenden Chat als Clyde-Chat registrieren
  push [--clyde-chat] [--force]     Aenderungen dieses PCs in den gemeinsamen Stand des Kontos
                                    einbringen; Chats anderer PCs bleiben erhalten
  pull [--dry-run] [--force]        Neue und geaenderte Chats anderer PCs holen, eigene behalten;
       [--no-ask] [--clyde-chat]    fragt nach Projektordnern, die hier fehlen
       [--create-missing DIR]       fehlende Projektordner unter DIR anlegen (z. B. auf dem Mac)
  pull ID --exact                   einen Stand exakt herstellen (lokale Abweichungen weg)
  merge ID ID [...]                 gespeicherte Staende zu einem gemeinsamen Stand fusionieren
  map [--list]                      Projekt-Zuordnungen anzeigen
  map --add NEUTRAL PFAD [--create] Projekt-Zuordnung setzen, --create legt den Ordner an
                                    (Befehl steht in der pull-Meldung); stellt nur die Chats
                                    dieses Projekts um. Erst mit --dry-run pruefen, dann
                                    im Terminal bestaetigen oder --yes anhaengen
  map --remove N [--dry-run|--yes]  Projekt-Zuordnung entfernen, Chats zurueckstellen
  status [-v]                       Unterschiede zum letzten Snapshot, laufende Chats
  list                              Staende auf dem Server mit frei werdendem Speicher
  doctor                            Pfade, Platzhalter, Prozesse und Server pruefen
  delete ID [ID ...]                Staende auf dem Server loeschen und aufraeumen; neuester
                                    Stand nur mit --force; ohne Terminal mit --yes bestaetigen
  gc                                nicht mehr referenzierte Chunks auf dem Server loeschen
  relocate --chat TITEL --to ORDNER Chat einem anderen Projektordner zuordnen (App geschlossen)
  relocate --plan PLAN.json         mehrere Chats laut Plan umziehen; --dry-run zeigt nur an
  relocate --undo SICHERUNG         Umzug rueckgaengig machen

Optionen
  --clyde-chat   den aufrufenden Chat der App dauerhaft als Clyde-Chat registrieren;
                 er wird nie hochgeladen und bei keinem Pull angefasst
  --force        trotz arbeitender Chats bzw. laufender App ausfuehren (nicht empfohlen)
  --dry-run      bei pull und map nur anzeigen, was passieren wuerde
  --yes          bei map und delete ohne Rueckfrage ausfuehren (fuer Plugin und Skripte)
  --rehash       bei push, pull und status den Hash-Cache ignorieren und alles neu hashen
  --no-backup    bei pull kein Backup unter ~/.clyde/backups anlegen
  --no-ask       bei pull fehlende Projektordner nur melden, nicht nachfragen
  -v, --verbose  mehr Details
  -h, --help     diese Hilfe

Zwei Arten zu synchronisieren:
  In der App: einen eigenen Chat nur fuer Clyde anlegen und dort /clyde:push bzw.
  /clyde:pull aufrufen (Plugin). Die App bleibt offen, nur Chats, die gerade
  arbeiten, blockieren. Der Clyde-Chat selbst wird nie synchronisiert.
  Im Terminal: Claude-App schliessen, "clyde push" bzw. "clyde pull".
Benutzerkonten, Projektlaufwerk und einzelne Projektpfade duerfen sich zwischen
den PCs unterscheiden: Clyde ersetzt sie durch Platzhalter und setzt auf jedem
PC die eigenen Werte wieder ein.`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      server: { type: 'string' },
      token: { type: 'string' },
      home: { type: 'string' },
      'project-drive': { type: 'string' },
      remove: { type: 'string' },
      plan: { type: 'string' },
      exact: { type: 'boolean', default: false },
      'create-missing': { type: 'string' },
      chat: { type: 'string' },
      to: { type: 'string' },
      undo: { type: 'string' },
      add: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      'clyde-chat': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'no-backup': { type: 'boolean', default: false },
      'no-ask': { type: 'boolean', default: false },
      create: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      rehash: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (e) {
  log.error(e.message);
  process.exit(2);
}

const { values, positionals } = args;
// "~" am Anfang eines Pfads als Benutzerordner lesen; cmd.exe erweitert es nicht selbst
function expandHome(p) {
  return typeof p === 'string' ? p.replace(/^~(?=$|[\\/])/, os.homedir()) : p;
}
const cmd = positionals[0];
if (values.help || !cmd) { console.log(HELP); process.exit(cmd ? 0 : 1); }
log.setVerbose(values.verbose);

const opts = {
  server: values.server, token: values.token, home: values.home, projectDrive: values['project-drive'],
  remove: values.remove, add: values.add, list: values.list, clydeChat: values['clyde-chat'],
  plan: expandHome(values.plan), chat: values.chat, to: expandHome(values.to), undo: expandHome(values.undo),
  exact: values.exact, createMissing: expandHome(values['create-missing']), create: values.create,
  force: values.force, dryRun: values['dry-run'], noBackup: values['no-backup'], noAsk: values['no-ask'], yes: values.yes, rehash: values.rehash, verbose: values.verbose,
  id: positionals[1], args: positionals.slice(1).map(expandHome),
};
const commands = { init, push, pull, map, status, list, doctor, gc, delete: del, relocate, merge: mergeSnapshots };

try {
  const fn = commands[cmd];
  if (!fn) throw new Error(`Unbekannter Befehl "${cmd}". Hilfe: clyde --help`);
  const cfg = loadConfig({ required: !['init', 'doctor', 'relocate'].includes(cmd) });
  await fn(cfg, opts, log);
} catch (e) {
  log.error(e.message);
  if (values.verbose && e.stack) console.error(e.stack);
  process.exit(1);
}
