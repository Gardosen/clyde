---
name: link
description: Diesen Chat einem Git-Repo zuordnen, damit Clyde es auf den anderen Geraeten anbietet (in dem Chat aufrufen, um den es geht, nicht im Clyde-Chat). Ohne Angabe zeigt es die Zuordnung; --remove loest sie. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
argument-hint: "[PFAD-ZUM-REPO | --remove]"
allowed-tools: Bash(clyde:*), AskUserQuestion
---

# Clyde: Chat mit einem Repo verknuepfen

Ordnet **diesen** Chat einem Git-Repo zu. Clyde erkennt den Chat selbst; der
Titel muss nicht eingetippt werden. Die Zuordnung geht sofort an den Server
(Verweise), und die anderen Geraete bieten das Repo beim Pull an. Clyde aendert
dabei nur die Verweise, nie Chat-Dateien; das geht auch, waehrend andere Chats
arbeiten. Dieser Chat wird dadurch **nicht** zum Clyde-Chat.
Projekt: https://github.com/Gardosen/clyde

Argumente vom Nutzer: `$ARGUMENTS`

## Ablauf

- **Nie** `--clyde-chat` verwenden und nie `clyde init` aus diesem Chat heraus.
- Meldet Clyde, dass es nicht eingerichtet ist: sagen, dass die Einrichtung mit
  `/clyde:setup` **im eigenen Clyde-Chat** gemacht werden soll (nicht hier, sonst
  wuerde dieser Chat zum Clyde-Chat), und aufhoeren.
- Meldet Clyde, dass der Server keine Verweise kennt: Server-Update nennen (git
  pull, docker compose up -d --build) und aufhoeren.

1. **Mit Pfad** (`$ARGUMENTS` ist ein Pfad oder Repo-Name): `clyde link "$ARGUMENTS"`
   Clyde prueft den Pfad (vorhanden, Git-Repo mit Remote) und nimmt das Repo neu
   auf, falls es noch nicht in den Verweisen steht. Lehnt Clyde ab (kein
   Git-Repo, kein Remote), die Meldung weitergeben und nach einem anderen Pfad
   fragen (wie in Schritt 3).

2. **`--remove`:** `clyde link --unlink` und das Ergebnis melden.

3. **Ohne Angabe:** `clyde link --json` liefert `{ chat, linked, known }`.
   - Zuordnung nennen: `linked` (Repo, Remote, Pfad hier und Status) oder „keine".
   - Mit **AskUserQuestion** fragen, womit der Chat verknuepft sein soll.
     Optionen (hoechstens vier): Repos aus `known`, die hier einen Pfad haben
     (`path` nicht leer; Beschreibung: Remote und Pfad), dazu **Zuordnung loesen**,
     wenn `linked` gesetzt ist. Unter „Other" kann der Nutzer einen Pfad eintippen.
     Keine Ordner durchsuchen, keine anderen Repos vorschlagen.
   - Umsetzen: gewaehltes Repo `clyde link "PFAD"` (Pfad aus `known`), eingetippter
     Pfad `clyde link "PFAD"`, Loesen `clyde link --unlink`.

4. **Bericht:** kurz, womit der Chat jetzt verknuepft ist. Hinweis: auf den anderen
   Geraeten bietet `/clyde:pull` das Repo an (klonen / liegt schon hier /
   ueberspringen).
