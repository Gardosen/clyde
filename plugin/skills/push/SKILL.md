---
name: push
description: Neue, weitergefuehrte und geloeschte Chats dieses PCs in die Sammlung des Clyde-Kontos einbringen; fragt vorher nach Vergessenem (nicht committete oder nicht gepushte Git-Arbeit, neue Repos). Chats anderer PCs bleiben erhalten. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
allowed-tools: Bash(clyde:*), AskUserQuestion
---

# Clyde: Push

Bringt die Aenderungen dieses PCs in die gemeinsame Sammlung des Clyde-Kontos
ein. Chats, die andere PCs beigetragen haben, bleiben dort erhalten. Beim ersten
Push eines PCs kommen alle seine vorhandenen Chats in die Sammlung. Die App bleibt
offen; dieser Chat (der Clyde-Chat) wird ausgelassen.
Vorher fragt der Skill nach Vergessenem, damit der Nutzer es nachreichen kann:
Git-Arbeit, die noch nicht auf dem Remote liegt, und neu gefundene Repos.
Projekt: https://github.com/Gardosen/clyde

## Ablauf

1. **Pruefen:** `clyde push --check --json`
   Liefert JSON `{ "items": [...], "busy": [...] }`. Ist `items` leer, direkt mit
   Schritt 4 weiter, ohne Rueckfrage.

2. **Nachfragen** mit **AskUserQuestion**, hoechstens vier Fragen pro Aufruf (bei
   mehr Punkten mehrere Aufrufe nacheinander). Immer den Repo-Namen in den `header`.

   a) Eintraege `"kind": "work"` (ein Repo, das Clyde mitnimmt, mit Arbeit, die
      nicht auf dem Remote liegt), je Repo eine Frage. In der Frage nennen, was
      fehlt: `changed` geaenderte Dateien, `untracked` neue Dateien, `ahead`
      Commits nicht gepusht, `noUpstream` Branch ohne Upstream, und die ersten
      Eintraege aus `files`.
      - Ist `busyChats` nicht leer: nichts anbieten, was committet oder pusht. Nur
        melden, dass dort gerade ein Chat arbeitet, und mit „Ueberspringen" /
        „Push abbrechen" fragen.
      - Gibt es geaenderte oder neue Dateien, diese Optionen:
        1. **Committen und pushen**, Beschreibung: „Alle Aenderungen committen
           (.gitignore gilt) und auf den Remote pushen. Eigene Commit-Nachricht
           unter ‚Other' eintippen."
        2. **Nur Commits pushen** (nur wenn `ahead` > 0 oder `noUpstream`)
        3. **Ueberspringen**, Beschreibung: „Fehlt auf den anderen PCs, bis es
           auf dem Remote liegt."
        4. **Push abbrechen**
      - Sonst (nur nicht gepushte Commits oder kein Upstream): **Pushen**,
        **Ueberspringen**, **Push abbrechen**.
      - `noRemote`: nur melden (ohne Remote laesst es sich woanders nicht klonen)
        und mit **Ueberspringen** / **Nicht mehr vorschlagen** fragen.
   b) Eintraege `"kind": "new"` (Repo in oder unter einem Chat-Ordner, ueber das
      noch nicht entschieden ist): zusammen in Fragen mit `multiSelect: true`, je
      bis zu vier Repos, Option = Name, Beschreibung = Remote und Groesse. Frage:
      „Neu gefundene Git-Repos: welche sollen alle deine PCs mitnehmen? Nicht
      gewaehlte werden nicht mehr vorgeschlagen (aenderbar mit /clyde:repos)."

3. **Umsetzen**, genau nach den Antworten:
   - Push abbrechen: sofort aufhoeren, nichts weiter ausfuehren.
   - Committen und pushen: `clyde repos --commit "REPO"`, mit eigener Nachricht
     `clyde repos --commit "REPO" --message "TEXT"` (Text aus „Other").
   - Pushen / Nur Commits pushen: `clyde repos --push "REPO"`
   - Nicht mehr vorschlagen (noRemote): `clyde repos --ignore "REPO"`
   - neue Repos: gewaehlte mit `clyde repos --add "REPO" ...`, nicht gewaehlte mit
     `clyde repos --ignore "REPO" ...`
   Schlaegt ein Befehl fehl (z. B. „Der Remote hat neuere Commits"), die Meldung
   weitergeben, das Repo nicht weiter anfassen und mit dem Push fortfahren. Nie
   selbst zusammenfuehren, zuruecksetzen oder `--force` verwenden.

4. **Push:** `clyde push --clyde-chat`
   - Abbruch, weil andere Chats arbeiten: die Chats nennen und `/clyde:push`
     spaeter wiederholen lassen. Nicht mit `--force` wiederholen, ausser der
     Nutzer verlangt es ausdruecklich.
   - Nicht eingerichtet (Meldung verweist auf `clyde init`): auf `/clyde:setup`
     verweisen.
   - Abbruch „Dieses Clyde ... ist zu alt fuer den Server": den genannten
     Aktualisierungsbefehl weitergeben; nicht erneut versuchen.
   - Warnungen zur Version (veraltetes Clyde oder aelterer Server) im Bericht nennen.

5. **Ergebnis melden:** kurz
   - was nachgereicht wurde (committet, gepusht, Repos dazu oder ignoriert)
   - ob ein neuer gemeinsamer Stand entstanden ist oder nichts Neues da war
   - wie viele Dateien dieser PC beigetragen hat und wie viel uebertragen wurde
   - meldet Clyde Aenderungen anderer PCs, `/clyde:pull` empfehlen
   - verbliebene Git-Warnungen des Pushs weitergeben (uebersprungen = fehlt auf
     den anderen PCs)
   Keine Einzeldateien auflisten.
