# Clyde – sync your Claude chats between computers

Clyde keeps the chats of the Claude desktop app in the same state on several
computers. On computer A you run `/clyde:push`, on computer B `/clyde:pull`, and
B then has exactly the chats, chat list, file history, todos and plans that A had.
The two computers may use different Windows accounts and different drive letters;
Clyde rewrites the paths for each computer.

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
   `npm install -g github:Gardosen/clyde#v0.3.4`
4. **Claude Code** – the desktop app's Code tab or the terminal. The commands run
   local programs and do not work in claude.ai chat or Cowork.

## Commands

| Command | What it does |
|---|---|
| `/clyde:setup [url] [token] [drive]` | Connects this computer to your backend and registers the current chat as the Clyde chat |
| `/clyde:push` | Uploads the current state of all other chats on this computer |
| `/clyde:pull [snapshot]` | Restores the latest (or a given) state from the backend |
| `/clyde:status` | Shows the latest snapshot, local changes and chats that are busy |

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
  from that file is read out or sent.
- **Sends** that data, split into compressed chunks, only to the backend URL you
  enter in `/clyde:setup`, authenticated with your token. Nothing goes anywhere
  else. Chat transcripts contain everything written in them, including file
  paths, code and command output.
- **Changes** these same folders on `/clyde:pull`, after writing a backup.
- **Stores** its settings and a hash cache in `~/.clyde`.
- **Runs** only the `clyde` command-line tool, and `npm install` of the pinned
  release when you agree to it during setup.

## Deutsch in Kürze

Clyde synchronisiert die Chats der Claude-App zwischen mehreren PCs über ein
eigenes Backend, das du selbst per Docker betreibst. Du brauchst Node.js 20, das
Clyde-CLI und einen Token aus dem Dashboard deines Backends. In einem eigenen
Clyde-Chat: `/clyde:setup`, dann `/clyde:push` auf dem einen und `/clyde:pull` auf
dem anderen PC. Anleitung: https://github.com/Gardosen/clyde

## License

MIT
