---
name: delete
description: Gespeicherte Staende (Snapshots) des Clyde-Kontos auf dem Server loeschen und den Speicher freigeben. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
argument-hint: "[STAND-ID ...]"
allowed-tools: Bash(clyde:*), AskUserQuestion
---

# Clyde: Staende loeschen

Jeder Push legt auf dem Server einen Stand an. Gleiche Inhalte liegen dort nur
einmal; Loeschen gibt deshalb nur den Platz frei, den kein anderer Stand mehr
braucht. Aeltere Staende lassen sich gefahrlos loeschen: Ein PC, dessen letzter
Abgleich einen geloeschten Stand betraf, vereinigt beim naechsten Mal nur (bei ihm
wird nichts geloescht, Loeschungen anderer PCs kommen dort einmal nicht an).
Chats auf den PCs selbst bleiben immer unberuehrt.
Projekt: https://github.com/Gardosen/clyde

Argumente vom Nutzer: `$ARGUMENTS`

## Ablauf

1. **Liste holen:** `clyde list`
   Jede Zeile: Stand-ID, Zeitpunkt, Quell-PC, Dateien, Groesse, „frei beim
   Loeschen" und Markierungen („neuester, gemeinsamer Stand", „Basis dieses PCs").
   Dem Nutzer als kurze Tabelle zeigen (neueste zuerst).

2. **Auswahl:** Hat der Nutzer IDs angegeben, diese nehmen. Sonst mit
   **AskUserQuestion** fragen (multiSelect), hoechstens vier Optionen, zum Beispiel:
   - „Alle bis auf die neuesten 3" (nur anbieten, wenn es mehr als 3 gibt)
   - die aeltesten Staende einzeln, mit Datum, Quell-PC und „frei beim Loeschen"
   Der neueste Stand wird nie als Option angeboten. Andere IDs kann der Nutzer
   unter „Other" eintippen.

3. **Trockenlauf:** `clyde delete ID [ID ...] --dry-run`
   Zeigt, was geloescht wird und wie viel mindestens frei wird.
   - Ist der neueste Stand dabei, die Zeile `WARNUNG:` woertlich weitergeben und
     ausdruecklich fragen, ob er wirklich geloescht werden soll. Nur bei klarem Ja
     `--force` verwenden, sonst den neuesten Stand aus der Auswahl nehmen.

4. **Bestaetigen** mit **AskUserQuestion** („Loeschen" / „Abbrechen"), mit der
   Liste und dem frei werdenden Platz in der Frage.

5. **Loeschen:** `clyde delete ID [ID ...] --yes` (mit `--force` nur nach Schritt 3).
   Clyde raeumt danach selbst auf (gc) und meldet den freigegebenen Platz.

6. **Ergebnis melden:** geloeschte Staende und freigegebener Platz. Meldet Clyde
   Chunks, die erst nach der Schutzfrist frei werden (laufende Pushs), darauf
   hinweisen, dass ein spaeteres `clyde gc` sie entfernt.
