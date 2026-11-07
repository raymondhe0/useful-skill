# useful-skill

Personal plugins for [Claude Code](https://claude.com/claude-code).

| Plugin | What it does |
|---|---|
| [`ask-log`](plugins/ask-log/) | Keeps a running log of every question asked in a session, word for word, with a summary of each answer, on a page that updates after every turn. |

## ask-log

### Install

Type this into a Claude Code conversation, in the terminal or in the VS Code panel:

```text
/plugin install ask-log --marketplace raymondhe0/useful-skill
```

This needs Claude Code 2.1.275 or later. Nothing needs to be added to `settings.json`, because the plugin brings its own hook. Start a new conversation afterwards.

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

```text
/plugin marketplace update useful-skill
```

### Develop

```bash
python3 -m pytest tests
```

The tests need `pytest` and `markdown-it-py`. Raise `version` in `plugins/ask-log/.claude-plugin/plugin.json` with each release, or installed copies will not update.
