---
name: update
description: Clyde auf diesem PC aktualisieren - das Clyde-Plugin in der App und das Clyde-CLI auf die neueste Version von GitHub bringen. Fragt vorher nach. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
allowed-tools: Bash(clyde:*), Bash(npm install -g github:Gardosen/clyde*), AskUserQuestion
---

# Clyde: Aktualisieren

Bringt das Clyde-Plugin in der App und das Clyde-CLI auf die neueste Version aus
https://github.com/Gardosen/clyde. Fragt dafuer github.com nach der neuesten
Version. Den Server aktualisiert der Nutzer selbst (Hinweis wird angezeigt).

## Ablauf

1. **Pruefen:** `clyde update --check --json`
   Liefert `{ client, plugin, server, latest, target, actions: [{ what, from, to, skip? }], serverNote }`.
   - Meldet Clyde „Unbekannter Befehl "update"", ist das CLI aelter als 0.4.8:
     mit **AskUserQuestion** fragen, ob es aktualisiert werden soll; bei Ja
     `npm install -g github:Gardosen/clyde` ausfuehren und danach wieder bei
     Schritt 1 beginnen.
   - Ist `actions` leer: melden, dass alles aktuell ist (Versionen nennen), und
     `serverNote` weitergeben, falls vorhanden. Fertig.

2. **Nachfragen** mit **AskUserQuestion** (eine Frage): was aktualisiert wird,
   z. B. „Plugin 0.4.1 -> 0.4.8, CLI 0.4.7 -> 0.4.8". Eintraege mit `skip` mit
   Grund nennen (werden nicht angefasst, z. B. Entwicklungsinstallation).
   Optionen: **Aktualisieren** / **Nicht jetzt**.

3. **Aktualisieren:** `clyde update --yes`
   - Meldet es beim Plugin, dass eine Befehls-Bestaetigung noetig ist oder Claudes
     CLI nicht gefunden wurde: den Nutzer bitten, das Plugin in der App unter
     Customize -> Plugins -> clyde zu aktualisieren. Nie selbst etwas bestaetigen
     oder erzwingen.
   - Schlaegt das CLI-Update mit fehlenden Rechten fehl: die Meldung weitergeben.

4. **Ergebnis melden:** neue Versionen von Plugin und CLI. Hinweis: neue und
   geaenderte Befehle des Plugins gibt es in neuen Chats, sicher nach einem
   Neustart der App. `serverNote` weitergeben, falls vorhanden.
