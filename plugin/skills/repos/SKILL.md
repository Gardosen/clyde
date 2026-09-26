---
name: repos
description: Git-Repos auswaehlen, die Clyde zwischen den PCs mitnimmt (auf neuen PCs klonen, vorhandene saubere Klone vorspulen). Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
allowed-tools: Bash(clyde:*), AskUserQuestion
---

# Clyde: Git-Repos auswaehlen

Clyde nimmt automatisch jedes Git-Repo mit, in dem ein Chat arbeitet (Projektordner
des Chats). Hier waehlt der Nutzer weitere Repos dazu, zum Beispiel Projekte unter
einem gemeinsamen Oberordner. Beim Pull klonen die anderen PCs diese Repos in
denselben Ordner (neutral umgerechnet wie alle Pfade) oder spulen einen sauberen
Klon vor. Lokale Aenderungen fasst Clyde nie an. Es kommt nur an, was auf dem Remote
liegt. Zum Klonen braucht jeder PC eigenen Zugang zum Remote (SSH-Schluessel
oder Git-Anmeldung).
Projekt: https://github.com/Gardosen/clyde

## Ablauf

1. **Stand holen:** `clyde repos` (was im gemeinsamen Stand steht und was auf
   diesem PC ausgewaehlt ist), dann `clyde repos --scan` (Kandidaten in und direkt
   unter den Projektordnern der Chats, mit Remote, Branch, Groesse und Status).

2. **Liste zeigen:** kurze Tabelle mit Nummer, Ordnername, Remote, Groesse und
   Status (automatisch / ausgewaehlt / nicht ausgewaehlt). Warnungen wie „Commits
   nicht gepusht" oder „Dateien nicht committet" mit anzeigen.

3. **Auswahl** mit **AskUserQuestion** (multiSelect), hoechstens vier Repos je Frage
   und hoechstens vier Fragen; bei mehr Kandidaten die uebrigen per „Other" als
   Nummern eintippen lassen.
   - Repos mit Status „automatisch" nicht zur Wahl stellen, die sind immer dabei.
   - In der Beschreibung jeder Option Remote und Groesse nennen; schon ausgewaehlte
     mit „(schon ausgewaehlt)" kennzeichnen.
   - In der Frage darauf hinweisen, dass jedes gewaehlte Repo auf allen PCs des
     Kontos geklont wird (bei grossen oder fremden Repos bedenken).
   Die Antwort ist die gewuenschte Auswahl: neu Gewaehlte hinzufuegen, bisher
   Ausgewaehlte, die jetzt nicht mehr gewaehlt sind, abwaehlen.

4. **Umsetzen:**
   - hinzufuegen: `clyde repos --add "PFAD" ["PFAD" ...]`
   - abwaehlen: `clyde repos --remove "PFAD"` (je Repo einmal)
   Die Pfade exakt aus der Scan-Liste uebernehmen.

5. **Ergebnis melden:** was jetzt ausgewaehlt ist. Die Auswahl wirkt mit dem
   naechsten `/clyde:push`; die anderen PCs holen die Repos mit `/clyde:pull`.
   Abgewaehlte Repos verschwinden aus dem gemeinsamen Stand; vorhandene Klone auf
   anderen PCs bleiben, werden aber nicht mehr aktualisiert. Nie selbst
   committen, pushen oder Repos zuruecksetzen.
