---
name: ask-log
description: Keep a running log of every question the user asked in this session (verbatim) with a detailed summary of each answer, on a page that updates after every turn: a Markdown preview in the VS Code panel, an artifact elsewhere. Use only when the user invokes /ask-log:ask-log (optionally with "off").
argument-hint: "[off]"
---

# /ask-log:ask-log

Arguments: `$ARGUMENTS`
Session id: `${CLAUDE_SESSION_ID}`

If the session id above is empty or still shows a `${...}` placeholder, take it from the scratchpad directory path in the system prompt (the last path segment, a UUID). Never guess it from the newest transcript file: other sessions run in the same project.

Script: `${CLAUDE_PLUGIN_ROOT}/skills/ask-log/ask_log.py`. The `fill` step prints the page, a Markdown file named after the session, as `page`, and every step prints where the log is shown as `display`: `file` in the VS Code panel (a local Markdown preview, no publishing and no claude.ai sign-in needed), `artifact` everywhere else.

## `/ask-log:ask-log off`

Run `python3 ${CLAUDE_PLUGIN_ROOT}/skills/ask-log/ask_log.py off --session <sid>`. Tell the user auto mode is off, that the log stays at the same place (the artifact link, or the file when `display` is `file`), and that `/ask-log:ask-log` turns it back on and fills in anything missed. Stop.

## `/ask-log:ask-log`

1. Run `python3 ${CLAUDE_PLUGIN_ROOT}/skills/ask-log/ask_log.py start --session <sid>`. It creates the log if missing and turns auto mode on (from now on a hook reminds you every turn).
2. If `display` is `artifact`: load the `artifact-design` skill if it has not been loaded in this session. If `display` is `file`, do not load it and do not use the Artifact tool at any point.
3. Do the **Catching up** steps below.
4. Tell the user, in Chinese, that the log now updates after every reply and that `/ask-log:ask-log off` stops it, plus:
   - `display` is `artifact`: the artifact link.
   - `display` is `file`: the `page` path, as a link. The `fill` step opens the preview and prints `opened`; `start` prints `preview_setting`. If `opened` is false, say it could not be opened automatically and that they can open that file themselves. If `preview_setting` is `added`, say one line was added to their VS Code user settings so that only these log files open as a preview, and that a backup is next to the settings file as `settings.json.ask-log-backup`. If `preview_setting` is `failed`, say the settings file could not be changed, so the file opens as text, and that they can add `"workbench.editorAssociations": {"**/.claude/ask-log/pages/*/*.md": "vscode.markdown.preview.editor"}` themselves or press Cmd/Ctrl+Shift+V for a preview.

## Update

While auto mode is on, the hook's reminder at the start of every turn gives the exact calls for this turn: the `fill` command, and the page path and link to publish. Every extra model call re-reads the whole conversation, which is most of what the log costs, so these calls ride on a message you send anyway.

1. Do the turn's work first. In the message where you call `wrap_up`, put the update's calls first, in this order, so they run one after another and the publish sends the page `fill` just wrote. With no `wrap_up` this turn, send them as one message right before the closing message.
2. `fill`: one Bash call with a quoted heredoc, so nothing in the text is expanded:
   ```
   python3 ${CLAUDE_PLUGIN_ROOT}/skills/ask-log/ask_log.py fill --session <sid> <<'EOF'
   {"where_i_am": ["...", "..."], "summaries": {"current": ["...", "..."]}}
   EOF
   ```
   - It first adds every question not yet in the log, copied verbatim from the transcript, so there is no separate step for that. `"current"` is this turn's question. When the reminder lists older questions still without a summary, add each under its number, such as `"12": [...]`.
   - Summaries: Chinese, detailed, as a list of short bullet strings: the conclusion or answer; what was done (files changed, commands run, findings with their numbers); what is still open or unverified. Write what is true, not more. Each bullet becomes one line in the table cell, so keep bullets short; use only `code` and **bold**, with no line breaks inside a bullet. For the current turn, summarize the answer you are about to give and the work done this turn.
   - Where I am: the session's goal, what has been decided or finished, and what is open next. A few short bullets in Chinese. They replace the previous ones.
   - It re-renders the log: a two-column table, your words on the left and the summary on the right, newest first. Never edit the `.md` or `.json` by hand; the questions are the user's words and the script escapes them so they render exactly.
3. If `display` is `file`, that is all: the open preview refreshes by itself, and when the session was renamed `fill` opens the renamed file. Do not open or edit the file, and do not use the Artifact tool.
4. If `display` is `artifact`: publish with the Artifact tool, `file_path` = the page path the reminder gave (the same path `fill` prints as `page`), with the reminder's link as `url`. A Markdown artifact takes its name from the file, which is what makes its name follow the session's. This is a Markdown artifact on purpose: this skill instructs a `.md` publish. Add no `icon`.
5. If `fill` exits with an error, read its output: `not_found` names a summary key it could not place and `pending` lists the questions still without a summary, by number; send another `fill` with those numbers. When the publish fails because the page path changed, publish the `page` that `fill` printed. Otherwise do not mention the update in the closing message.

### Catching up (the `/ask-log:ask-log` turn)

The reminder does not run on this turn, so use the separate steps:

1. Run `python3 ${CLAUDE_PLUGIN_ROOT}/skills/ask-log/ask_log.py append --session <sid>`. It adds every question not yet in the log and prints them as JSON with `answer_so_far` (the answer text already in the transcript) and `pending_summaries` (every question still without a summary).
2. Send one `fill` as in step 2 above, with every pending question under its number (`"current"` is not used on this turn) and the Where I am bullets.
3. If `display` is `artifact`, publish the `page` path `fill` printed. When `fill` printed an `artifact_url`, or you published this log earlier in this conversation, pass that link as `url` and add no `icon`. Otherwise this is the first publish: add `icon: "list"` and `description: "Every question asked in this session, with a summary of each answer."`, then add `"artifact_url": "<link>"` to the JSON of a `fill` in the same turn, so the reminder can give it from now on.

## Format rules

- The page heading is the session's name. Fixed labels stay in English (`Ask Log`, `Where I am`, `Questions`); summaries and Where I am text are Chinese.
- Entries are never reordered, renumbered or deleted; the script owns numbering and layout.
