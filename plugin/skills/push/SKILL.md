---
name: push
description: Neue, weitergefuehrte und geloeschte Chats dieses PCs in die Sammlung des Clyde-Kontos einbringen; Chats anderer PCs bleiben erhalten. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
allowed-tools: Bash(clyde:*)
---

# Clyde: Push

Bringt die Aenderungen dieses PCs in die gemeinsame Sammlung des Clyde-Kontos
ein. Chats, die andere PCs beigetragen haben, bleiben dort erhalten. Beim ersten
Push eines PCs kommen alle seine vorhandenen Chats in die Sammlung. Die App bleibt
offen; dieser Chat (der Clyde-Chat) wird ausgelassen.
Projekt: https://github.com/Gardosen/clyde

## Ablauf

1. `clyde push --clyde-chat` ausfuehren.

2. **Abbruch, weil andere Chats arbeiten:** die Chats nennen und `/clyde:push`
   spaeter wiederholen lassen. Nicht mit `--force` wiederholen, ausser der Nutzer
   verlangt es ausdruecklich.

3. **Nicht eingerichtet** (Meldung verweist auf `clyde init`): auf `/clyde:setup`
   verweisen.

4. **Erfolg:** kurz berichten:
   - ob ein neuer gemeinsamer Stand entstanden ist oder nichts Neues da war
   - wie viele Dateien dieser PC beigetragen hat und wie viel uebertragen wurde
   - meldet Clyde Aenderungen anderer PCs, `/clyde:pull` empfehlen
   Keine Einzeldateien auflisten.
