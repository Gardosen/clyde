# Clyde

Clyde keeps **the Claude desktop app's chats the same on all your computers**.
Every Clyde account has its own collection that all computers of that account
contribute to: transcripts, the app's chat list, file history, todos and plans.
Each computer fetches whatever it is missing. Accounts never see each other; if
several people use one Clyde server, each of them gets their own account.

- **Push** adds new, continued and deleted chats of this computer to the
  collection. Chats from other computers stay where they are.
- **Pull** fetches new and changed chats from the other computers. This
  computer's own chats are kept; a chat is only removed if it was deleted on
  another computer.
- **First setup:** if a computer already has chats, they are added to the
  collection on its first push and kept on its first pull.
- **Conflicts:** if the same chat was continued on two computers, the lines from
  both sides are kept. For other files the newer version wins.

Project: **https://github.com/Gardosen/clyde**

Clyde has three parts, all in this repository:

| Part | Where | Purpose |
|---|---|---|
| **Backend** | `server/`, `deploy/` | Docker Compose service that stores snapshots per user, with a dashboard and login |
| **Plugin for the Claude app** | `plugin/`, `.claude-plugin/` | The client counterpart to the backend in the app's plugin store: `/clyde:push` and `/clyde:pull` right in a chat |
| **CLI** | `bin/`, `src/` | The `clyde` command the plugin builds on; also works in a terminal without the app |

Plain Node.js without dependencies, Node 20 or newer.

## Quick start

1. **Start the backend**, see [Running the backend](#running-the-backend).
2. **Sign in to the dashboard** (open the server address in a browser) and create
   one client token per computer under *Zugang für PCs* (access for computers).
3. **On every computer**, install the CLI:

   ```bash
   npm install -g github:Gardosen/clyde
   ```

4. **Install the plugin in the Claude app:** in the app's plugin store
   (*Customize → Plugins*, or the plus button next to the input field) add the
   marketplace `Gardosen/clyde` and install the plugin **clyde**. The same from a
   terminal:

   ```bash
   claude plugin marketplace add Gardosen/clyde
   ```

   ```bash
   claude plugin install clyde@clyde
   ```

5. **Create a chat just for Clyde** and run `/clyde:setup` in it. Clyde asks for
   the server address and token and registers this chat as the Clyde chat.
6. **Sync:** before switching computers, run `/clyde:push` in the Clyde chat on
   the one you leave and `/clyde:pull` on the one you move to. If a project folder
   is missing there, Clyde asks: enter a path, create the folder, or skip for now.

## The plugin: Clyde inside the Claude app

The plugin is the client counterpart to the backend. It runs in a dedicated
**Clyde chat** that is only used for syncing.

| Command | What it does |
|---|---|
| `/clyde:setup [url] [token] [drive]` | Checks the CLI, stores server address and token, registers the chat as the Clyde chat |
| `/clyde:push` | First asks about anything forgotten (uncommitted or unpushed Git work) and about references of this device that are wrong, uploads the corrections, then adds this computer's changes to the account's collection |
| `/clyde:pull` | Fetches new and changed chats from the other computers; offers the repositories they need (clone, already here, skip) and asks about missing project folders |
| `/clyde:status` | Latest snapshot, what is waiting to be pushed or pulled, busy chats |
| `/clyde:delete [id ...]` | Lists the stored snapshots with the space each would free, deletes the chosen ones after confirmation and cleans up |
| `/clyde:refs` | Show and correct which repository belongs to which chat and where it lives on each device |
| `/clyde:update` | Updates the Clyde plugin in the app and the Clyde CLI to the latest release, after asking |
| `/clyde:groups` | Apply the chat list groups (including renamed ones), pinned chats and chat titles of the other computers in the app, without a restart (also done at the end of `/clyde:pull`) |

How it behaves:

- **The app stays open.** Syncing only waits while another chat is in the middle
  of an answer. Clyde reads this from the status files the app keeps for every
  open chat.
- **The Clyde chat itself is never synced**, neither uploaded nor changed by a
  pull. Every computer has its own.
- **After a pull:** chats that are open in the app keep working with their old
  state in memory. Clyde names them; restart the app before you continue writing
  in them. Newly added chats may only show up in the chat list after a restart.

The plugin calls the `clyde` command, so the CLI must be installed. `/clyde:setup`
checks for it and offers to install it. If the repository is private, the app
needs git access to it to add the marketplace.

### In Anthropic's plugin directory

To make Clyde show up under *Customize → Plugins → Discover* without adding the
marketplace first, it has to be listed in Anthropic's directory. Plugins are
submitted through the developer portal at https://claude.ai/directory/manage
(*Submit new*, then *Plugin bundle*, repository `Gardosen/clyde`, plugin path
`plugin`). This needs a paid claude.ai plan and a GitHub account connected to
claude.ai; Anthropic reviews every version before it appears. The listing text
comes from `plugin/.claude-plugin/plugin.json` and `plugin/README.md`.

Until then, use the marketplace `Gardosen/clyde`. Uploading a skill under
*Skills → Add → Upload* does not help: it only appears in your own workspace, and
the Clyde commands need Claude Code on your own computer.

## What gets synced

| Area | Path (Windows) | Contents |
|---|---|---|
| claude-projects | `%USERPROFILE%\.claude\projects` | Transcripts (JSONL), tool results, memory |
| claude-file-history | `%USERPROFILE%\.claude\file-history` | File history for diff and rewind |
| claude-todos | `%USERPROFILE%\.claude\todos` | Todo lists |
| claude-plans | `%USERPROFILE%\.claude\plans` | Plan mode files |
| claude-history | `%USERPROFILE%\.claude\history.jsonl` | Prompt history |
| desktop-sessions | `%APPDATA%\Claude\claude-code-sessions` | The app's chat list: title, project folder, model, archive state |

On macOS the first five live under `~/.claude`, the chat list under
`~/Library/Application Support/Claude/claude-code-sessions`. The Claude app from
the Microsoft Store keeps its data in its package folder
(`%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude`); Clyde finds it
there, also when run from a normal terminal.

Deliberately **not** synced: running processes (`.claude\sessions`), login and
machine ID (`.claude.json`, `.credentials.json`), caches, telemetry.

Good to know: when you delete a chat, the app only removes it from the chat list;
the transcript stays on disk. Older sessions and sessions run in a terminal have
no chat list entry either. Clyde syncs these transcripts too, because they are
part of the state. The dashboard shows them separately.

A directory link such as `projects\...\memory -> D:\ClaudeMemory\...` is followed:
its contents are synced, and the link is recreated on the target computer. If the
target folder is missing there, Clyde creates it as long as the drive exists.

## Different user accounts, drives and project paths

Claude derives a project's key from its full path
(`C:\Users\alice\Projects\Game` becomes `C--Users-alice-Projects-Game`) and writes
the path into every transcript line and into the chat list. To make this work on
a computer with a different user account or drive, each client replaces its own
values with placeholders when uploading and puts its own values back when
pulling:

- **Home folder:** automatically the one of the signed-in user.
- **Project drive:** the drive that holds your projects outside the home folder,
  for example `D` (`clyde init --project-drive D`). `D:\Game` on computer A then
  becomes `C:\Game` on computer B.
- **Project mapping:** if a project lives somewhere else entirely on computer B,
  pull asks for its path and remembers the answer (`clyde map --list`).

All spellings are replaced (`C:\Users\alice`, `C:\\Users\\alice`,
`C:/Users/alice`, `/c/Users/alice`, `C--Users-alice`), only in text files and never
in the file history. The server only sees the neutral form, so the data is the
same on every computer, and a push right after a pull uploads nothing. Text that
merely looks like a placeholder (for example a chat about Clyde itself) is
escaped and comes back unchanged. A transcript line that would stop being valid
JSON after the paths are put back is left as it is instead.

A project mapping means "folder X on the other computers is folder Y here" for
all synced text. Setting or removing one only moves the chats whose project folder
it is: their transcripts, chat list entries, todos and their lines in the prompt
history. Other files that merely mention the old path stay byte for byte as they
are. Check first, then confirm:

```bash
clyde map --add "C:\Aegis" "D:\Aegis" --dry-run
clyde map --add "C:\Aegis" "D:\Aegis" --yes
```

The dry run lists the affected chats, how many files and lines change, and warns
if Y is already the project folder of other chats here or already mentioned in
the affected files. After the change, both meanings are the same project on every
computer. Without `--yes` Clyde asks in the terminal. From the plugin it changes
nothing without `--yes`. If a chat of that project is busy, nothing happens. The
originals are kept in `~/.clyde/backups/map-<time>`.

## Running the backend

The backend is a Docker Compose service. `deploy/` contains the setup for a
server behind **Traefik**; `docker-compose.yml` in the project root is for local
tests or a LAN without a reverse proxy.

### Behind Traefik

```bash
cp deploy/.env.example deploy/.env
```

Set in `deploy/.env`:

| Variable | Meaning |
|---|---|
| `CLYDE_DOMAIN` | Domain of the service; DNS must point to the server |
| `CLYDE_ADMIN_USER` | Name of the first admin, default `admin` |
| `CLYDE_ADMIN_PASSWORD` | Their password; leave it empty and the server generates one and writes it to the log once |
| `PROXY_NETWORK`, `TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER` | As they are named in your Traefik configuration |
| `CLYDE_TOKEN` | Only for older installations: the old shared token, treated as the admin's token |

Then on the server:

```bash
cd deploy && docker compose up -d --build
```

```bash
docker compose logs clyde
```

On first start the second command shows the generated admin password. Always
start with `--build` after an update, otherwise Docker keeps running the old
image. `deploy/deploy.sh user@host -p PORT` copies the project to `/opt/clyde` via
SSH and starts it there. `https://your-domain/health` reports the running version.

If the domain answers with *Gateway Timeout*, Traefik cannot reach the container.
Usually Clyde is not in the same Docker network as Traefik; the name in
`PROXY_NETWORK` has to match exactly.

Traefik aborts requests after 60 seconds of reading by default. Clyde therefore
sends at most 16 MiB per request (`uploadBatchMiB` in `~/.clyde/config.json`).

### Dashboard and users

The dashboard lives at the server address and is protected by a login. Its
interface is currently in German; the tab names are given in brackets.

- **Chats** (*Chats*): per snapshot the chats of the chat list with title,
  project folder, model, last activity and transcript size, grouped like the
  app's sidebar groups and otherwise by project folder. Optionally also the
  transcripts without a chat list entry.
- **Access for computers** (*Zugang für PCs*): create and revoke your own client
  tokens. A token is shown only once, together with the ready-made `clyde init`
  command.
- **Snapshots** (*Stände*): all stored snapshots with date, source computer,
  size and the space deleting each would free at least (chunks only it uses),
  plus the space actually used on the server. Delete single or selected
  snapshots, or keep only the newest N, each after confirmation. The server then
  removes chunks no snapshot needs any more and reports the space freed. Chunks
  younger than one hour are kept so that a push in progress loses nothing; they
  go at the next cleanup. Should a cleanup still remove chunks a push is about to
  reference, that push uploads them again and retries.

  Deleting older snapshots is safe. Each computer keeps its sync base locally;
  if the snapshot it last synced with is gone, its next sync only combines: it
  deletes nothing locally, and deletions made on other computers do not reach it
  that one time. The newest snapshot is the account's shared state. The server
  deletes it only when asked explicitly (`force`), and the dashboard asks twice.
  Afterwards the next older snapshot applies, and every computer that already had
  the deleted one uploads its chats again on its next push.
- **Account** (*Konto*): change your password; other signed-in browsers are
  signed out.
- **Users** (*Benutzer*, admins only): create users, set passwords, delete users.
  Admins can view and delete other users' snapshots but cannot upload into them.

Every user has their own snapshots and tokens and only sees their own data. For
emergencies the user management is also available on the command line:

```bash
docker compose exec clyde node server/admin.js passwd admin
```

More commands: `list`, `add NAME [--admin]`, `token NAME [LABEL]`,
`admin NAME [off]`, `del NAME`.

## Using the CLI without the plugin

The CLI also works on its own in a terminal. The Claude app must then be closed
while syncing.

```bash
clyde init --server https://clyde.example.com --token YOUR-TOKEN --project-drive D
```

Server address and token are required on first setup; if they are missing,
`clyde init` asks for them in the terminal. `clyde doctor` then shows paths,
placeholders, running chats and whether server and token work.

| Command | Purpose |
|---|---|
| `clyde init --server URL --token TOKEN` | First setup |
| `clyde push` | Add this computer's changes to the collection |
| `clyde pull` | Fetch other computers' changes; `--dry-run` only shows the plan |
| `clyde pull --create-missing DIR` | Also create missing project folders under DIR (for example on a Mac) |
| `clyde pull ID --exact` | Restore a stored snapshot exactly; local differences are removed |
| `clyde merge ID ID [...]` | Merge stored snapshots into a new shared state |
| `clyde status` | Versions of the Clyde CLI, the plugin and the server, what is waiting to be pushed or pulled, busy chats |
| `clyde update [--check] [--yes]` | Update the plugin in the app (through Claude's plugin commands) and the CLI (npm) to the latest release on GitHub |
| `clyde list` | Snapshots on the server, with the space deleting each would free |
| `clyde map --list` | Show project mappings |
| `clyde map --add NEUTRAL PATH [--create]` | Add a mapping; check with `--dry-run`, confirm with `--yes` |
| `clyde map --remove N` | Remove a mapping and move its chats back; `--dry-run` / `--yes` as above |
| `clyde doctor` | Check the setup |
| `clyde delete ID [ID ...]` | Delete snapshots and clean up; `--dry-run` shows the effect, `--yes` confirms without a terminal, the newest only with `--force` |
| `clyde gc` | Free space of chunks no snapshot needs |
| `clyde refs [--check \| --pending \| --set \| --clone \| --skip \| --link]` | References: repositories of the chats and where they live on each device (see below) |
| `clyde repos --commit PATH [-m TEXT]` / `--push PATH` | Commit and push, or only push, forgotten Git work |
| `--no-repos` (push, pull) | Leave repositories and references out this time |
| `--rehash` (push, pull, status) | Ignore the hash cache and hash everything again |

Before every pull Clyde copies the previous state to
`%USERPROFILE%\.clyde\backups\<timestamp>`; the last three are kept. Backups
with a name (`map-…`, `relocate-…`) are never removed automatically.

## Git repositories of your chats

Clyde syncs chats, not project files. It does, however, remember which Git
repository each chat works in, and where that repository lives on each of your
computers. Clyde never searches folders for repositories. It only looks at
each chat's working folder: if that folder is inside a Git repository with a
remote, the chat belongs to that repository.

These **references** are stored on the server as a separate document per
account, with a revision number (`refs.json`). They are not part of any
snapshot. For every repository they hold the remote (without credentials), the
branch, the chats that belong to it and, for each device, the local path and
its status: `ok`, `unverified` (set in the dashboard), `missing`, `not-a-repo`,
`wrong-remote` or `skipped`. For each device they also hold the home folder,
drive, mappings and memory links. Each device gets a fixed ID in
`~/.clyde/config.json`.

- **Push** records the repositories of this computer's chats and checks every
  reference of this device, including paths edited in the dashboard. It uploads
  corrections at once, before the snapshot is stored, so a correction is kept
  even if the push fails afterwards. `/clyde:push` asks about anything that is
  wrong: clone it here, it is already somewhere here (type the path), or skip it.
- **Pull** offers every repository that the chats need and that this device does
  not have yet. The question is the same: clone from the remote (suggested:
  the same place as on the other computer), it is already here (path), or skip.
  Clyde asks only once per device. It also points the chats of that repository
  to the local path. Repositories that are here and clean are fast-forwarded
  (`git fetch` + `git merge --ff-only`). Local changes and own commits are never
  touched.
- **Dashboard** (*Verweise* tab): a table of repositories × devices with
  editable paths, and a list of chats with a repository selector for chats whose
  folder is not a repository. A path you change there counts as *unverified*
  until the device confirms or rejects it on its next push. Concurrent changes
  are refused with a conflict instead of being overwritten.
- **Where does a chat keep its knowledge?** In the dashboard (click a chat,
  *Auf den Geräten*) and in `clyde status -v`: per device the project folder, the
  repository with path and status, and the memory folder with its link target.

```bash
clyde refs                           # references of all repositories
clyde refs --check                   # check this device, upload corrections
clyde refs --pending                 # also the chats of the shared state (before a pull)
clyde refs --clone proj [--to PATH]  # clone here and record the path
clyde refs --set proj "D:\Code\proj" # it is already here (checked: same remote)
clyde refs --skip proj               # do not offer it on this device
clyde refs --link "My notes" proj    # chat whose folder is not a repository
```

**Before every push, `/clyde:push` also checks for forgotten work** in the
repositories of your chats: uncommitted changes, new files, unpushed commits or a
branch without upstream. It asks what to do: commit and push (you may type your
own message), only push, skip, or cancel. Nothing is committed without your
choice. A repository in which another chat is working at that moment is never
committed. If the remote already has newer commits, Clyde stops for that
repository instead of merging. The same check in the terminal is
`clyde push --check`; catch up with `clyde repos --commit PATH [-m TEXT]` or
`clyde repos --push PATH`.

Cloning uses this computer's Git access (SSH key or Git credential manager);
Clyde never asks for passwords. Only common remote addresses are cloned (https,
ssh, git, `user@host:path`, absolute paths). Turn all of this off with
`--no-repos`, or permanently with `"repos": false` in `~/.clyde/config.json`.
References need server 0.6.0 or newer.

## Moving chats to a different project folder

Claude remembers for every chat the folder it was started in. If you started many
projects from the same folder, you can assign them to the right folder
afterwards. Your project files stay where they are; only the chat list entry
(project folder and folder permission) and the transcript's location under
`.claude\projects` change. If the old folder had a memory, the new one gets a
link to it, so the knowledge is kept.

Because the app keeps these entries in memory, this only works with the app
closed, from a terminal. The dry run works at any time.

```bash
clyde relocate --chat "My Game" --to "D:\Games\MyGame" --dry-run
```

For several chats at once, use a plan in JSON:

```json
{ "chats": [ { "chat": "My Game", "to": "D:\\Games\\MyGame" },
             { "chat": "local_f4586c16-...", "to": "D:\\Tools" } ] }
```

```bash
clyde relocate --plan plan.json
```

A chat is found by part of its title or by its ID. Clyde backs up the entries
before moving; `clyde relocate --undo <backup folder>` reverts everything. The
output names the backup folder.

## How it works

- **Scan:** every file is converted to the neutral form and split into 4 MiB
  chunks, each named by its SHA-256. A cache avoids re-hashing unchanged files;
  it recognises a file by size, modification time and change time (ctime), so
  a file rewritten with the same size and a restored modification time is still
  hashed again. If a push finds a file different from its cached hash, it drops
  that entry and hashes the file again before retrying. A pull never overwrites
  or deletes a file that changed after the scan.
- **Reconcile:** every file is compared three ways: the local state, the
  account's shared state (the latest snapshot) and the state this computer last
  synced (the base, `~/.clyde/base-*.json`). If only one side changed, that side
  wins, deletions included. If both changed, `.jsonl` transcripts and `MEMORY.md`
  are merged line by line. Chat list entries are merged field by field against
  the base, so a rename on one computer and simply opening the chat on another
  both survive. Otherwise the newer version wins. Without a base (first sync)
  the states are combined.
- **Push:** the server lists the chunks it is missing; only those are uploaded,
  compressed. A 100 MB chat that was only appended to since the last push costs a
  single chunk. The merged state is then stored as a new snapshot. If another
  computer uploaded in the meantime, the server refuses and the client merges
  again.
- **Pull:** chunks already present locally are reused, the rest is downloaded.
  Files are written completely first and then renamed atomically.
- **Mappings:** when a project mapping is added or removed, Clyde moves the chats
  of that project right away so that the next sync does not see them as deleted
  and new. Files that cannot be converted to the neutral form and back without
  loss are never rewritten "just in case" by a pull; Clyde reports how many there
  are.

## Security

- Dashboard login with scrypt-hashed passwords, signed session cookies (HttpOnly,
  SameSite=Strict, Secure behind HTTPS) and a lockout after too many failed
  attempts.
- Client tokens are stored on the server only as hashes and can be revoked
  individually. A client token cannot create further tokens or manage users.
- TLS is handled by Traefik. Without HTTPS `clyde init` warns you, because the
  token would otherwise be sent in plain text.
- Chats contain everything written in them, including paths, code and tool
  output. Admins can read them.

## Limitations

- **Versions:** `clyde status`, `clyde doctor`, push and pull compare the
  versions of the Clyde CLI, the Clyde plugin in the app and the server, and say
  which side is outdated. `clyde update` (or `/clyde:update`) brings the plugin
  and the CLI to the latest release. It asks github.com for the latest tag, runs
  `claude plugin update clyde@clyde` and `npm install -g github:Gardosen/clyde#vX`,
  and never overwrites a development install (`npm link` to a Git checkout). If
  the marketplace asks to confirm a command, Clyde does not confirm it and points
  you to the app. New plugin commands show up in new chats. The server is
  updated on the server. If the server requires a newer client, push and pull
  stop until this computer is updated.
- **Other operating systems:** paths inside old tool output keep the source
  computer's spelling (for example `\` instead of `/` on a Mac). Project folders
  and the chat list are converted correctly through the mappings.
- **Chat list while the app is running:** whether the app picks up new or changed
  entries without a restart is not verified. When in doubt, restart the app after
  a pull.
- **Chat list groups** (sidebar groups) are stored in the app's settings file.
  On push Clyde reads only group names and assignments from it and shows them in
  the dashboard. Clyde never writes that file, because it also holds all other
  app settings. Instead, `/clyde:pull` (or `/clyde:groups` on its own) applies the
  groups with the app's own sidebar tools, live and without a restart. Missing
  groups are created by name, and only chats that are still ungrouped are filed.
  Chats you grouped differently on a computer stay where they are. Pinned chats
  are pinned the same way. The app stores the pin in each chat's entry
  (`isStarred`). A pin removed on another computer is also removed here, but only
  when the last pull brought that change. Until then the running app would
  overwrite it with its old state.
  **Renames:** a chat's title lives in its entry and travels with it. The pull
  step sets the new title in the running app, so the app does not write the old
  one back. Groups get a different ID on every computer. Clyde therefore keeps
  a mapping for each computer: this group ↔ the group in the shared state, plus
  both names at the last sync (`~/.clyde/groups-*.json`). A renamed group is
  pushed, even when nothing else changed, and renamed on the other computers
  instead of being created again. If two computers rename the same group at the
  same time, the rename pushed first wins and the others follow it.
  `clyde groups` shows all of this in the terminal. Groups with the same name
  are treated as one group across computers. Deleting a group is not synced.
- Snapshots in the old v1 format are rejected by the client; push again from the
  source computer.
- **Format v3 (0.4.2):** snapshots now escape literal placeholders. The server
  must be 0.4.2 or newer to store them, and clients older than 0.4.2 refuse them
  instead of misreading them. Update the server first, then every computer.
- A computer without a project drive (a Mac) keeps drive placeholders from other
  computers as they are; this includes escaped ones in chats about Clyde.

## Development

```bash
npm test
```

The tests start the server in-process and cover: push and delta push, exact pull
with deletion and truncation, dry runs, backups, two computers with different
accounts and drives, project mappings, merging across several computers and
separate Clyde accounts, the Clyde chat mode with the app open, login, user
separation, token revocation, snapshot deletion and the dashboard API.

Check plugin and marketplace with:

```bash
claude plugin validate ./plugin
```

## License

MIT, see [LICENSE](LICENSE).
