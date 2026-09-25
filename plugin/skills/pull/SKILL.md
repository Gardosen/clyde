---
name: pull
description: Neuesten (oder einen bestimmten) Snapshot vom Clyde-Backend auf diesen PC holen, sodass alle Chats exakt dem Stand des anderen PCs entsprechen. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
argument-hint: "[snapshot-id]"
allowed-tools: Bash(clyde:*)
---

# Clyde: Pull

Holt einen Snapshot vom Clyde-Backend und stellt den Zustand aller Chats exakt
her. Die App bleibt offen. Dieser Chat (der Clyde-Chat) bleibt unveraendert.
Vor dem Schreiben legt Clyde ein Backup unter `~/.clyde/backups` an.
Projekt: https://github.com/Gardosen/clyde

Snapshot-ID vom Nutzer (leer = neuester): `$ARGUMENTS`

## Ablauf

1. **Trockenlauf:** `clyde pull $ARGUMENTS --clyde-chat --dry-run --no-ask`

2. **Fehlende Projektordner:** Enthaelt die Ausgabe Zeilen mit
   `clyde map --add "<NEUTRAL>" "PFAD-AUF-DIESEM-PC"`, fehlt auf diesem PC ein
   Projektordner. Fuer jeden den Nutzer fragen, wo das Projekt hier liegt (die
   Meldung nennt den Pfad auf dem anderen PC). Mit seiner Antwort
   `clyde map --add "<NEUTRAL>" "<PFAD>"` ausfuehren, den neutralen Pfad exakt aus
   der Meldung uebernehmen. Will der Nutzer ein Projekt ueberspringen, weitermachen.
   Danach den Trockenlauf wiederholen.

3. **Plan zeigen:** Die Zeile `Plan: ... neu, ... geaendert, ... loeschen` wiedergeben.
   Loescht der Plan Chat-Transkripte (Zeilen `- claude-projects/.../<id>.jsonl`),
   diese Chats nennen und vor dem echten Pull ausdruecklich bestaetigen lassen.
   Sonst direkt weiter.

4. **Pull:** `clyde pull $ARGUMENTS --clyde-chat --no-ask`
   - Abbruch, weil andere Chats arbeiten: die Chats nennen, Nutzer spaeter erneut
     `/clyde:pull` aufrufen lassen. Nicht mit `--force` wiederholen, ausser der
     Nutzer verlangt es.
   - Nicht eingerichtet: auf `/clyde:setup` verweisen.

5. **Ergebnis melden:** Snapshot-ID, Quell-PC, Anzahl neu/geaendert/geloescht,
   Ort des Backups. Jede Zeile `Hinweis:` aus der Ausgabe weitergeben, besonders:
   - Chats, die gerade in der App geoeffnet sind, erst nach einem Neustart der App
     weiterverwenden.
   - Neue Chats erscheinen in der Seitenleiste eventuell erst nach einem Neustart.
