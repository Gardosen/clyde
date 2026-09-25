---
name: setup
description: Clyde auf diesem PC einrichten und den aktuellen Chat als Clyde-Chat registrieren (Server-URL, Client-Token, Projektlaufwerk). Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
argument-hint: "[server-url] [token] [projektlaufwerk]"
allowed-tools: Bash(clyde:*), Bash(node --version)
---

# Clyde einrichten

Clyde synchronisiert den Zustand der Claude-App-Chats zwischen PCs ueber ein
eigenes Backend. Projekt, Backend und Anleitung: https://github.com/Gardosen/clyde

Dieser Chat wird der **Clyde-Chat**: Er dient nur zum Synchronisieren und wird
selbst nie hochgeladen oder beim Pull veraendert.

Argumente vom Nutzer: `$ARGUMENTS`

## Ablauf

1. **CLI pruefen.** `clyde --help` ausfuehren.
   - Fehlt der Befehl, `node --version` pruefen (Node 20 oder neuer noetig) und dem
     Nutzer die Installation vorschlagen:
     `npm install -g github:Gardosen/clyde#v0.4.0`
     Erst nach seiner Zustimmung ausfuehren, dann `clyde --help` erneut pruefen.

2. **Angaben sammeln.** Gebraucht werden:
   - **Server-URL** des Clyde-Backends, z. B. `https://clyde.example.com`.
   - **Client-Token**. Den erzeugt der Nutzer selbst im Dashboard des Servers
     (Browser, Server-URL oeffnen, anmelden, Reiter "Zugang fuer PCs").
   - **Projektlaufwerk** (optional): Buchstabe des Laufwerks, auf dem auf diesem
     PC die Projekte ausserhalb des Benutzerordners liegen, z. B. `D`.
   Was nicht in den Argumenten steht, beim Nutzer erfragen und dann weitermachen.
   Den Token im Chat nicht wiederholen.

3. **Einrichten.**
   `clyde init --server <URL> --token <TOKEN> --clyde-chat --no-ask`
   plus `--project-drive <X>`, falls angegeben.

4. **Ergebnis melden.** Aus der Ausgabe berichten: ob der Server erreichbar ist,
   zu welchem Benutzer der Token gehoert, und dass dieser Chat jetzt als
   Clyde-Chat registriert ist. Bei einer Warnung (Server nicht erreichbar, Token
   abgelehnt) die Ursache nennen und nicht weiter probieren.

5. **Naechste Schritte nennen:** In diesem Chat `/clyde:push` (Stand dieses PCs
   hochladen) oder `/clyde:pull` (Stand vom Server holen), `/clyde:status` fuer
   den Ueberblick.
