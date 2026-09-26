# Clyde – sync your Claude chats between computers

Clyde keeps the chats of the Claude desktop app in sync across your computers.
Each Clyde account has its own collection; every computer of that account adds
its chats with `/clyde:push` and fetches the others' with `/clyde:pull`. Chats
that already exist on a computer are kept and added to the collection on its
first push. Accounts never see each other's chats. Computers may use different
user accounts, drive letters or operating systems; Clyde rewrites the paths and
asks where a project folder lives when it is missing.

Project, backend and full documentation: https://github.com/Gardosen/clyde

## What it is for

- You work with Claude Code on more than one computer and want the same chats on both.
- You want to continue a conversation on a laptop that you started on a desktop.
- You want a server-side copy of your chats, browsable in a small web dashboard.

## What you need

1. **A Clyde backend.** Clyde does not use a public service. You run the backend
   yourself with Docker Compose (instructions in the project repository) and log
   in to its dashboard to create one access token per computer.
2. **Node.js 20 or newer** on each computer.
3. **The Clyde command-line tool** on each computer. `/clyde:setup` checks for it
   and offers to install the pinned release from GitHub:
   `npm install -g github:Gardosen/clyde#v0.6.0`
4. **Claude Code** – the desktop app's Code tab or the terminal. The commands run
   local programs and do not work in claude.ai chat or Cowork.

## Commands

| Command | What it does |
|---|---|
| `/clyde:setup [url] [token] [drive]` | Connects this computer to your backend and registers the current chat as the Clyde chat |
| `/clyde:push` | Asks about forgotten work first (uncommitted or unpushed Git changes, new repositories), then adds this computer's new, continued and deleted chats to the account's collection |
| `/clyde:pull` | Fetches chats from the account's other computers and keeps this computer's own chats |
| `/clyde:status` | Shows the latest snapshot, local changes and chats that are busy |
| `/clyde:delete [id ...]` | Deletes stored snapshots on the backend after confirmation and frees the space |
| `/clyde:refs` | Shows and corrects which Git repository belongs to which chat and where it lives on each device |
| `/clyde:update` | Updates this plugin and the Clyde CLI to the latest release, after asking |
| `/clyde:groups` | Files chats into the same sidebar groups, pins the same chats and applies renamed groups and chat titles from your other computers, using the app's sidebar tools (no restart; also part of `/clyde:pull`) |

Clyde remembers which Git repository each chat works in (from the chat's own
folder; it never searches folders) and where that repository lives on each of
your devices. On another device, `/clyde:pull` offers each missing repository:
clone it from the remote, it is already here (path), or skip it. The answer is
kept for that device. Clean clones are fast-forwarded, and local changes are
never touched. `/clyde:push` checks this device's references, uploads
corrections at once, and offers to commit and push Git work that has not reached
its remote yet. Nothing is committed without your choice, and never in a
repository another chat is working in. In the dashboard you can see, per chat
and device, the project folder, the repository and the memory folder, and
fine-tune the paths.

Use a dedicated chat for Clyde. That chat is never synchronised itself. The app
can stay open; Clyde only waits while another chat is in the middle of an answer.
Before each pull it saves a backup of the current state under `~/.clyde/backups`.

## What it reads, sends and changes

Clyde is transparent about its data flow:

- **Reads** Claude's local data: `~/.claude/projects` (chat transcripts, tool
  results, memory), `~/.claude/file-history`, `~/.claude/todos`,
  `~/.claude/plans`, `~/.claude/history.jsonl` and the desktop app's chat list.
  From the app's settings file `claude_desktop_config.json` it reads only the
  names of your chat groups and which chat belongs to which group; nothing else
  from that file is read out or sent. If a chat's working folder is inside a
  Git repository, it reads the repository's remote address, branch, commit and
  status. It also reads the targets of linked memory folders.
- **Sends** that data, split into compressed chunks, only to the backend URL you
  enter in `/clyde:setup`, authenticated with your token. Nothing goes anywhere
  else. Chat transcripts contain everything written in them, including file
  paths, code and command output. Git remote addresses are sent without any
  credentials, together with the local path of each repository and this
  device's home folder, drive and folder mappings (the references). Project
  files themselves are never sent. `/clyde:update` (and
  `clyde update`) additionally asks github.com for the latest release and
  downloads it through Claude's plugin commands and npm.
- **Changes** these same folders on `/clyde:pull`, after writing a backup. It
  clones a repository only when you choose it, and fast-forwards clean clones.
  Folders with local changes or own commits are never touched (`--no-repos`
  turns this off). Only when you choose it in
  `/clyde:push` does it commit (`git add -A`, respecting `.gitignore`) and push
  in a repository. Sidebar groups and pins are set through the app's own
  sidebar tools (create group, move chats, pin); the app's settings file is never
  written.
- **Stores** its settings and a hash cache in `~/.clyde`.
- **Runs** the `clyde` command-line tool, which calls `git` for the repository
  steps above, and `npm install` of the pinned release when you agree to it
  during setup.

## Deutsch in Kürze

Clyde synchronisiert die Chats der Claude-App zwischen mehreren PCs über ein
eigenes Backend, das du selbst per Docker betreibst. Du brauchst Node.js 20, das
Clyde-CLI und einen Token aus dem Dashboard deines Backends. In einem eigenen
Clyde-Chat: `/clyde:setup`, dann `/clyde:push` auf dem einen und `/clyde:pull` auf
dem anderen PC. Anleitung: https://github.com/Gardosen/clyde

## License

MIT
