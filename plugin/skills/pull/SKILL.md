---
name: pull
description: Neue und geaenderte Chats der anderen PCs dieses Clyde-Kontos holen; eigene Chats bleiben erhalten. Fragt nach Projektordnern, die es hier nicht gibt. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
argument-hint: "[--exact STAND-ID]"
allowed-tools: Bash(clyde:*), AskUserQuestion, mcp__ccd_sidebar__list_groups, mcp__ccd_sidebar__create_group, mcp__ccd_sidebar__move_sessions, mcp__ccd_sidebar__set_pinned, mcp__ccd_session_mgmt__list_sessions
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
   und vor dem echten Pull bestaetigen lassen. Zeilen `Git: ... wird geklont`
   nennen (Ordner und Remote); das Klonen kann bei grossen Repos dauern. Sonst
   direkt weiter.

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
   Die Zeile `Git-Repos: ...` wiedergeben (geklont, vorgespult, uebersprungen mit
   Grund). Schlaegt Klonen oder Holen fehl, fehlt meist der Zugang zum Remote auf
   diesem PC (SSH-Schluessel oder Git-Anmeldung einrichten, dann erneut
   `/clyde:pull`). Uebersprungene Repos mit lokalen Aenderungen oder eigenen
   Commits nie selbst zuruecksetzen oder ueberschreiben.

6. **Gruppen und angeheftete Chats uebernehmen** (nur wenn der Pull nicht
   abgebrochen wurde; nur in der App, im Terminal ueberspringen):
   - `clyde groups --json` liefert `groups` (Name + `sessions`), `pin` und `unpin`.
     Alle leer: nichts tun.
   - `mcp__ccd_sidebar__list_groups` und `mcp__ccd_session_mgmt__list_sessions`
     (`limit: 500`, `include_archived: true`).
   - Fehlende Gruppen (Name, Gross/Klein egal) mit `mcp__ccd_sidebar__create_group`
     anlegen. Je Gruppe ein `mcp__ccd_sidebar__move_sessions` mit den Chats, die die
     App kennt und die hier noch in keiner Gruppe liegen (`group` null). Chats, die
     schon anders eingeordnet sind, bleiben dort.
   - Danach (Verschieben loest das Anheften): jeden Chat aus `pin`, den die App
     kennt und der jetzt nicht angeheftet ist, mit `mcp__ccd_sidebar__set_pinned`
     (`pinned: true`) anheften; jeden Chat aus `unpin`, der angeheftet ist, mit
     `pinned: false` loesen.
   - Nie Gruppen loeschen, umbenennen oder Chats nach „Ungrouped" verschieben.
   - Melden, wie viele Chats einsortiert, angeheftet oder geloest wurden. Chats,
     die die App noch nicht kennt, werden erst nach einem Neustart sichtbar
     (angeheftete dann schon angeheftet); danach `/clyde:groups` aufrufen.
