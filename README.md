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

### Good to know

- Needs Python 3 (standard library only) and the Artifact tool, which publishes the page.
- Summaries are written in Chinese. To change that, edit the language in `ask-log/SKILL.md`.
- The log is stored in `~/.claude/ask-log/`, one set of files per session.
