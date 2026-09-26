---
name: groups
description: Seitenleiste aus dem gemeinsamen Stand des Clyde-Kontos in die App uebernehmen, ohne Neustart - Gruppen (auch umbenannte), angeheftete Chats und umbenannte Chats. Wird am Ende von /clyde:pull verwendet; auch einzeln auf ausdruecklichen Aufruf.
disable-model-invocation: true
allowed-tools: Bash(clyde:*), mcp__ccd_sidebar__list_groups, mcp__ccd_sidebar__create_group, mcp__ccd_sidebar__rename_group, mcp__ccd_sidebar__move_sessions, mcp__ccd_sidebar__set_pinned, mcp__ccd_session_mgmt__list_sessions, mcp__ccd_session_mgmt__set_session_title
---

# Clyde: Seitenleiste abgleichen

Die Desktop-App speichert Gruppen in ihrer Einstellungsdatei, die Clyde nicht
beschreibt. Titel und „angeheftet" stehen im Eintrag jedes Chats; die laufende App
kennt Aenderungen daran aber erst nach einem Neustart und wuerde sie bis dahin
ueberschreiben. Dieser Skill setzt alles mit den Werkzeugen der App um, sofort und
ohne Neustart.
Projekt: https://github.com/Gardosen/clyde

## Ablauf

1. **Soll-Zustand holen:** `clyde groups --json`
   ```
   { "renames": [{ "groupId", "from", "to" }],
     "groups":  [{ "name", "groupId" (Gruppe hier oder null), "sessions": ["local_..."] }],
     "pin": [...], "unpin": [...],
     "retitle": [{ "id", "title" }],
     "titles": { ... } }
   ```
   Sind alle Listen leer: `clyde groups --done` ausfuehren, melden, dass nichts zu
   tun ist, und aufhoeren.

2. **Ist-Zustand der App:**
   - `mcp__ccd_sidebar__list_groups` (Gruppen mit id und Name). Schlaegt das fehl,
     weil noch kein App-Fenster Gruppen gemeldet hat: den Nutzer bitten, den
     Code-Bereich der App einmal anzuzeigen, dann erneut versuchen.
   - `mcp__ccd_session_mgmt__list_sessions` mit `limit: 500` und
     `include_archived: true` (Chats mit `title`, `group` und `pinned`; fehlt
     `pinned`, gilt der Chat als nicht angeheftet).

3. **Umsetzen**, in dieser Reihenfolge:
   a) **Gruppen umbenennen:** fuer jeden Eintrag aus `renames`, dessen `groupId` es in
      der App gibt und der noch `from` heisst: `mcp__ccd_sidebar__rename_group`
      (`group_id`, `name: to`). Gibt es schon eine andere Gruppe mit dem Namen `to`,
      nicht umbenennen, sondern im Bericht nennen.
   b) **Zielgruppe je Eintrag aus `groups`:** `groupId`, wenn es sie in der App gibt;
      sonst die Gruppe mit gleichem Namen (Gross/Klein egal); sonst mit
      `mcp__ccd_sidebar__create_group` anlegen, aber nur, wenn es Chats zu
      verschieben gibt.
   c) **Einsortieren:** je Gruppe **ein** `mcp__ccd_sidebar__move_sessions` mit den
      Chats aus `sessions`, die die App kennt und die hier noch in **keiner** Gruppe
      liegen (`group` null). Chats in einer anderen Gruppe bleiben dort (im Bericht
      nennen). Hoechstens 100 je Aufruf.
   d) **Anheften:** jeder Chat aus `pin`, den die App kennt und der jetzt nicht
      angeheftet ist: `mcp__ccd_sidebar__set_pinned` mit `pinned: true`
      (Verschieben in eine Gruppe loest das Anheften, deshalb nach c).
      **Loesen:** jeder Chat aus `unpin`, der angeheftet ist: `pinned: false`.
   e) **Titel:** jeder Chat aus `retitle`, den die App kennt und dessen `title` in
      der App anders lautet: `mcp__ccd_session_mgmt__set_session_title`
      (`session_id: id`, `title`). Die App fragt dabei eventuell nach Zustimmung.
   f) **Abschliessen:** `clyde groups --done` (merkt sich die Zuordnung der Gruppen
      und leert die Merkliste des letzten Pulls). Nur ausfuehren, wenn a) bis e)
      ohne Abbruch durchliefen.

   Nie Gruppen loeschen, nie Chats nach „Ungrouped" verschieben, nie andere Chats
   loesen oder umbenennen als die aus den Listen.

4. **Bericht:** kurz: umbenannte und angelegte Gruppen, je Gruppe wie viele Chats
   einsortiert wurden, angeheftete, geloeste und umbenannte Chats, was hier anders
   eingeordnet blieb und wie viele Chats erst nach einem Neustart der App sichtbar
   werden (danach `/clyde:groups` erneut aufrufen).
