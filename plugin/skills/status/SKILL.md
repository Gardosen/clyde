---
name: status
description: Clyde-Ueberblick - letzter Snapshot auf dem Server, lokale Aenderungen seit dem letzten Sync, welche Chats gerade arbeiten. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
allowed-tools: Bash(clyde:*)
---

# Clyde: Status

Projekt: https://github.com/Gardosen/clyde

1. `clyde status` ausfuehren.
2. Knapp berichten:
   - neuester Snapshot auf dem Server und von welchem PC
   - was hier zuletzt passiert ist (push oder pull)
   - lokale Aenderungen seit dem letzten Sync
   - ob gerade andere Chats arbeiten (dann sind push/pull blockiert)
   - ob ein neuerer Snapshot bereitliegt; dann `/clyde:pull` empfehlen
3. Meldet Clyde, dass es nicht eingerichtet ist, auf `/clyde:setup` verweisen.
