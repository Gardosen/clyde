# Clyde

Clyde bringt den **exakten Zustand deiner Claude-App-Chats** von einem PC auf den
anderen. Auf PC A wird der Stand eingefroren und hochgeladen, auf PC B genau so
wiederhergestellt: Transkripte, Chatliste der App, Datei-Historie, Todos, Pläne.

Projekt: **https://github.com/Gardosen/clyde**

Clyde besteht aus drei Teilen, die alle in diesem Repository liegen:

| Teil | Wo | Wozu |
|---|---|---|
| **Backend** | `server/`, `deploy/` | Docker-Compose-Dienst, speichert die Snapshots je Benutzer, mit Dashboard und Login |
| **Plugin für die Claude-App** | `plugin/`, `.claude-plugin/` | Das Client-Gegenstück zum Backend im Plugin-Store der App: `/clyde:push` und `/clyde:pull` direkt im Chat |
| **CLI** | `bin/`, `src/` | Der Befehl `clyde`, auf den das Plugin aufsetzt; geht auch ohne App im Terminal |

Reines Node.js ohne Abhängigkeiten, Node 20 oder neuer.

## Schnellstart

1. **Backend starten**, siehe [Backend betreiben](#backend-betreiben).
2. **Im Dashboard anmelden** (Server-Adresse im Browser öffnen) und unter
   „Zugang für PCs" je PC einen Client-Token erzeugen.
3. **Auf jedem PC** das CLI installieren:

   ```bash
   npm install -g github:Gardosen/clyde
   ```

4. **Plugin in der Claude-App installieren:** Im Plugin-Store der App (Plus-Knopf
   neben dem Eingabefeld, dann „Plugins") den Marketplace `Gardosen/clyde`
   hinzufügen und das Plugin **clyde** installieren. Im Terminal geht dasselbe mit:

   ```bash
   claude plugin marketplace add Gardosen/clyde
   ```

   ```bash
   claude plugin install clyde@clyde
   ```

5. **Einen eigenen Chat nur für Clyde anlegen** und darin `/clyde:setup` aufrufen.
   Clyde fragt nach Server-Adresse und Token und registriert diesen Chat als
   Clyde-Chat.
6. **Synchronisieren:** auf PC A im Clyde-Chat `/clyde:push`, auf PC B im
   Clyde-Chat `/clyde:pull`.

## Das Plugin: Clyde in der Claude-App

Das Plugin ist das Client-Gegenstück zum Backend. Es läuft in einem eigenen
**Clyde-Chat**, der nur zum Synchronisieren dient.

| Befehl | Wirkung |
|---|---|
| `/clyde:setup [url] [token] [laufwerk]` | CLI prüfen, Server-Adresse und Token eintragen, Chat als Clyde-Chat registrieren |
| `/clyde:push` | Stand aller anderen Chats dieses PCs hochladen |
| `/clyde:pull [snapshot-id]` | Neuesten oder bestimmten Stand herstellen; fragt nach fehlenden Projektordnern und vor dem Entfernen von Chats |
| `/clyde:status` | Neuester Snapshot, lokale Änderungen, arbeitende Chats |

So verhält es sich:

- **Die App bleibt offen.** Blockiert wird nur, wenn ein anderer Chat gerade
  antwortet. Clyde erkennt das an den Statusdateien, die die App für jeden
  geöffneten Chat führt.
- **Der Clyde-Chat wird nie synchronisiert**, weder hochgeladen noch beim Pull
  verändert. Jeder PC hat seinen eigenen.
- **Nach einem Pull:** Chats, die in der App gerade geöffnet sind, arbeiten mit
  ihrem alten Stand im Speicher weiter. Clyde nennt sie. Bevor du dort
  weiterschreibst, die App einmal neu starten. Neu hinzugekommene Chats erscheinen
  in der Chatliste eventuell erst nach einem Neustart.

Das Plugin ruft den Befehl `clyde` auf, deshalb muss das CLI installiert sein.
`/clyde:setup` prüft das und schlägt die Installation vor. Ist das Repository
privat, braucht die App Git-Zugriff darauf, um den Marketplace hinzuzufügen.

### Im Plugin-Verzeichnis von Anthropic

Damit Clyde ohne vorheriges Hinzufügen des Marketplace unter „Customize →
Plugins → Discover" auftaucht, muss es im Verzeichnis von Anthropic gelistet
sein. Eingereicht wird über das Entwicklerportal unter
https://claude.ai/directory/manage („Submit new", dann „Plugin bundle",
Repository `Gardosen/clyde`, Plugin-Pfad `plugin`). Dafür sind ein bezahlter
claude.ai-Plan und ein mit claude.ai verbundenes GitHub-Konto nötig; Anthropic
prüft jede Version, bevor sie erscheint. Die Beschreibung im Verzeichnis kommt aus
`plugin/.claude-plugin/plugin.json` und `plugin/README.md`.

Bis zur Freigabe bleibt der Weg über den Marketplace `Gardosen/clyde`. Einen Skill
über „Skills → Add → Upload" hochzuladen hilft nicht: Er erscheint nur im eigenen
Arbeitsbereich, und die Clyde-Befehle brauchen Claude Code auf dem eigenen PC.

## Was synchronisiert wird

| Bereich | Pfad (Windows) | Inhalt |
|---|---|---|
| claude-projects | `%USERPROFILE%\.claude\projects` | Transkripte (JSONL), Tool-Ergebnisse, Memory |
| claude-file-history | `%USERPROFILE%\.claude\file-history` | Datei-Historie für Diff und Rewind |
| claude-todos | `%USERPROFILE%\.claude\todos` | Todo-Listen |
| claude-plans | `%USERPROFILE%\.claude\plans` | Plan-Mode-Dateien |
| claude-history | `%USERPROFILE%\.claude\history.jsonl` | Eingabe-Historie |
| desktop-sessions | `%APPDATA%\Claude\claude-code-sessions` | Chatliste der App: Titel, Projektordner, Modell, Archiv-Status |

Bewusst **nicht** dabei: laufende Prozesse (`.claude\sessions`), Login und
Maschinen-ID (`.claude.json`, `.credentials.json`), Caches, Telemetrie.

Gut zu wissen: Die App entfernt beim Löschen eines Chats nur den Eintrag aus der
Chatliste, das Transkript bleibt auf der Platte. Auch ältere oder im Terminal
geführte Sitzungen haben keinen Eintrag in der Chatliste. Clyde überträgt diese
Transkripte mit, weil sie zum exakten Stand gehören. Das Dashboard zeigt sie
getrennt an.

Ein Verzeichnis-Link wie `projects\...\memory -> D:\ClaudeMemory\...` wird
verfolgt: Der Inhalt wandert mit, und auf dem Ziel-PC wird der Link neu angelegt.
Fehlt das Ziel dort, legt Clyde es an, sofern das Laufwerk existiert.

## Verschiedene Benutzerkonten, Laufwerke und Projektpfade

Claude bildet den Schlüssel eines Projekts aus dem vollen Pfad
(`C:\Users\warro\Nextcloud\Aegis` wird zu `C--Users-warro-Nextcloud-Aegis`) und
schreibt den Pfad in jede Transkript-Zeile und in die Chatliste. Damit das auf
einem PC mit anderem Konto oder anderem Laufwerk funktioniert, ersetzt jeder
Client beim Hochladen seine eigenen Werte durch Platzhalter und setzt beim Pull
seine eigenen wieder ein:

- **Home-Verzeichnis:** automatisch das des angemeldeten Windows-Kontos.
- **Projektlaufwerk:** das Laufwerk der Projekte außerhalb des Home, z. B. `D`
  (`clyde init --project-drive D`). `D:\Aegis` auf PC A wird so zu `C:\Aegis`
  auf PC B.
- **Projekt-Zuordnung:** Liegt ein Projekt auf PC B ganz woanders, fragt der Pull
  nach dem Pfad und merkt sich die Antwort (`clyde map --list`).

Ersetzt werden alle Schreibweisen (`C:\Users\warro`, `C:\\Users\\warro`,
`C:/Users/warro`, `/c/Users/warro`, `C--Users-warro`), nur in Textdateien und nie
in der Datei-Historie. Der Server sieht nur die neutrale Form; deshalb sind die
Daten auf allen PCs gleich, und ein Push direkt nach einem Pull lädt nichts hoch.

## Backend betreiben

Das Backend ist ein Docker-Compose-Dienst. `deploy/` enthält die Variante für
einen Server hinter **Traefik**; `docker-compose.yml` im Projektstamm ist für
lokale Tests oder das LAN ohne Reverse-Proxy.

### Hinter Traefik

```bash
cp deploy/.env.example deploy/.env
```

In `deploy/.env` eintragen:

| Variable | Bedeutung |
|---|---|
| `CLYDE_DOMAIN` | Domain des Dienstes, DNS muss auf den Server zeigen |
| `CLYDE_ADMIN_USER` | Name des ersten Admins, Standard `admin` |
| `CLYDE_ADMIN_PASSWORD` | Sein Passwort; leer lassen, dann erzeugt der Server eins und schreibt es einmalig ins Log |
| `PROXY_NETWORK`, `TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER` | So, wie sie in deiner Traefik-Konfiguration heißen |
| `CLYDE_TOKEN` | Nur für ältere Installationen: alter gemeinsamer Token, gilt als Token des Admins |

Dann auf dem Server:

```bash
cd deploy && docker compose up -d --build
```

```bash
docker compose logs clyde
```

Das zweite Kommando zeigt beim ersten Start das erzeugte Admin-Passwort.
`deploy/deploy.sh user@host -p PORT` kopiert das Projekt per SSH nach `/opt/clyde`
und startet es dort.

Antwortet die Domain mit „Gateway Timeout", erreicht Traefik den Container
nicht. Meist hängt Clyde nicht im selben Docker-Netz wie Traefik; der Name aus
`PROXY_NETWORK` muss exakt stimmen.

Traefik bricht Anfragen standardmäßig nach 60 Sekunden Lesezeit ab. Clyde schickt
deshalb höchstens 16 MiB je Anfrage (`uploadBatchMiB` in `~/.clyde/config.json`).

### Dashboard und Benutzer

Das Dashboard liegt unter der Server-Adresse und ist durch einen Login geschützt.

- **Chats:** je Snapshot die Chats aus der Chatliste mit Titel, Projektordner,
  Modell, letzter Aktivität und Transkript-Größe. Auf Wunsch auch die Transkripte
  ohne Eintrag in der App.
- **Zugang für PCs:** eigene Client-Tokens erzeugen und widerrufen. Der Token wird
  nur einmal angezeigt, zusammen mit dem fertigen `clyde init`-Befehl.
- **Stände:** alle gespeicherten Snapshots mit Datum, Quell-PC und Größe, dazu der
  tatsächlich belegte Platz auf dem Server. Einzelne oder ausgewählte Stände
  löschen, oder nur die neuesten N behalten. Danach räumt der Server Chunks auf,
  die kein Stand mehr braucht, und nennt den freigegebenen Platz. Chunks, die
  jünger als eine Stunde sind, bleiben dabei stehen, damit ein gerade laufender
  Push nichts verliert; sie verschwinden beim nächsten Aufräumen.
- **Konto:** Passwort ändern; andere angemeldete Browser werden dabei abgemeldet.
- **Benutzer** (nur Admins): Benutzer anlegen, Passwort setzen, löschen. Admins
  können die Snapshots anderer Benutzer ansehen und löschen, aber nichts in
  fremde Ablagen hochladen.

Jeder Benutzer hat eigene Snapshots und eigene Tokens und sieht nur seine Daten.
Für den Notfall gibt es die Verwaltung auch auf der Kommandozeile:

```bash
docker compose exec clyde node server/admin.js passwd admin
```

Weitere Befehle: `list`, `add NAME [--admin]`, `token NAME [BEZEICHNUNG]`,
`admin NAME [off]`, `del NAME`.

## Einrichten ohne Plugin

Das CLI funktioniert auch allein im Terminal. Dann muss die Claude-App beim
Synchronisieren geschlossen sein.

```bash
clyde init --server https://clyde.example.com --token DEIN-TOKEN --project-drive D
```

Server-Adresse und Token sind bei der Ersteinrichtung Pflicht. Fehlen sie, fragt
`clyde init` im Terminal danach. `clyde doctor` zeigt danach Pfade, Platzhalter,
laufende Chats und ob Server und Token passen.

| Befehl | Zweck |
|---|---|
| `clyde init --server URL --token TOKEN` | Ersteinrichtung |
| `clyde push` | Stand hochladen |
| `clyde pull [ID]` | Neuesten oder bestimmten Stand herstellen, `--dry-run` zeigt nur den Plan |
| `clyde status` | Änderungen seit dem letzten Sync, arbeitende Chats |
| `clyde list` | Snapshots auf dem Server |
| `clyde map --list` / `--add` / `--remove N` | Projekt-Zuordnungen |
| `clyde doctor` | Einrichtung prüfen |
| `clyde delete ID`, `clyde gc` | Snapshot löschen, Speicher freigeben |

Vor jedem Pull legt Clyde eine Kopie des bisherigen Stands unter
`%USERPROFILE%\.clyde\backups\<Zeitstempel>` an; die letzten drei bleiben.

## Chats einem anderen Projektordner zuordnen

Claude merkt sich zu jedem Chat den Ordner, in dem er gestartet wurde. Wer viele
Projekte aus demselben Ordner begonnen hat, kann sie nachträglich dem richtigen
Ordner zuordnen. Die Projektdateien bleiben, wo sie sind; umgestellt werden nur
der Eintrag in der Chatliste (Projektordner und Ordner-Freigabe) und der
Ablageort des Transkripts unter `.claude\projects`. Hatte der alte Ordner ein
Memory, bekommt der neue eine Verknüpfung darauf, sodass das Wissen bleibt.

Weil die App diese Einträge im Speicher hält, geht das nur bei geschlossener App
aus einem Terminal. Der Trockenlauf geht jederzeit.

```bash
clyde relocate --chat "Lunia" --to "D:\Lunia" --dry-run
```

Für mehrere Chats auf einmal ein Plan als JSON:

```json
{ "chats": [ { "chat": "3. Lunia Archivar Projekt", "to": "D:\\Lunia" },
             { "chat": "local_f4586c16-...", "to": "D:\\Lineage 2" } ] }
```

```bash
clyde relocate --plan plan.json
```

Ein Chat wird über einen Teil seines Titels oder seine ID gefunden. Vor dem
Umzug sichert Clyde die Einträge; `clyde relocate --undo <Sicherungsordner>`
macht alles rückgängig. Den Sicherungsordner nennt die Ausgabe.

## Dashboard: Gruppen und Projektordner

Die Chatliste im Dashboard steht so geordnet wie in der App: Chats mit einer
Gruppe der Seitenleiste in dieser Gruppe, alle anderen nach Projektordner. Titel,
Projektordner und Modell von Transkripten ohne Eintrag in der App liest das
Dashboard aus dem Anfang des Transkripts.

## Wie es funktioniert

- **Scan:** Jede Datei wird in die neutrale Form gebracht und in 4-MiB-Stücke
  zerlegt, jedes Stück per SHA-256 benannt. Ein Cache vermeidet das Neu-Hashen
  unveränderter Dateien.
- **Push:** Der Server nennt die Stücke, die ihm fehlen; nur diese gehen
  komprimiert hoch. Ein 100-MB-Chat, an den seit dem letzten Push nur angehängt
  wurde, kostet ein einziges Stück. Danach wird das Manifest als Snapshot
  gespeichert, aber nur, wenn alle Stücke vorliegen.
- **Pull:** Plan = Snapshot minus lokaler Stand. Stücke, die lokal schon
  vorliegen, werden wiederverwendet, der Rest geladen. Dateien werden erst
  vollständig geschrieben und dann atomar umbenannt; überzählige Dateien und leere
  Ordner werden entfernt.

## Sicherheit

- Dashboard-Login mit scrypt-gehashten Passwörtern, signierten Sitzungs-Cookies
  (HttpOnly, SameSite=Strict, hinter HTTPS mit Secure) und einer Sperre nach zu
  vielen Fehlversuchen.
- Client-Tokens liegen auf dem Server nur als Hash und lassen sich einzeln
  widerrufen. Ein Client-Token kann keine weiteren Tokens erzeugen und keine
  Benutzer verwalten.
- TLS übernimmt Traefik. Ohne HTTPS warnt `clyde init`, weil der Token sonst im
  Klartext übertragen wird.
- Die Chats enthalten alles, was in ihnen steht, auch Pfade, Code und
  Tool-Ausgaben. Wer Admin ist, kann sie lesen.

## Grenzen

- **Kein Zusammenführen:** Clyde stellt genau einen Snapshot her. Wer auf zwei PCs
  parallel arbeitet und dann zieht, verliert den lokalen Stand; das Backup bleibt.
- **Chatliste bei laufender App:** Ob die App neue oder geänderte Einträge ohne
  Neustart übernimmt, ist nicht verifiziert. Nach einem Pull im Zweifel die App
  einmal neu starten.
- **Gruppen der Chatliste** (z. B. „Archivar Project") stehen in der
  Einstellungsdatei der App. Clyde liest beim Push nur Gruppennamen und
  Zuordnungen daraus und zeigt sie im Dashboard. Auf dem Ziel-PC werden sie nicht
  in die App geschrieben, weil die Datei auch alle anderen App-Einstellungen enthält.
- Snapshots im alten Format v1 lehnt der Client ab; auf dem Quell-PC einmal neu
  pushen.

## Entwicklung

```bash
npm test
```

Die Tests starten den Server im Prozess und spielen durch: Push und Delta-Push,
exakten Pull mit Löschen und Verkürzen, Trockenlauf, Backups, zwei PCs mit
verschiedenen Konten und Laufwerken, Projekt-Zuordnung, den Clyde-Chat-Modus bei
offener App, Login, Benutzertrennung, Token-Widerruf und die Dashboard-API.

Plugin und Marketplace lassen sich prüfen mit:

```bash
claude plugin validate ./plugin
```

## Lizenz

MIT, siehe [LICENSE](LICENSE).
