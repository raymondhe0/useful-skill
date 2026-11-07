# useful-skill

Personal skills for [Claude Code](https://claude.com/claude-code).

| Skill | What it does |
|---|---|
| [`ask-log`](ask-log/) | Keeps a running log of every question asked in a session, word for word, with a summary of each answer, published as an artifact that updates after every turn. |

## ask-log

### Install

```bash
git clone https://github.com/raymondhe0/useful-skill.git
```

```bash
mkdir -p ~/.claude/skills && cp -R useful-skill/ask-log ~/.claude/skills/
```

Then add this hook to `~/.claude/settings.json`. It is what reminds Claude to update the log each turn, so without it the log only updates when you run `/ask-log` again.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/skills/ask-log/ask_log.py hook",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

If the file already has other hooks, merge this entry in rather than replacing them.

### Use

- `/ask-log` starts the log and turns on auto-update for the session. Running it again fills in anything missed.
- `/ask-log off` stops auto-update. The log stays at the same link.

### Use in VS Code

Install the skill and the hook as described above, then start a new conversation in the Claude Code panel and run `/ask-log`. You need to be signed in with a claude.ai account, because sessions using an API key cannot publish.

The [docs](https://code.claude.com/docs/en/artifacts#availability) list only the CLI and the desktop app for artifacts, but the extension has published them in practice (v2.1.296). If Claude says it cannot publish, or `/ask-log` is missing from the `/` menu, use the CLI in VS Code's integrated terminal instead:

1. [Install the CLI](https://code.claude.com/docs/en/setup). The extension does not add `claude` to your PATH.
2. Run `claude` in the integrated terminal.
3. Run `/login`, then `/ask-log`.

### Good to know

- Needs Python 3 (standard library only) and a paid claude.ai plan (Pro, Max, Ultra, Team or Enterprise) to publish the page.
- The install commands and hook are written for macOS and Linux, and have not been tested on Windows.
- Summaries are written in Chinese. To change that, edit the language in `ask-log/SKILL.md`.
- The log is stored in `~/.claude/ask-log/`, one set of files per session.
