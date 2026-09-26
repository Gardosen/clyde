---
name: refs
description: Verweise ansehen und korrigieren - welches Git-Repo zu welchem Chat gehoert und wo es auf diesem und den anderen Geraeten liegt (Projektordner, Repo, Memory). Aenderungen gehen sofort an den Server. Nur auf ausdruecklichen Aufruf.
disable-model-invocation: true
allowed-tools: Bash(clyde:*), AskUserQuestion
---

# Clyde: Verweise

Clyde merkt sich je Chat, in welchem Git-Repo er arbeitet (aus seinem
Arbeitsordner, ohne Ordner zu durchsuchen), und je Geraet, wo dieses Repo liegt.
Diese Verweise liegen auf dem Server; sie lassen sich hier auf dem Geraet und im
Dashboard (Reiter „Verweise") aendern. Im Dashboard gesetzte Pfade gelten als
„ungeprueft", bis dieses Geraet sie prueft.
Projekt: https://github.com/Gardosen/clyde

## Ablauf

1. **Pruefen und anzeigen:** `clyde refs --check --json`
   (prueft die Verweise dieses Geraets, auch ungepruefte aus dem Dashboard, und
   laedt Korrekturen sofort hoch). Liefert `{ device, problems, repos }`; je Repo
   `name`, `remote`, `chats`, `here` (Pfad und Status hier) und `devices`
   (Pfad und Status auf den anderen Geraeten).

2. **Zeigen:** kurze Tabelle: Repo, Chats, hier (Pfad, Status), andere Geraete.
   Status: ok = geprueft, unverified = aus dem Dashboard, noch ungeprueft,
   missing = Pfad fehlt, not-a-repo, wrong-remote = anderes Repo, skipped =
   uebersprungen.

3. **Probleme** (`problems`) je Repo mit **AskUserQuestion** klaeren, hoechstens
   vier je Aufruf, Repo-Name im `header`:
   1. **Hierher klonen**, Beschreibung: „Nach `suggested` klonen. Anderen
      Zielordner unter ‚Other' als ‚klonen: PFAD' eintippen."
   2. **Liegt schon hier**, Beschreibung: „Den Pfad unter ‚Other' eintippen."
   3. **Ueberspringen**, Beschreibung: „Auf diesem Geraet nicht mehr anbieten."
   Umsetzen: `clyde refs --clone NAME [--to "PFAD"]`, `clyde refs --set NAME "PFAD"`,
   `clyde refs --skip NAME`.

4. **Weitere Wuensche des Nutzers** umsetzen, wenn er sie nennt:
   - Repo liegt hier woanders: `clyde refs --set NAME "PFAD"`
   - Chat, dessen Arbeitsordner kein Git-Repo ist, einem Repo zuordnen:
     `clyde refs --link "CHAT-TITEL" NAME`; Zuordnung loesen: `clyde refs --unlink "CHAT-TITEL"`
   Clyde prueft jeden Pfad (vorhanden, Git-Repo, gleicher Remote) und lehnt
   sonst ab; die Meldung dann weitergeben und nachfragen. Nie selbst klonen oder
   Pfade setzen, die der Nutzer nicht bestaetigt hat.

5. **Bericht:** was geaendert wurde. Hinweis: je Chat und Geraet zeigt
   `clyde status -v` und das Dashboard (Chat anklicken, „Auf den Geraeten"), wo
   der Chat sein Wissen hat: Projektordner, Repo und Memory.
