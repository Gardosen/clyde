---
name: status
description: Clyde-Ueberblick - Versionen von Clyde und Server, letzter Snapshot auf dem Server, lokale Aenderungen seit dem letzten Sync, welche Chats gerade arbeiten. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
allowed-tools: Bash(clyde:*)
---

# Clyde: Status

Projekt: https://github.com/Gardosen/clyde

1. `clyde status` ausfuehren.
2. Knapp berichten:
   - Versionen (erste Zeile: Clyde-CLI, Plugin in der App, Server). Ist CLI oder
     Plugin veraltet, `/clyde:update` empfehlen; gibt es den Befehl im Plugin noch
     nicht (Plugin aelter als 0.4.8), anbieten, hier `clyde update --yes`
     auszufuehren, und das nur nach ausdruecklicher Zustimmung. Ist der Server
     aelter, das Server-Update nennen (git pull, docker compose up -d --build).
   - neuester Snapshot auf dem Server und von welchem PC
   - was hier zuletzt passiert ist (push oder pull)
   - lokale Aenderungen seit dem letzten Sync
   - ob gerade andere Chats arbeiten (dann sind push/pull blockiert)
   - ob ein neuerer Snapshot bereitliegt; dann `/clyde:pull` empfehlen
3. Meldet Clyde, dass es nicht eingerichtet ist, auf `/clyde:setup` verweisen.
