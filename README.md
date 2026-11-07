# useful-skill

Personal plugins for [Claude Code](https://claude.com/claude-code).

| Plugin | What it does |
|---|---|
| [`ask-log`](plugins/ask-log/) | Keeps a running log of every question asked in a session, word for word, with a summary of each answer, on a page that updates after every turn. |
| [`session-board`](plugins/session-board/) | A board of your Claude Code sessions across the desktop app, VS Code and the terminal: running, needs me, finished, idle. |

## ask-log

### Install

Type this into a Claude Code conversation, in the terminal or in the VS Code panel:

```text
/plugin install ask-log --marketplace raymondhe0/useful-skill
```

This needs Claude Code 2.1.275 or later. Nothing needs to be added to `settings.json`, because the plugin brings its own hook. Start a new conversation afterwards. In VS Code, run **Developer: Reload Window** first, or the command won't appear in the `/` menu (typing it in full still works).

### Use

- `/ask-log:ask-log` starts the log and turns on auto-update for the conversation. Running it again fills in anything missed.
- `/ask-log:ask-log off` stops auto-update. The log stays at the same link.

Auto-update works per conversation, so run the command in each conversation you want logged.

### Good to know

- **Secrets:** questions are logged word for word. A password or API key pasted into the conversation ends up in the log and on the page, so check before you share the link. Pages are private until you share them.
- **Requirements:** Python 3, and a paid claude.ai plan (Pro, Max, Ultra, Team or Enterprise) with a claude.ai sign-in. Sessions using an API key cannot publish.
- **VS Code:** the [docs](https://code.claude.com/docs/en/artifacts#availability) list only the CLI and the desktop app for artifacts, but publishing has worked in the extension's panel (v2.1.318). If Claude says it cannot publish, [install the CLI](https://code.claude.com/docs/en/setup) and run `claude` in the integrated terminal.
- **Windows:** not tested.
- **Language:** summaries are written in Chinese. To change that, edit `plugins/ask-log/skills/ask-log/SKILL.md`.
- **Storage:** logs are kept in `~/.claude/ask-log/`, one set of files per conversation.

### Update

Run these in a terminal with the Claude Code CLI, then start a new conversation:

```bash
claude plugin marketplace update useful-skill
```

```bash
claude plugin update ask-log@useful-skill
```

### Develop

```bash
python3 -m pytest tests
```

The tests need `pytest` and `markdown-it-py`. Raise `version` in `plugins/ask-log/.claude-plugin/plugin.json` with each release, or installed copies will not update.

## session-board

### Install

Type this into a Claude Code conversation:

```text
/plugin install session-board --marketplace raymondhe0/useful-skill
```

The board needs the extension or CLI at 2.1.299 or later to draw its pane. Start a new conversation afterwards: it opens by itself, or type `/board`. In VS Code, run **Developer: Reload Window** first if `/board` doesn't appear.

### What it shows

Sessions on this computer, sorted into Running, Needs me, Finished (24h) and Idle, each with its latest reply and your usage so far. Press `?` on the board for the rules.

A session lands in Needs me when it asked you something: in its next-step box, with a question tool, or with a question mark in the last paragraph of its reply. The card shows the question. A request with no question mark, like "please review the diff", is not picked up.

| | Desktop app, for its own sessions | Anywhere else |
|---|---|---|
| Status and latest reply | Yes | Yes |
| Open a session | Yes | VS Code and desktop sessions; terminal sessions have no button |
| Send a message | Yes | Only to a session that is still running |
| Stop, change model or effort | Yes | Not shown |
| Context used | Every running session | Only the current session |

### Good to know

- **It reads your conversations:** the board reads `~/.claude/sessions/` and the end of each transcript in `~/.claude/projects/`, and keeps previews in the plugin's store in `~/.claude/plugins/`. Nothing is sent anywhere, but previews may include whatever was in your conversations, so check before sharing a screenshot.
- **A message starts a turn:** a message sent from VS Code or the terminal arrives as one from another session, and the other session starts working on it.
- **Tested on:** macOS only. It should work on Linux, and probably won't list sessions correctly on Windows.
- **Settings:** the plugin has two options, opening the board at session start and the refresh interval (3 seconds by default).

### Develop

```bash
cd plugins/session-board && ./check.sh
```

This needs the `claude` CLI. [`FEATURES.md`](plugins/session-board/FEATURES.md), in Chinese, lists every feature with how it is verified. Raise `version` in `plugins/session-board/.claude-plugin/plugin.json` with each release.
