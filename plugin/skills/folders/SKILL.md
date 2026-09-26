---
name: folders
description: Chats reparieren, deren Arbeitsordner es auf diesem PC nicht gibt ("Working folder no longer exists"), ohne dass die App eine Kopie "(fork)" anlegt - Ordner anlegen, auf einen vorhandenen Ordner umstellen oder nach einem Zurueckschreiben durch die App wieder umstellen. Prueft auch, ob die App umgestellte Ordner schon kennt. Im Clyde-Chat aufrufen. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
allowed-tools: Bash(clyde:*), AskUserQuestion, mcp__ccd_session_mgmt__get_session
---

# Clyde: fehlende Arbeitsordner

Die Claude-App laesst einen Chat nicht weiterlaufen, wenn sein Arbeitsordner fehlt
(etwa, weil der Chat von einem anderen PC kommt). Waehlt man dort „Choose folder",
legt die App eine Kopie „(fork)" ohne Gruppe an und archiviert das Original.
Clyde vermeidet das von hier aus, im Clyde-Chat:
- **Ordner anlegen:** der erwartete Ordner wird leer angelegt; der Chat laeuft
  sofort weiter.
- **Umstellen:** der Chat zeigt kuenftig auf einen vorhandenen Ordner (auf allen
  PCs gilt: dieser Ordner dort = dieser Ordner hier). Die laufende App kennt den
  neuen Ordner erst nach einem Neustart. Oeffnet man den Chat vorher, schreibt sie
  den alten Ordner zurueck; dann **wieder umstellen**.
Projekt: https://github.com/Gardosen/clyde

## Ablauf

1. `clyde folders --json` liefert
   `{ missing: [{ cwd, canonical, creatable, target, reverted, chats: [{ id, title }] }], restartPending: [{ id, title, cwd }] }`.

2. **Kennt die App die umgestellten Ordner schon?** Fuer jeden Eintrag aus
   `restartPending` `mcp__ccd_session_mgmt__get_session` mit `id` aufrufen:
   - `cwd` der App gleich `cwd` (Gross/Klein und `\`/`/` egal) oder die App kennt den
     Chat nicht (Fehler): erledigt. Alle erledigten zusammen melden:
     `clyde folders --settled ID1 ID2 ...`
   - sonst: die App wurde seit dem Umstellen nicht neu gestartet. Diese Chats im
     Bericht nennen (siehe Schritt 5).

3. `missing` leer: melden, dass alle Chats ihren Ordner haben (und Schritt 5 fuer
   offene Neustarts), dann aufhoeren. Sonst je Eintrag mit **AskUserQuestion**
   fragen (hoechstens vier je Aufruf, Header „Ordner"), in der Frage den Ordner
   `cwd` und die Chats nennen:
   - Eintrag mit `target` (die App hat den alten Ordner zurueckgeschrieben, weil
     der Chat vor dem Neustart geoeffnet wurde; `reverted` true: `target` gibt es):
     1. **Wieder auf `target` umstellen**, Beschreibung: „Wirkt nach einem Neustart
        der App; den Chat bis dahin nicht oeffnen." (gibt es `target` nicht, dazu
        „Ordner wird angelegt")
     2. **Ueberspringen**
     Nie „Ordner anlegen" anbieten: der alte Ordner wuerde das Projekt spalten.
   - sonst:
     1. **Ordner anlegen** (nur wenn `creatable`), Beschreibung: „Leer anlegen, der
        Chat laeuft sofort weiter."
     2. **Auf vorhandenen Ordner umstellen**, Beschreibung: „Den Pfad unter ‚Other'
        eintippen. Wirkt nach einem Neustart der App."
     3. **Ueberspringen**

4. Umsetzen:
   - Anlegen: `clyde folders --mkdir "CWD"`
   - Wieder umstellen: `clyde folders --reapply "CWD" --yes` (fehlt `target`:
     zusaetzlich `--create`). Keine weitere Rueckfrage noetig, der Nutzer hat das
     Ziel schon einmal bestaetigt.
   - Umstellen: erst `clyde folders --set "CWD" "PFAD" --dry-run`; die Zeilen mit den
     betroffenen Chats, Dateien und jede Zeile `Achtung:` weitergeben und mit
     **AskUserQuestion** bestaetigen lassen („Umstellen" / „Nicht umstellen").
     Dann `clyde folders --set "CWD" "PFAD" --yes`. Gibt es den Pfad noch nicht,
     nachfragen, ob er angelegt werden soll (dann zusaetzlich `--create`).
   - Meldet Clyde, dass Chats des Projekts arbeiten: spaeter erneut, nie `--force`.

5. **Bericht:** was angelegt oder (wieder) umgestellt wurde. Wurde etwas
   umgestellt oder stehen aus Schritt 2 Chats aus, deutlich sagen und die Chats
   nennen: „Die App jetzt neu starten und diese Chats vorher nicht oeffnen, sonst
   schreibt die App den alten Ordner zurueck." (Das beendet auch diesen Chat; er ist
   danach wieder da.) Nach dem Neustart erneut `/clyde:folders`: dann bestaetigt
   Schritt 2 die Chats. Liegt ein neuer Ordner in einem Git-Repo, hat Clyde es
   bereits in die Verweise eingetragen.
