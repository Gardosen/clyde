---
name: pull
description: Neue und geaenderte Chats der anderen PCs dieses Clyde-Kontos holen; eigene Chats bleiben erhalten. Fragt nach Projektordnern, die es hier nicht gibt. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
argument-hint: "[--exact STAND-ID]"
allowed-tools: Bash(clyde:*), AskUserQuestion, mcp__ccd_sidebar__list_groups, mcp__ccd_sidebar__create_group, mcp__ccd_sidebar__rename_group, mcp__ccd_sidebar__move_sessions, mcp__ccd_sidebar__set_pinned, mcp__ccd_session_mgmt__list_sessions, mcp__ccd_session_mgmt__set_session_title
---

# Clyde: Pull

Holt aus der Sammlung des Clyde-Kontos alles, was andere PCs neu angelegt,
weitergefuehrt oder geloescht haben. Chats, die es nur auf diesem PC gibt,
bleiben erhalten; sie kommen mit dem naechsten `/clyde:push` in die Sammlung.
Die App bleibt offen. Dieser Chat (der Clyde-Chat) bleibt unveraendert. Vor dem
Schreiben legt Clyde eine Sicherung unter `~/.clyde/backups` an.
Projekt: https://github.com/Gardosen/clyde

Argumente vom Nutzer: `$ARGUMENTS`
(`--exact STAND-ID` stellt einen gespeicherten Stand exakt her und entfernt
dabei lokale Abweichungen; nur nutzen, wenn der Nutzer das ausdruecklich will.)

## Ablauf

1. **Trockenlauf:** `clyde pull $ARGUMENTS --clyde-chat --dry-run --no-ask`

1b. **Repos der Chats klaeren.** `clyde refs --pending --json` liefert unter
   `problems` die Git-Repos, die Chats brauchen und die auf diesem Geraet noch nicht
   eingetragen sind oder nicht stimmen (`name`, `remote`, `status`, `path`,
   `suggested`, `chats`). Die Projektordner dieser Chats werden in Schritt 2 nicht
   eigens erfragt. Je Repo mit **AskUserQuestion** fragen (hoechstens vier je
   Aufruf, Repo-Name im `header`, betroffene Chats in der Frage):
   1. **Vom Remote klonen**, Beschreibung: „Nach `suggested` klonen. Anderen
      Zielordner unter ‚Other' als ‚klonen: PFAD' eintippen."
   2. **Liegt schon hier**, Beschreibung: „Den Pfad unter ‚Other' eintippen."
   3. **Ueberspringen**, Beschreibung: „Auf diesem Geraet nicht mehr anbieten."
   Umsetzen: `clyde refs --clone NAME [--to "PFAD"]`, `clyde refs --set NAME "PFAD"`
   oder `clyde refs --skip NAME`. Die Antwort wird sofort fuer dieses Geraet
   gespeichert; Clyde stellt die Chats des Repos auf den Ort hier um. Schlaegt
   das Klonen fehl (meist fehlt der SSH-Schluessel oder die Git-Anmeldung fuer den
   Remote), die Meldung weitergeben und nichts anderes versuchen. Lehnt Clyde
   einen Pfad ab (fehlt, kein Git-Repo, anderes Repo), die Meldung weitergeben und
   noch einmal fragen.

2. **Fehlende Projektordner klaeren.** Fehlen mehr als vier Ordner (typisch beim
   ersten Pull auf einem neuen Rechner, etwa einem Mac), zuerst mit
   **AskUserQuestion** fragen, ob Clyde alle fehlenden Ordner gesammelt unter
   `~/ClydeProjekte/<Name>` anlegen soll (dann
   `clyde pull $ARGUMENTS --clyde-chat --no-ask --create-missing ~/ClydeProjekte`
   als Trockenlauf mit `--dry-run` und danach echt) oder ob der Nutzer einzeln
   entscheiden will. Meldet der echte Lauf „Zuordnung fuer ... nicht gesetzt",
   diesen Ordner wie unten einzeln klaeren. Sonst, oder wenn einzeln gewuenscht, fuer jede Meldung
   „Projektordner ... gibt es hier nicht" (mit den betroffenen Chats und einer
   Zeile `clyde map --add "<NEUTRAL>" ...`) den Nutzer mit **AskUserQuestion**
   fragen, hoechstens vier Ordner pro Aufruf:
   - Frage: „Wo liegt das Projekt `<Ordner vom anderen PC>` auf diesem PC?"
     und in der Frage die betroffenen Chats nennen.
   - Optionen:
     1. **Pfad angeben** – Beschreibung: „Den Pfad unter ‚Other' eintippen."
     2. **Ordner anlegen** – Beschreibung: „Clyde legt `~/ClydeProjekte/<Name>` an."
     3. **Vorerst weglassen** – Beschreibung: „Chats kommen trotzdem, der Ordner
        laesst sich spaeter zuordnen."
   Danach je Antwort (den neutralen Pfad exakt aus der Meldung uebernehmen):
   - Pfad: Existiert der Pfad nicht, nachfragen, ob er angelegt werden soll (dann
     mit `--create`).
   - Ordner anlegen: Pfad `~/ClydeProjekte/<Name>` mit `--create`.
   - Weglassen: nichts tun.

   **Zuordnung nie ungeprueft setzen.** Erst den Plan holen:
   `clyde map --add "<NEUTRAL>" "<PFAD>" [--create] --dry-run`
   Er nennt die betroffenen Chats und wie viele Dateien und Zeilen sich aendern.
   Jede Zeile `Achtung:` woertlich an den Nutzer weitergeben. Besonders wichtig
   ist „ist hier schon Projektordner von …": Danach gelten beide Ordner als
   dasselbe Projekt, auch auf den anderen PCs. Dann mit **AskUserQuestion**
   bestaetigen lassen, mit den Optionen „Zuordnung setzen" und „Nicht setzen".
   Ohne Warnung reicht eine kurze Rueckfrage. Erst nach Zustimmung ausfuehren:
   `clyde map --add "<NEUTRAL>" "<PFAD>" [--create] --yes`
   Meldet Clyde, dass Chats des Projekts arbeiten, spaeter erneut versuchen, nie
   mit `--force`.
   Danach den Trockenlauf des Pulls wiederholen.

3. **Plan zeigen:** die Zeile `Plan: ...` kurz wiedergeben. Werden Chats
   entfernt, weil sie auf einem anderen PC geloescht wurden, diese Chats nennen
   und vor dem echten Pull bestaetigen lassen. Sonst direkt weiter.

4. **Pull:** `clyde pull $ARGUMENTS --clyde-chat --no-ask`
   - Abbruch, weil andere Chats arbeiten: die Chats nennen, spaeter erneut
     `/clyde:pull`. Nicht mit `--force` wiederholen, ausser der Nutzer verlangt es.
   - Nicht eingerichtet: auf `/clyde:setup` verweisen.
   - Abbruch „Dieses Clyde ... ist zu alt fuer den Server": den genannten
     Aktualisierungsbefehl weitergeben; nicht erneut versuchen.
   - Warnungen zur Version (veraltetes Clyde oder aelterer Server) im Bericht nennen.

5. **Ergebnis melden:** wie viele Chats neu oder aktualisiert sind, wie viele
   eigene Aenderungen noch hochzuladen sind (dann `/clyde:push` empfehlen), Ort
   der Sicherung. Die Warnung „... nicht verlustfrei umschreiben ..." weitergeben
   (diese Dateien bleiben unveraendert). Jede Zeile `Hinweis:` weitergeben, besonders: geoeffnete Chats
   erst nach einem Neustart der App weiterverwenden; neue Chats erscheinen in der
   Seitenleiste eventuell erst nach einem Neustart.
   Die Zeile `Git-Repos: ...` wiedergeben (vorgespult, aktuell, uebersprungen mit
   Grund). Schlaegt Holen fehl, fehlt meist der Zugang zum Remote auf diesem PC
   (SSH-Schluessel oder Git-Anmeldung einrichten, dann erneut `/clyde:pull`).
   Uebersprungene Repos mit lokalen Aenderungen oder eigenen Commits nie selbst
   zuruecksetzen oder ueberschreiben. Warnungen zu Verweisen (Repo fehlt hier)
   weitergeben, falls sie in Schritt 1b uebersprungen wurden.

6. **Seitenleiste abgleichen** (nur wenn der Pull nicht abgebrochen wurde; nur in
   der App, im Terminal ueberspringen): genau wie im Skill `/clyde:groups`:
   - `clyde groups --json` liefert `renames`, `groups` (Name, `groupId`,
     `sessions`), `pin`, `unpin` und `retitle`. Alle leer: `clyde groups --done`,
     sonst nichts tun.
   - `mcp__ccd_sidebar__list_groups` und `mcp__ccd_session_mgmt__list_sessions`
     (`limit: 500`, `include_archived: true`).
   - In dieser Reihenfolge:
     a) Gruppen aus `renames`, die in der App noch `from` heissen, mit
        `mcp__ccd_sidebar__rename_group` in `to` umbenennen (nicht, wenn es `to`
        schon als andere Gruppe gibt).
     b) Zielgruppe je Eintrag aus `groups`: `groupId`, sonst gleicher Name, sonst
        mit `mcp__ccd_sidebar__create_group` anlegen (nur wenn Chats zu verschieben sind).
     c) Je Gruppe ein `mcp__ccd_sidebar__move_sessions` mit den Chats, die die App
        kennt und die hier in keiner Gruppe liegen (`group` null).
     d) Chats aus `pin`, die jetzt nicht angeheftet sind: `mcp__ccd_sidebar__set_pinned`
        `pinned: true`; Chats aus `unpin`, die angeheftet sind: `pinned: false`.
     e) Chats aus `retitle`, deren Titel in der App anders lautet:
        `mcp__ccd_session_mgmt__set_session_title`.
     f) `clyde groups --done`.
   - Nie Gruppen loeschen, nie Chats nach „Ungrouped" verschieben, nie andere Chats
     loesen oder umbenennen als die aus den Listen.
   - Melden, was umbenannt, einsortiert, angeheftet oder geloest wurde. Chats, die
     die App noch nicht kennt, werden erst nach einem Neustart sichtbar (dann schon
     mit Titel und Pin); danach `/clyde:groups` aufrufen.
