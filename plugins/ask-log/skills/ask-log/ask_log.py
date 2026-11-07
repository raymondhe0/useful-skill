#!/usr/bin/env python3
"""ask-log: keep a Markdown log of every question asked in a Claude Code session.

Questions are copied verbatim from the session transcript into a JSON state file;
Claude supplies the summaries; the Markdown page is always rendered from the state,
newest question first, one section per question.

In the VS Code panel the log is shown as a local file in Markdown preview; everywhere
else Claude publishes it as an artifact. Every command prints which one as `display`.

  ask_log.py start  --session SID   create the log (if missing) and turn auto mode on
  ask_log.py append --session SID   add questions not yet in the log, print them as JSON
  ask_log.py fill   --session SID   read {"where_i_am": [...], "summaries": {"5": [...]}} on stdin
  ask_log.py off    --session SID   turn auto mode off (the log is kept)
  ask_log.py hook                   UserPromptSubmit hook: remind Claude while auto mode is on
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime

CONFIG_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
STATE_DIR = os.path.join(CONFIG_DIR, "ask-log")
PROJECTS_DIR = os.path.join(CONFIG_DIR, "projects")
SCRIPT = os.path.abspath(__file__)
SKILL_FILE = os.path.join(os.path.dirname(SCRIPT), "SKILL.md")

# Text blocks the app attaches to a human prompt; they are not part of the question.
INJECTED_BLOCK_RE = re.compile(r"^\s*<(system-reminder|ide_opened_file|ide_selection)>.*?</\1>\s*", re.S)
COMMAND_RE = re.compile(r"<command-name>(.*?)</command-name>", re.S)
COMMAND_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)
MD_ESCAPE = set("\\`*_{}[]<>()#+-.!|~&")
ANSWER_LIMIT = 6000
ASSOCIATIONS_KEY = "workbench.editorAssociations"
PREVIEW_EDITOR = "vscode.markdown.preview.editor"
SETTINGS_PICKUP_SECONDS = 4  # 1 s was too short on 1.145; 2 s was enough


def display_mode():
    return "file" if os.environ.get("CLAUDE_CODE_ENTRYPOINT") == "claude-vscode" else "artifact"


def preview_glob():
    """Only the log files open as a preview; every other Markdown file keeps opening as text.

    VS Code does not match an absolute path here (tested on 1.145), so it has to start with **.
    """
    parent = os.path.basename(os.path.dirname(STATE_DIR))
    return f"**/{parent}/{os.path.basename(STATE_DIR)}/*.md"


def vscode_settings_path():
    cache = os.environ.get("VSCODE_CODE_CACHE_PATH")  # <user data>/CachedData/<commit>
    if cache:
        return os.path.join(os.path.dirname(os.path.dirname(cache)), "User", "settings.json")
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support")
    elif sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    return os.path.join(base, "Code", "User", "settings.json")


def vscode_cli():
    """The editor's own CLI: the `code` shell command is often not installed."""
    try:
        messages = json.loads(os.environ["VSCODE_NLS_CONFIG"])["defaultMessagesFile"]  # <app>/out/nls.messages.json
    except (KeyError, TypeError, ValueError):
        return shutil.which("code")
    suffix = ".cmd" if sys.platform == "win32" else ""
    for name in ("code", "code-insiders", "cursor", "windsurf"):
        cli = os.path.join(os.path.dirname(os.path.dirname(messages)), "bin", name + suffix)
        if os.path.isfile(cli):
            return cli
    return shutil.which("code")


def open_in_vscode(path):
    cli = vscode_cli()
    if not cli:
        return False
    try:
        return subprocess.run([cli, "--reuse-window", path], capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def strip_jsonc(text):
    """Blank out comments and trailing commas, keeping every other character at its offset."""
    out = list(text)
    i, last_comma = 0, None
    while i < len(text):
        if text[i] == '"':
            i += 1
            while i < len(text) and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
            i += 1
            last_comma = None
        elif text.startswith(("//", "/*"), i):
            line = text.startswith("//", i)
            end = text.find("\n" if line else "*/", i + 2)
            end = len(text) if end < 0 else end + (0 if line else 2)
            for j in range(i, end):
                if text[j] != "\n":
                    out[j] = " "
            i = end
        else:
            if text[i] in "}]" and last_comma is not None:
                out[last_comma] = " "
            if text[i] == ",":
                last_comma = i
            elif not text[i].isspace():
                last_comma = None
            i += 1
    return "".join(out)


def top_level_object_start(blanked, key):
    """Offset of the `{` of a top-level key's object value in comment-free JSON, else None."""
    depth, i = 0, 0
    while i < len(blanked):
        c = blanked[i]
        if c == '"':
            end = i + 1
            while blanked[end] != '"':
                end += 2 if blanked[end] == "\\" else 1
            after = blanked[end + 1:].lstrip()
            if depth == 1 and json.loads(blanked[i:end + 1]) == key and after.startswith(":"):
                return len(blanked) - len(after[1:].lstrip())
            i = end + 1
            continue
        depth += c in "{["
        depth -= c in "}]"
        i += 1
    return None


def ensure_preview_setting(path):
    """Add the log's preview association to a VS Code settings file: "added", "present" or "failed".

    The file may contain comments, so the entry is inserted as text and the result is
    checked by parsing it. Anything unexpected leaves the file untouched.
    """
    pattern = preview_glob()
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        text = ""
    except (OSError, UnicodeDecodeError):
        return "failed"
    blanked = strip_jsonc(text)
    try:
        data = json.loads(blanked) if text.strip() else {}
    except ValueError:
        return "failed"
    if not isinstance(data, dict):
        return "failed"
    associations = data.get(ASSOCIATIONS_KEY, {})
    if not isinstance(associations, dict):
        return "failed"
    if pattern in associations:
        return "present"

    entry = f"{json.dumps(pattern)}: {json.dumps(PREVIEW_EDITOR)}"
    if not text.strip():
        new = f'{{\n    "{ASSOCIATIONS_KEY}": {{\n        {entry}\n    }}\n}}\n'
    elif ASSOCIATIONS_KEY in data:
        at = top_level_object_start(blanked, ASSOCIATIONS_KEY) + 1
        new = f"{text[:at]}\n        {entry}{',' if associations else ''}{text[at:]}"
    else:
        at = blanked.index("{") + 1
        new = f'{text[:at]}\n    "{ASSOCIATIONS_KEY}": {{\n        {entry}\n    }}{"," if data else ""}{text[at:]}'
    want = {**data, ASSOCIATIONS_KEY: {**associations, pattern: PREVIEW_EDITOR}}
    try:
        if json.loads(strip_jsonc(new)) != want:
            return "failed"
    except ValueError:
        return "failed"

    target = os.path.realpath(path)  # keep a symlinked settings file a symlink
    backup = path + ".ask-log-backup"
    try:
        if text.strip() and not os.path.exists(backup):
            with open(backup, "w", encoding="utf-8") as f:
                f.write(text)
        with open(target + ".ask-log-tmp", "w", encoding="utf-8") as f:
            f.write(new)
        os.replace(target + ".ask-log-tmp", target)
    except OSError:
        return "failed"
    return "added"


def prepare_vscode_preview(sid):
    """Open the preview only at the next fill: a write right after the first preview of a
    window can be missed (tested on 1.145), so the page should already be complete."""
    setting = ensure_preview_setting(vscode_settings_path())
    if setting == "added":
        time.sleep(SETTINGS_PICKUP_SECONDS)  # the editor reads the change asynchronously
    open(open_pending_path(sid), "w").close()
    return setting


def log_path(sid):
    return os.path.join(STATE_DIR, f"{sid}.md")


def state_path(sid):
    return os.path.join(STATE_DIR, f"{sid}.json")


def flag_path(sid):
    return os.path.join(STATE_DIR, f"{sid}.on")


def open_pending_path(sid):
    return os.path.join(STATE_DIR, f"{sid}.open")


def find_transcript(sid):
    hits = glob.glob(os.path.join(PROJECTS_DIR, "*", f"{sid}.jsonl"))
    if not hits:
        sys.exit(f"ask-log: no transcript for session {sid} under {PROJECTS_DIR}")
    return max(hits, key=os.path.getmtime)


def prompt_text(rec):
    """Return the user's own words for a human prompt record, or None if it is not one."""
    if rec.get("isSidechain") or rec.get("isMeta") or rec.get("isCompactSummary"):
        return None
    origin = rec.get("origin") or {}
    if origin and origin.get("kind") != "human":
        return None
    content = rec["message"]["content"]
    if isinstance(content, list):
        if any(b.get("type") == "tool_result" for b in content):
            return None
        parts = []
        for b in content:
            if b.get("type") == "text":
                t = INJECTED_BLOCK_RE.sub("", b["text"])
                if t.strip():
                    parts.append(t)
            elif b.get("type") == "image":
                parts.append("[image]")
        text = "\n\n".join(parts)
    else:
        text = INJECTED_BLOCK_RE.sub("", content)
    return command_or_text(text, has_origin=bool(origin))


def command_or_text(text, has_origin):
    stripped = text.strip()
    if not stripped:
        return None
    name = COMMAND_RE.search(stripped)
    if name:
        cmd = name.group(1).strip()
        if cmd.lstrip("/").split(":")[-1] == "ask-log":
            return None
        args = COMMAND_ARGS_RE.search(stripped)
        return f"{cmd} {args.group(1).strip()}".strip() if args else cmd
    # Records written before the origin field existed: skip app-generated tagged messages.
    if not has_origin and stripped.startswith(("<", "[Request interrupted", "Caveat:")):
        return None
    return text


def read_turns(transcript):
    """List of {uuid, ts, question, answer} in transcript order."""
    turns = []
    for line in open(transcript, encoding="utf-8"):
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = rec.get("type")
        question = None
        if kind == "user":
            question = prompt_text(rec)
            uid, ts = rec.get("uuid"), rec.get("timestamp")
        elif kind == "attachment":
            att = rec.get("attachment") or {}
            # A prompt typed while Claude was still working arrives as a queued command.
            if (att.get("type") == "queued_command" and att.get("commandMode") == "prompt"
                    and not att.get("isMeta")
                    and (att.get("humanTurn") or (att.get("origin") or {}).get("kind") == "human")):
                question = command_or_text(att.get("prompt") or "", has_origin=True)
            uid, ts = att.get("source_uuid") or rec.get("uuid"), att.get("timestamp") or rec.get("timestamp")
        elif kind == "assistant" and turns and not rec.get("isSidechain"):
            for b in rec["message"].get("content") or []:
                if b.get("type") == "text" and b["text"].strip():
                    turns[-1]["answer"].append(b["text"].strip())
            continue
        if question is not None:
            turns.append({"uuid": uid, "ts": ts, "question": question, "answer": []})
    return turns


def local_time(ts, fmt="%Y-%m-%d %H:%M"):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime(fmt)
    except (AttributeError, ValueError):
        return ""


def quote_verbatim(text):
    """Blockquote that renders the text exactly: punctuation escaped, line breaks and indents kept."""
    lines = []
    for raw in text.strip("\n").split("\n"):
        line = raw.rstrip()
        body = line.lstrip(" ")
        esc = "".join("\\" + c if c in MD_ESCAPE else c for c in body)
        lines.append("&nbsp;" * (len(line) - len(body)) + esc)
    return "\n".join("> " + line + ("  " if line and i < len(lines) - 1 else "") if line else ">"
                     for i, line in enumerate(lines))


def bullet_list(items):
    """List for Claude-written Markdown: keep formatting, one line per bullet."""
    return "\n".join("- " + " ".join(i.split("\n")) for i in items)


def render(state):
    sections = []
    for e in reversed(state["entries"]):
        summary = bullet_list(e["summary"]) if e["summary"] else "_Summary pending._"
        sections.append(f"### Q{e['n']} · {local_time(e['ts'], '%m-%d %H:%M')}\n\n{quote_verbatim(e['question'])}\n\n{summary}")
    return (
        "# Ask Log\n\n"
        f"Session `{state['session'][:8]}` · started {state['started']} · `{state['project']}` · "
        f"{len(state['entries'])} question{'' if len(state['entries']) == 1 else 's'}, newest first\n\n"
        f"## Where I am\n\n{bullet_list(state['where_i_am']) or '_Pending._'}\n\n"
        "## Questions\n\n"
        + "\n\n".join(sections) + "\n"
    )


def load(sid):
    path = state_path(sid)
    if not os.path.exists(path):
        sys.exit(f"ask-log: no log for session {sid}; run start first")
    return json.load(open(path, encoding="utf-8"))


def save(sid, state):
    with open(state_path(sid), "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    with open(log_path(sid), "w", encoding="utf-8") as f:
        f.write(render(state))


def cmd_start(sid):
    os.makedirs(STATE_DIR, exist_ok=True)
    created = not os.path.exists(state_path(sid))
    if created:
        transcript = find_transcript(sid)
        first = read_turns(transcript)
        save(sid, {
            "session": sid,
            "project": os.path.basename(os.path.dirname(transcript)),
            "started": local_time(first[0]["ts"] if first else datetime.now().astimezone().isoformat()),
            "where_i_am": [],
            "entries": [],
        })
    open(flag_path(sid), "w").close()
    result = {"log": log_path(sid), "created": created, "auto": True, "display": display_mode()}
    if result["display"] == "file":
        result["preview_setting"] = prepare_vscode_preview(sid)
    print(json.dumps(result, ensure_ascii=False))


def cmd_append(sid):
    state = load(sid)
    turns = read_turns(find_transcript(sid))
    last = state["entries"][-1]["uuid"] if state["entries"] else None
    idx = next((i for i, t in enumerate(turns) if t["uuid"] == last), None) if last else -1
    if idx is None:
        sys.exit(f"ask-log: last recorded message {last} not found in the transcript")
    report = []
    for t in turns[idx + 1:]:
        n = len(state["entries"]) + 1
        state["entries"].append({"n": n, "uuid": t["uuid"], "ts": t["ts"], "question": t["question"], "summary": None})
        answer = "\n\n".join(t["answer"])
        if len(answer) > ANSWER_LIMIT:
            answer = answer[:ANSWER_LIMIT // 2] + "\n…[truncated]…\n" + answer[-ANSWER_LIMIT // 2:]
        report.append({"q": n, "question": t["question"], "answer_so_far": answer})
    save(sid, state)
    pending = [e["n"] for e in state["entries"] if not e["summary"]]
    print(json.dumps({"log": log_path(sid), "display": display_mode(), "added": report, "pending_summaries": pending},
                     ensure_ascii=False, indent=1))


def cmd_fill(sid):
    state = load(sid)
    data = json.load(sys.stdin)
    by_n = {e["n"]: e for e in state["entries"]}
    for key, items in (data.get("summaries") or {}).items():
        n = int(str(key).lstrip("Qq"))
        if n not in by_n:
            sys.exit(f"ask-log: no question Q{n}")
        by_n[n]["summary"] = [items] if isinstance(items, str) else list(items)
    if "where_i_am" in data:
        state["where_i_am"] = list(data["where_i_am"])
    save(sid, state)
    pending = [e["n"] for e in state["entries"] if not e["summary"]]
    result = {"log": log_path(sid), "display": display_mode(), "pending_summaries": pending}
    if result["display"] == "file" and os.path.exists(open_pending_path(sid)):
        result["opened"] = open_in_vscode(log_path(sid))
        os.remove(open_pending_path(sid))
    print(json.dumps(result))


def cmd_off(sid):
    try:
        os.remove(flag_path(sid))
    except FileNotFoundError:
        pass
    print(json.dumps({"log": log_path(sid), "auto": False}))


def cmd_hook():
    data = json.load(sys.stdin)
    sid = data.get("session_id", "")
    if not sid or not os.path.exists(flag_path(sid)):
        return
    if (data.get("prompt") or "").lstrip().startswith("/ask-log"):
        return
    finish = (
        "The open preview refreshes by itself, so there is nothing to publish."
        if display_mode() == "file"
        else f"Then republish {log_path(sid)} as the same artifact."
    )
    context = (
        "ask-log auto mode is on for this session. When this turn's work is done, before the "
        f"closing message, update the log: run `python3 {SCRIPT} append --session {sid}`, then "
        f"pipe the new summaries and the Where I am bullets to `python3 {SCRIPT} fill --session {sid}`. "
        f"{finish} Full steps: {SKILL_FILE} (section Update)."
    )
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                             "additionalContext": context}}))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["start", "append", "fill", "off", "hook"])
    p.add_argument("--session", help="session id (the transcript file name without .jsonl)")
    a = p.parse_args()
    if a.command == "hook":
        return cmd_hook()
    if not a.session:
        p.error("--session is required")
    {"start": cmd_start, "append": cmd_append, "fill": cmd_fill, "off": cmd_off}[a.command](a.session)


if __name__ == "__main__":
    main()
