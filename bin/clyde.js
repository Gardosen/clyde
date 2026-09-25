#!/usr/bin/env node
import os from 'node:os';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { log } from '../src/log.js';
import { push, pull } from '../src/commands.js';
import { init, map, list, status, doctor, gc, del, relocate } from '../src/commands-misc.js';

const HELP = `clyde - synchronisiert den Zustand der Claude-Desktop-App-Chats zwischen PCs

Befehle
  init --server URL --token TOKEN  Ersteinrichtung (fragt im Terminal nach, was fehlt)
       [--project-drive D]          Laufwerk, auf dem hier die Projekte ausserhalb des Home liegen
       [--home PFAD] [--clyde-chat] Home-Verzeichnis ueberschreiben; aufrufenden Chat als Clyde-Chat registrieren
  push [--clyde-chat] [--force]     lokalen Zustand als Snapshot hochladen
  pull [ID] [--dry-run] [--force]   Snapshot (neuester oder ID) exakt herstellen; fragt nach
       [--no-ask] [--clyde-chat]    dem Pfad von Projektordnern, die hier fehlen
  map [--list | --remove N]         Projekt-Zuordnungen anzeigen oder entfernen
  map --add NEUTRAL PFAD            Projekt-Zuordnung setzen (Befehl steht in der pull-Meldung)
  status [-v]                       Unterschiede zum letzten Snapshot, laufende Chats
  list                              Snapshots auf dem Server auflisten
  doctor                            Pfade, Platzhalter, Prozesse und Server pruefen
  delete ID                         Snapshot auf dem Server loeschen
  gc                                nicht mehr referenzierte Chunks auf dem Server loeschen
  relocate --chat TITEL --to ORDNER Chat einem anderen Projektordner zuordnen (App geschlossen)
  relocate --plan PLAN.json         mehrere Chats laut Plan umziehen; --dry-run zeigt nur an
  relocate --undo SICHERUNG         Umzug rueckgaengig machen

Optionen
  --clyde-chat   den aufrufenden Chat der App dauerhaft als Clyde-Chat registrieren;
                 er wird nie hochgeladen und bei keinem Pull angefasst
  --force        trotz arbeitender Chats bzw. laufender App ausfuehren (nicht empfohlen)
  --dry-run      bei pull nur anzeigen, was passieren wuerde
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
  force: values.force, dryRun: values['dry-run'], noBackup: values['no-backup'], noAsk: values['no-ask'], verbose: values.verbose,
  id: positionals[1], args: positionals.slice(1),
};
const commands = { init, push, pull, map, status, list, doctor, gc, delete: del, relocate };

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
