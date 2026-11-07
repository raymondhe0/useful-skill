---
name: ask-log
description: Keep a running log of every question the user asked in this session (verbatim) with a detailed summary of each answer, published as a Markdown artifact that updates after every turn. Use only when the user invokes /ask-log:ask-log (optionally with "off").
argument-hint: "[off]"
---

# /ask-log:ask-log

Arguments: `$ARGUMENTS`
Session id: `${CLAUDE_SESSION_ID}`

If the session id above is empty or still shows a `${...}` placeholder, take it from the scratchpad directory path in the system prompt (the last path segment, a UUID). Never guess it from the newest transcript file: other sessions run in the same project.

Script: `${CLAUDE_PLUGIN_ROOT}/skills/ask-log/ask_log.py`. The script prints the log file path as `log`.

## `/ask-log:ask-log off`

Run `python3 ${CLAUDE_PLUGIN_ROOT}/skills/ask-log/ask_log.py off --session <sid>`. Tell the user auto mode is off, that the log stays at the same artifact link, and that `/ask-log:ask-log` turns it back on and fills in anything missed. Stop.

## `/ask-log:ask-log`

1. Run `python3 ${CLAUDE_PLUGIN_ROOT}/skills/ask-log/ask_log.py start --session <sid>`. It creates the log if missing and turns auto mode on (from now on a hook reminds you every turn).
2. Load the `artifact-design` skill if it has not been loaded in this session.
3. Do the **Update** steps below.
4. Tell the user, in Chinese: the artifact link, that the log now updates after every reply, and that `/ask-log:ask-log off` stops it.

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
5. Publish the log with the Artifact tool, `file_path` = the `log` path the script printed. This is a Markdown artifact on purpose: this skill instructs a `.md` publish.
   - First publish in this session: add `icon: "list"`, `title: "Ask Log"` and `description: "Every question asked in this session, with a summary of each answer."`.
   - Later publishes: same `file_path`, no `icon`, so the same link updates.
6. Do not mention the update in the closing message unless it failed. If the script exits with an error, say so in one line and keep answering the user.

## Format rules

- Fixed labels stay in English (`Ask Log`, `Where I am`, `Questions`); summaries and Where I am text are Chinese.
- Entries are never reordered, renumbered or deleted; the script owns numbering and layout.
