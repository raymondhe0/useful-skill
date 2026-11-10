#!/usr/bin/env python3
"""ask-log: keep a Markdown log of every question asked in a Claude Code session.

Questions are copied verbatim from the session transcript into a JSON state file;
Claude supplies the summaries; the Markdown page is always rendered from the state,
newest question first, one section per question.

In the VS Code panel the log is shown as a local file in Markdown preview; everywhere
else Claude publishes it as an artifact. Every command prints which one as `display`.

  ask_log.py start  --session SID   create the log (if missing) and turn auto mode on
  ask_log.py append --session SID   add questions not yet in the log, print them as JSON
  ask_log.py fill   --session SID   add new questions, then read {"where_i_am": [...], "summaries": {"current": [...], "5": [...]},
                                    "artifact_url": "..."} on stdin; "current" is the question this turn answers
  ask_log.py off    --session SID   turn auto mode off (the log is kept)
  ask_log.py hook                   UserPromptSubmit hook: remind Claude while auto mode is on
"""
import argparse
import glob
import html
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
ARTIFACT_URL_PREFIX = "https://claude.ai/"
TITLE_MAX_CHARS = 60  # 60 four-byte characters plus ".md" still fit a 255-byte file name
CURRENT_SLACK_SECONDS = 30  # the prompt record can be stamped a little before the hook runs


def display_mode():
    return "file" if os.environ.get("CLAUDE_CODE_ENTRYPOINT") == "claude-vscode" else "artifact"


def preview_glob():
    """Only the log files open as a preview; every other Markdown file keeps opening as text.

    VS Code does not match an absolute path here (tested on 1.145), so it has to start with **.
    """
    parent = os.path.basename(os.path.dirname(STATE_DIR))
    return f"**/{parent}/{os.path.basename(STATE_DIR)}/pages/*/*.md"


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


def turn_path(sid):
    """What the hook saw when this turn started: the prompt, the time and the page name it announced."""
    return os.path.join(STATE_DIR, f"{sid}.turn")


def remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def find_transcript(sid):
    hits = glob.glob(os.path.join(PROJECTS_DIR, "*", f"{sid}.jsonl"))
    if not hits:
        sys.exit(f"ask-log: no transcript for session {sid} under {PROJECTS_DIR}")
    return max(hits, key=os.path.getmtime)


def strip_injected(text):
    """Drop every app-added block at the start; several can come one after another."""
    while True:
        m = INJECTED_BLOCK_RE.match(text)
        if not m:
            return text
        text = text[m.end():]


def blocks_text(content):
    """A prompt is plain text, or a list of blocks when it carries images."""
    if not isinstance(content, list):
        return strip_injected(content or "")
    parts = []
    for b in content:
        if b.get("type") == "text":
            t = strip_injected(b["text"])
            if t.strip():
                parts.append(t)
        elif b.get("type") == "image":
            parts.append("[image]")
    return "\n\n".join(parts)


def prompt_text(rec):
    """Return the user's own words for a human prompt record, or None if it is not one."""
    if rec.get("isSidechain") or rec.get("isMeta") or rec.get("isCompactSummary"):
        return None
    origin = rec.get("origin") or {}
    if origin and origin.get("kind") != "human":
        return None
    content = rec["message"]["content"]
    if isinstance(content, list) and any(b.get("type") == "tool_result" for b in content):
        return None
    return command_or_text(blocks_text(content), has_origin=bool(origin))


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
                question = command_or_text(blocks_text(att.get("prompt")), has_origin=True)
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


def escape_md(text):
    return "".join("\\" + c if c in MD_ESCAPE else c for c in text)


WBR_EVERY = 12  # a long link or path must not force its column wider than the set share


def breakable(text):
    """Escaped text with <wbr> inside long runs, so a narrow column can wrap them; copying is unchanged."""
    out = []
    for i, part in enumerate(re.split(r"(\S{%d,})" % (WBR_EVERY + 1), text)):
        chunks = [part[j:j + WBR_EVERY] for j in range(0, len(part), WBR_EVERY)] if i % 2 else [part]
        out.append("<wbr>".join(html.escape(c, quote=False) for c in chunks))
    return "".join(out)


def cell_verbatim(text):
    """HTML that shows the user's words exactly: escaped, with line breaks and indents kept."""
    lines = []
    for raw in text.strip("\n").split("\n"):
        line = raw.rstrip()
        body = line.lstrip(" ")
        lines.append("&nbsp;" * (len(line) - len(body)) + breakable(body))
    return "<br>".join(lines)


def inline_html(text):
    """The inline Markdown summaries use, `code` and **bold**, as HTML; everything else is escaped."""
    out = []
    for i, part in enumerate(re.split(r"`([^`]*)`", " ".join(text.split()))):
        part = html.escape(part, quote=False)
        out.append(f"<code>{part}</code>" if i % 2 else re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", part))
    return "".join(out)


def cell_summary(items):
    return "<br>".join("• " + inline_html(i) for i in items)


def bullet_list(items):
    """List for Claude-written Markdown: keep formatting, one line per bullet."""
    return "\n".join("- " + " ".join(i.split("\n")) for i in items)


def render(state):
    """The questions are an HTML table so both viewers keep the column widths; a Markdown table
    gives a long question most of the width. Each row stays on one line: a blank line would end
    the HTML block."""
    rows = []
    for e in reversed(state["entries"]):
        asked = f"<strong>Q{e['n']}</strong> · {local_time(e['ts'], '%m-%d %H:%M')}<br>{cell_verbatim(e['question'])}"
        summary = cell_summary(e["summary"]) if e["summary"] else "<em>Summary pending.</em>"
        rows.append(f'<tr><td valign="top">{asked}</td><td valign="top">{summary}</td></tr>')
    return (
        f"# {escape_md(state.get('title') or 'Ask Log')}\n\n"
        f"Ask Log · session `{state['session'][:8]}` · started {state['started']} · `{state['project']}` · "
        f"{len(state['entries'])} question{'' if len(state['entries']) == 1 else 's'}, newest first\n\n"
        f"## Where I am\n\n{bullet_list(state['where_i_am']) or '_Pending._'}\n\n"
        "## Questions\n\n"
        '<table>\n<colgroup><col width="38%"><col width="62%"></colgroup>\n'
        "<thead><tr><th>You asked</th><th>Summary</th></tr></thead>\n<tbody>\n"
        + "\n".join(rows) + "\n</tbody>\n</table>\n"
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


def session_title(transcript):
    """The conversation's current name. A name the user gave wins over a generated one."""
    custom = generated = None
    with open(transcript, encoding="utf-8", errors="replace") as f:
        for line in f:
            if '-title"' not in line[:80]:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("type") == "custom-title":
                custom = rec.get("customTitle") or custom
            elif rec.get("type") == "ai-title":
                generated = rec.get("aiTitle") or generated
    return " ".join((custom or generated or "").split())


def page_name(sid, title):
    """A Markdown artifact and a VS Code tab take their name from the file, so it is named after the session."""
    name = " ".join(re.sub(r'[\\/:*?"<>|\x00-\x1f\x7f]', " ", title).split())[:TITLE_MAX_CHARS].strip(" .")
    return (name or f"Ask Log {sid[:8]}") + ".md"


def page_path(sid, name):
    return os.path.join(STATE_DIR, "pages", sid, name)


def write_page(sid, state, name=None):
    """Write the page the user sees, one folder per session so equal names can't collide.

    An unchanged name is overwritten in place, or an open preview would lose its file.
    `name` is the one the hook announced, so a rename during the turn can't change the path
    Claude publishes. Returns the path and whether it is new.
    """
    name = name or page_name(sid, state.get("title") or "")
    path = page_path(sid, name)
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    is_new = not os.path.exists(path)
    shutil.copyfile(log_path(sid), path)
    for other in os.listdir(folder):
        if other != name:
            os.remove(os.path.join(folder, other))
    return path, is_new


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
            "title": session_title(transcript),
            "where_i_am": [],
            "entries": [],
        })
    open(flag_path(sid), "w").close()
    remove(turn_path(sid))
    result = {"log": log_path(sid), "created": created, "auto": True, "display": display_mode()}
    if result["display"] == "file":
        result["preview_setting"] = prepare_vscode_preview(sid)
    print(json.dumps(result, ensure_ascii=False))


def add_new_turns(state, transcript):
    """Add every question not yet in the log; return them with the answer so far."""
    state["title"] = session_title(transcript) or state.get("title", "")
    turns = read_turns(transcript)
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
    return report


def cmd_append(sid):
    state = load(sid)
    report = add_new_turns(state, find_transcript(sid))
    save(sid, state)
    pending = [e["n"] for e in state["entries"] if not e["summary"]]
    print(json.dumps({"log": log_path(sid), "display": display_mode(), "added": report, "pending_summaries": pending},
                     ensure_ascii=False, indent=1))


def epoch(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def current_entry(state, turn):
    """The question this turn answers: the newest one with the hook's prompt text, else the
    first one asked once the turn began (later ones were typed while Claude was working)."""
    if not turn:
        return None
    want = " ".join((turn.get("prompt") or "").split())
    for e in reversed(state["entries"]):
        if want and " ".join(e["question"].split()) == want:
            return e
    since = turn.get("time", 0) - CURRENT_SLACK_SECONDS
    return next((e for e in state["entries"] if (epoch(e["ts"]) or 0) >= since), None)


def read_turn(sid):
    try:
        return json.load(open(turn_path(sid), encoding="utf-8"))
    except (OSError, ValueError):
        return None


def cmd_fill(sid):
    state = load(sid)
    data = json.load(sys.stdin)
    add_new_turns(state, find_transcript(sid))
    turn = read_turn(sid)
    by_n = {e["n"]: e for e in state["entries"]}
    missing = []
    for key, items in (data.get("summaries") or {}).items():
        if str(key).lower() == "current":
            entry = current_entry(state, turn)
            if not entry:
                missing.append("current")
                continue
        else:
            entry = by_n.get(int(str(key).lstrip("Qq")))
            if not entry:
                missing.append(f"Q{key}")
                continue
        entry["summary"] = [items] if isinstance(items, str) else list(items)
    if "where_i_am" in data:
        state["where_i_am"] = list(data["where_i_am"])
    if str(data.get("artifact_url") or "").startswith(ARTIFACT_URL_PREFIX):
        state["artifact_url"] = data["artifact_url"]
    save(sid, state)
    pending = [e["n"] for e in state["entries"] if not e["summary"]]
    page, is_new = write_page(sid, state, (turn or {}).get("page"))
    remove(turn_path(sid))
    result = {"page": page, "display": display_mode(), "pending_summaries": pending}
    if result["display"] == "file":
        if is_new or os.path.exists(open_pending_path(sid)):
            result["opened"] = open_in_vscode(page)
        if os.path.exists(open_pending_path(sid)):
            os.remove(open_pending_path(sid))
    else:
        result["artifact_url"] = state.get("artifact_url")
    if missing:
        result["not_found"] = missing
        result["pending"] = [{"q": e["n"], "question": e["question"][:200]} for e in state["entries"] if not e["summary"]]
    print(json.dumps(result, ensure_ascii=False))
    if missing:
        sys.exit(f"ask-log: no question for {', '.join(missing)}; the rest was saved, see `pending`")


def cmd_off(sid):
    remove(flag_path(sid))
    remove(turn_path(sid))
    print(json.dumps({"log": log_path(sid), "auto": False}))


def cmd_hook():
    """Tell Claude everything the update needs, so it can ride on the turn's last tool message:
    every extra model call re-reads the whole conversation, which is most of ask-log's cost."""
    data = json.load(sys.stdin)
    sid = data.get("session_id", "")
    if not sid or not os.path.exists(flag_path(sid)):
        return
    prompt = data.get("prompt") or ""
    if prompt.lstrip().startswith("/ask-log"):
        remove(turn_path(sid))  # the skill's own steps run this turn
        return
    try:
        state = json.load(open(state_path(sid), encoding="utf-8"))
        hits = glob.glob(os.path.join(PROJECTS_DIR, "*", f"{sid}.jsonl"))
        title = session_title(max(hits, key=os.path.getmtime)) if hits else ""
    except (OSError, ValueError):
        return
    name = page_name(sid, title or state.get("title") or "")
    with open(turn_path(sid), "w", encoding="utf-8") as f:
        json.dump({"prompt": prompt, "time": time.time(), "page": name}, f, ensure_ascii=False)
    older = [e["n"] for e in state["entries"] if not e["summary"]]
    fill = (f"Bash: `python3 {SCRIPT} fill --session {sid} <<'EOF'` + "
            '{"where_i_am": [...], "summaries": {"current": [...]' + "".join(f', "{n}": [...]' for n in older) + "}}"
            " + `EOF` (\"current\" is this turn's question; the script adds it to the log itself)")
    if display_mode() == "file":
        steps = f"1) {fill}; 2) `wrap_up`, if you call it. The open preview refreshes by itself; publish nothing."
    else:
        url = state.get("artifact_url")
        publish = f"Artifact publish, `file_path` = `{page_path(sid, name)}`" + (f", `url` = `{url}`" if url else "")
        steps = f"1) {fill}; 2) {publish}; 3) `wrap_up`, if you call it."
    pending = "; ".join(f"Q{e['n']} {json.dumps(' '.join(e['question'].split())[:100], ensure_ascii=False)}"
                        for e in state["entries"] if not e["summary"])
    context = (
        "ask-log auto mode is on for this session. When this turn's work is done, update the log in the "
        "message where you call `wrap_up`, as its first tool calls, in this order (with no `wrap_up` this turn, "
        f"send them as one message right before the closing message): {steps} "
        + (f"Older questions still without a summary, add them under their numbers: {pending}. " if pending else "")
        + f"How to write the summaries and Where I am: {SKILL_FILE} (section Update)."
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
