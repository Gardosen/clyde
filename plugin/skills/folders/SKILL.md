---
name: folders
description: Chats reparieren, deren Arbeitsordner es auf diesem PC nicht gibt ("Working folder no longer exists"), ohne dass die App eine Kopie "(fork)" anlegt - Ordner anlegen oder auf einen vorhandenen Ordner umstellen. Im Clyde-Chat aufrufen. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
allowed-tools: Bash(clyde:*), AskUserQuestion
---

# Clyde: fehlende Arbeitsordner

Die Claude-App laesst einen Chat nicht weiterlaufen, wenn sein Arbeitsordner fehlt
(etwa, weil der Chat von einem anderen PC kommt). Waehlt man dort „Choose folder",
legt die App eine Kopie „(fork)" ohne Gruppe an und archiviert das Original.
Clyde vermeidet das von hier aus, im Clyde-Chat:
- **Ordner anlegen:** der erwartete Ordner wird leer angelegt; der Chat laeuft
  sofort weiter.
- **Umstellen:** der Chat zeigt kuenftig auf einen vorhandenen Ordner (auf allen
  PCs gilt: dieser Ordner dort = dieser Ordner hier). Die App sieht das erst nach
  einem Neustart.
Projekt: https://github.com/Gardosen/clyde

## Ablauf

1. `clyde folders --json` liefert `{ missing: [{ cwd, canonical, creatable, chats: [{ id, title }] }] }`.
   Leer: melden, dass alle Chats ihren Ordner haben, und aufhoeren.

2. Je Eintrag mit **AskUserQuestion** fragen (hoechstens vier je Aufruf, Header
   „Ordner"), in der Frage den Ordner `cwd` und die Chats nennen:
   1. **Ordner anlegen** (nur wenn `creatable`), Beschreibung: „Leer anlegen, der
      Chat laeuft sofort weiter."
   2. **Auf vorhandenen Ordner umstellen**, Beschreibung: „Den Pfad unter ‚Other'
      eintippen. Wirkt nach einem Neustart der App."
   3. **Ueberspringen**

3. Umsetzen:
   - Anlegen: `clyde folders --mkdir "CWD"`
   - Umstellen: erst `clyde folders --set "CWD" "PFAD" --dry-run`; die Zeilen mit den
     betroffenen Chats, Dateien und jede Zeile `Achtung:` weitergeben und mit
     **AskUserQuestion** bestaetigen lassen („Umstellen" / „Nicht umstellen").
     Dann `clyde folders --set "CWD" "PFAD" --yes`. Gibt es den Pfad noch nicht,
     nachfragen, ob er angelegt werden soll (dann zusaetzlich `--create`).
     Meldet Clyde, dass Chats des Projekts arbeiten: spaeter erneut, nie `--force`.

4. **Bericht:** was angelegt oder umgestellt wurde. Wurde etwas **umgestellt**,
   deutlich sagen: „Die App jetzt neu starten und diese Chats vorher nicht
   oeffnen, sonst schreibt die App den alten Ordner zurueck." (Das beendet auch
   diesen Chat; er ist danach wieder da.) Liegt ein neuer Ordner in einem
   Git-Repo, hat Clyde es bereits in die Verweise eingetragen.
