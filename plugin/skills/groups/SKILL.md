---
name: groups
description: Gruppen der Chatliste (Seitenleiste) aus dem gemeinsamen Stand des Clyde-Kontos in die App uebernehmen, ohne Neustart. Wird am Ende von /clyde:pull verwendet; auch einzeln auf ausdruecklichen Aufruf.
disable-model-invocation: true
allowed-tools: Bash(clyde:*), mcp__ccd_sidebar__list_groups, mcp__ccd_sidebar__create_group, mcp__ccd_sidebar__move_sessions, mcp__ccd_sidebar__set_pinned, mcp__ccd_session_mgmt__list_sessions
---

# Clyde: Gruppen uebernehmen

Die Desktop-App speichert Gruppen in ihrer eigenen Einstellungsdatei, die Clyde
nicht beschreibt. Clyde kennt aber aus dem gemeinsamen Stand, welcher Chat in
welche Gruppe gehoert. Dieser Skill setzt das mit den Seitenleisten-Werkzeugen der
App um, sofort und ohne Neustart. Gruppen werden am Namen erkannt.
Projekt: https://github.com/Gardosen/clyde

## Ablauf

1. **Soll-Zustand holen:** `clyde groups --json`
   Liefert `{ "groups": [{ "name", "sessions": ["local_..."] }], "pinned": [...], "titles": {...} }`.
   Ist `groups` und `pinned` leer: melden, dass nichts zu tun ist, und aufhoeren.

2. **Ist-Zustand der App:**
   - `mcp__ccd_sidebar__list_groups` (vorhandene Gruppen mit id und Name).
     Schlaegt das fehl, weil noch kein App-Fenster Gruppen gemeldet hat: den Nutzer
     bitten, den Code-Bereich der App einmal anzuzeigen, dann erneut versuchen.
   - `mcp__ccd_session_mgmt__list_sessions` mit `limit: 500` und
     `include_archived: true` (welche Chats die App kennt, mit `group` und `pinned`).

3. **Plan bilden** (nichts ueberschreiben, was der Nutzer hier selbst eingeordnet hat):
   - Gruppen, die es in der App unter diesem Namen (Gross/Klein egal) noch nicht
     gibt, werden angelegt.
   - Ein Chat wird nur verschoben, wenn die App ihn kennt und er hier noch in
     **keiner** Gruppe liegt (`group` ist null). Liegt er schon in einer anderen
     Gruppe, bleibt er dort; im Bericht nennen.
   - Chats aus `sessions`, die die App noch nicht kennt (gerade erst geholt), zaehlen:
     sie erscheinen nach dem naechsten Neustart der App; danach `/clyde:groups`
     erneut aufrufen.
   - Anheften: Chats aus `pinned`, die die App kennt und die noch nicht angeheftet
     sind.

4. **Umsetzen:**
   - fehlende Gruppen: `mcp__ccd_sidebar__create_group` mit dem Namen aus `groups`
   - je Gruppe **ein** Aufruf `mcp__ccd_sidebar__move_sessions` mit allen zu
     verschiebenden Chats dieser Gruppe (hoechstens 100 je Aufruf). Die App fragt
     dabei eventuell einmal je Aufruf nach Zustimmung.
   - danach Anheften: `mcp__ccd_sidebar__set_pinned` mit `pinned: true` (erst nach
     dem Verschieben, denn Verschieben in eine Gruppe loest das Anheften).
   Nie Gruppen loeschen oder umbenennen, nie Chats nach „Ungrouped" verschieben.

5. **Bericht:** kurz: angelegte Gruppen, je Gruppe wie viele Chats einsortiert
   wurden (Titel aus `titles` nur bei wenigen), was hier anders eingeordnet blieb
   und wie viele Chats erst nach einem Neustart der App einsortiert werden koennen.
