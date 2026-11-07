# useful-skill

Personal plugins for [Claude Code](https://claude.com/claude-code).

| Plugin | What it does |
|---|---|
| [`ask-log`](plugins/ask-log/) | Keeps a running log of every question asked in a session, word for word, with a summary of each answer, on a page that updates after every turn: a Markdown preview in the VS Code panel, an artifact elsewhere. |
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

### Where the log appears

| Where you run it | What you see | Needs |
|---|---|---|
| VS Code panel | A local Markdown file, opened as a rendered preview. It refreshes by itself after every turn. | Python 3 |
| Claude desktop app or terminal | A private artifact page at a link that stays the same. | Python 3, and a paid claude.ai plan (Pro, Max, Ultra, Team or Enterprise) with a claude.ai sign-in. Sessions using an API key cannot publish. |

The first time it runs in the VS Code panel, ask-log adds this to your VS Code user settings, so only log files open as a preview and other Markdown files are unaffected:

```json
"workbench.editorAssociations": {
    "**/.claude/ask-log/*.md": "vscode.markdown.preview.editor"
}
```

Your previous settings are saved next to the file as `settings.json.ask-log-backup`. If the settings file can't be read safely, it is left alone and the log opens as text; add the lines above yourself, or press Cmd/Ctrl+Shift+V. A VS Code profile other than the default keeps its own settings, so it needs the same lines added by hand. If you close the preview, run `/ask-log:ask-log` again to reopen it.

### Good to know

- **Secrets:** questions are logged word for word. A password or API key pasted into the conversation ends up in the log and on the page, so check before you share the link. Pages are private until you share them.
- **Windows:** not tested.
- **Language:** summaries are written in Chinese. To change that, edit `plugins/ask-log/skills/ask-log/SKILL.md`.
- **Storage:** logs are kept in `~/.claude/ask-log/`, one set of files per conversation.

### Update

In the VS Code panel, open **Manage Plugins**, choose **Refresh marketplace** for `useful-skill`, then update `ask-log`. Run **Developer: Reload Window** and start a new conversation.

With the Claude Code CLI, run these, then start a new conversation:

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

A session lands in Needs me when it asked you something: in its next-step box, with a question tool, or with a question mark in the last paragraph of its reply. The card shows the question. A request with no question mark, like "please review the diff", is picked up only with the `modelJudge` option on.

| | Desktop app, for its own sessions | Anywhere else |
|---|---|---|
| Status and latest reply | Yes | Yes |
| Open a session | Yes | VS Code and desktop sessions; terminal sessions have no button |
| Send a message | Yes | Only to a session that is still running |
| Stop, change model or effort | Yes | Not shown |
| Context used | Every running session | Only the current session |

### Good to know

- **It reads your conversations:** the board reads `~/.claude/sessions/` and the end of each transcript in `~/.claude/projects/`, and keeps previews in the plugin's store in `~/.claude/plugins/`. Previews may include whatever was in your conversations, so check before sharing a screenshot.
- **Model check (off by default):** with `modelJudge` on, the last 1,500 characters of each finished reply that has no question are sent once to Claude Haiku through your own Claude Code sign-in, to decide whether the reply waits for you. It uses a little of your quota and can be wrong; Dismiss clears a wrong card. With it off, nothing is sent anywhere.
- **A message starts a turn:** a message sent from VS Code or the terminal arrives as one from another session, and the other session starts working on it.
- **Tested on:** macOS only. It should work on Linux, and probably won't list sessions correctly on Windows.
- **Settings:** the plugin has three options: opening the board at session start, the refresh interval (3 seconds by default) and the model check.

### Develop

```bash
cd plugins/session-board && ./check.sh
```

This needs the `claude` CLI. [`FEATURES.md`](plugins/session-board/FEATURES.md), in Chinese, lists every feature with how it is verified. Raise `version` in `plugins/session-board/.claude-plugin/plugin.json` with each release.
