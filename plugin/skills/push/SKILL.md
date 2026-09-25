---
name: push
description: Zustand aller Chats dieses PCs (ausser dem Clyde-Chat) als Snapshot zum Clyde-Backend hochladen. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
allowed-tools: Bash(clyde:*)
---

# Clyde: Push

Laedt den aktuellen Stand aller Chats dieses PCs zum Clyde-Backend hoch. Die App
bleibt offen. Dieser Chat (der Clyde-Chat) wird ausgelassen.
Projekt: https://github.com/Gardosen/clyde

## Ablauf

1. `clyde push --clyde-chat` ausfuehren.

2. **Abbruch, weil andere Chats arbeiten:** Die Ausgabe nennt die Chats. Dem
   Nutzer sagen, welche es sind, und dass er `/clyde:push` wiederholen soll,
   sobald sie fertig sind. Nicht mit `--force` wiederholen, ausser der Nutzer
   verlangt es ausdruecklich.

3. **Nicht eingerichtet** (Meldung verweist auf `clyde init`): auf `/clyde:setup`
   verweisen.

4. **Erfolg:** kurz berichten, in dieser Form:
   - Snapshot-ID
   - Anzahl Dateien und Groesse
   - wie viel tatsaechlich uebertragen wurde (nur Aenderungen gehen hoch)
   Keine Einzeldateien auflisten.
