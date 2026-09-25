---
name: pull
description: Neue und geaenderte Chats der anderen PCs dieses Clyde-Kontos holen; eigene Chats bleiben erhalten. Fragt nach Projektordnern, die es hier nicht gibt. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
argument-hint: "[--exact STAND-ID]"
allowed-tools: Bash(clyde:*), AskUserQuestion
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

2. **Fehlende Projektordner klaeren.** Fuer jede Meldung
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
   Danach je Antwort:
   - Pfad: `clyde map --add "<NEUTRAL>" "<PFAD>"` (den neutralen Pfad exakt aus der
     Meldung uebernehmen). Existiert der Pfad nicht, nachfragen, ob er angelegt
     werden soll, dann mit `--create`.
   - Ordner anlegen: `clyde map --add "<NEUTRAL>" "~/ClydeProjekte/<Name>" --create`
   - Weglassen: nichts tun.
   Danach den Trockenlauf wiederholen.

3. **Plan zeigen:** die Zeile `Plan: ...` kurz wiedergeben. Werden Chats
   entfernt, weil sie auf einem anderen PC geloescht wurden, diese Chats nennen
   und vor dem echten Pull bestaetigen lassen. Sonst direkt weiter.

4. **Pull:** `clyde pull $ARGUMENTS --clyde-chat --no-ask`
   - Abbruch, weil andere Chats arbeiten: die Chats nennen, spaeter erneut
     `/clyde:pull`. Nicht mit `--force` wiederholen, ausser der Nutzer verlangt es.
   - Nicht eingerichtet: auf `/clyde:setup` verweisen.

5. **Ergebnis melden:** wie viele Chats neu oder aktualisiert sind, wie viele
   eigene Aenderungen noch hochzuladen sind (dann `/clyde:push` empfehlen), Ort
   der Sicherung. Jede Zeile `Hinweis:` weitergeben, besonders: geoeffnete Chats
   erst nach einem Neustart der App weiterverwenden; neue Chats erscheinen in der
   Seitenleiste eventuell erst nach einem Neustart.
