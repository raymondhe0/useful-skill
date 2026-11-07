---
name: ask-log
description: Keep a running log of every question the user asked in this session (verbatim) with a detailed summary of each answer, on a page that updates after every turn: a Markdown preview in the VS Code panel, an artifact elsewhere. Use only when the user invokes /ask-log:ask-log (optionally with "off").
argument-hint: "[off]"
---

# /ask-log:ask-log

Arguments: `$ARGUMENTS`
Session id: `${CLAUDE_SESSION_ID}`

If the session id above is empty or still shows a `${...}` placeholder, take it from the scratchpad directory path in the system prompt (the last path segment, a UUID). Never guess it from the newest transcript file: other sessions run in the same project.

Script: `${CLAUDE_PLUGIN_ROOT}/skills/ask-log/ask_log.py`. The script prints the log file path as `log`, and where the log is shown as `display`: `file` in the VS Code panel (a local Markdown preview, no publishing and no claude.ai sign-in needed), `artifact` everywhere else.

## `/ask-log:ask-log off`

Run `python3 ${CLAUDE_PLUGIN_ROOT}/skills/ask-log/ask_log.py off --session <sid>`. Tell the user auto mode is off, that the log stays at the same place (the artifact link, or the file when `display` is `file`), and that `/ask-log:ask-log` turns it back on and fills in anything missed. Stop.

## `/ask-log:ask-log`

1. Run `python3 ${CLAUDE_PLUGIN_ROOT}/skills/ask-log/ask_log.py start --session <sid>`. It creates the log if missing and turns auto mode on (from now on a hook reminds you every turn).
2. If `display` is `artifact`: load the `artifact-design` skill if it has not been loaded in this session. If `display` is `file`, do not load it and do not use the Artifact tool at any point.
3. Do the **Update** steps below.
4. Tell the user, in Chinese, that the log now updates after every reply and that `/ask-log:ask-log off` stops it, plus:
   - `display` is `artifact`: the artifact link.
   - `display` is `file`: the `log` path, as a link. The `fill` step opens the preview and prints `opened`; `start` prints `preview_setting`. If `opened` is false, say it could not be opened automatically and that they can open that file themselves. If `preview_setting` is `added`, say one line was added to their VS Code user settings so that only these log files open as a preview, and that a backup is next to the settings file as `settings.json.ask-log-backup`. If `preview_setting` is `failed`, say the settings file could not be changed, so the file opens as text, and that they can add `"workbench.editorAssociations": {"<folder of log>/*.md": "vscode.markdown.preview.editor"}` themselves or press Cmd/Ctrl+Shift+V for a preview.

## Update

Run this at the end of every turn while auto mode is on (the hook's reminder says so), after the turn's work and before `wrap_up` and the closing message.

1. Run `python3 ${CLAUDE_PLUGIN_ROOT}/skills/ask-log/ask_log.py append --session <sid>`. It adds every question not yet in the log, copied verbatim from the transcript, and prints them as JSON with `answer_so_far` (the answer text already in the transcript; empty for the current turn, whose answer you are about to give) and `pending_summaries` (every question still without a summary).
2. Write a summary for each question in `pending_summaries`:
   - Chinese, detailed, as a list of short bullet strings: the conclusion or answer; what was done (files changed, commands run, findings with their numbers); what is still open or unverified. Write what is true, not more. Inline Markdown (`code`, **bold**) is fine; no line breaks inside a bullet.
   - For the current turn, summarize the answer you are about to give and the work done this turn. For older turns use `answer_so_far` and your memory of the conversation.
3. Write the Where I am bullets: the session's goal, what has been decided or finished, and what is open next. A few short bullets in Chinese. They replace the previous ones.
4. Pipe both to the script in one Bash call with a quoted heredoc, so nothing in the text is expanded:
   ```
   python3 ${CLAUDE_PLUGIN_ROOT}/skills/ask-log/ask_log.py fill --session <sid> <<'EOF'
   {"where_i_am": ["...", "..."], "summaries": {"5": ["...", "..."]}}
   EOF
   ```
   It saves the state next to the log and re-renders the log: one section per question, newest first. Never edit the `.md` or `.json` by hand; the questions are the user's words and the script escapes them so they render exactly.
5. If `display` is `file`, stop here: the open preview refreshes by itself. Do not open or edit the file. If `display` is `artifact`, publish with the Artifact tool, `file_path` = the `publish` path `fill` printed. It is a copy of the log named after the session, because a Markdown artifact takes its name from the file; this is what makes the artifact's name follow the session's. This is a Markdown artifact on purpose: this skill instructs a `.md` publish.
   - When `fill` printed an `artifact_url`, or you published this log earlier in this conversation, pass that link as `url`, so a renamed file updates the same page. Add no `icon`.
   - Otherwise this is the first publish: add `icon: "list"` and `description: "Every question asked in this session, with a summary of each answer."`.
   - When `fill` printed `artifact_url: null` and you have the link, add `"artifact_url": "<link>"` to the JSON of your next `fill`, so the script keeps it.
6. Do not mention the update in the closing message unless it failed. If the script exits with an error, say so in one line and keep answering the user.

## Format rules

- The page heading is the session's name. Fixed labels stay in English (`Ask Log`, `Where I am`, `Questions`); summaries and Where I am text are Chinese.
- Entries are never reordered, renumbered or deleted; the script owns numbering and layout.
