#!/usr/bin/env python3
"""ask-log: keep a Markdown log of every question asked in a Claude Code session.

Questions are copied verbatim from the session transcript into a JSON state file;
Claude supplies the summaries; the Markdown page is always rendered from the state,
newest question first, as a table.

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
import sys
from datetime import datetime

HOME = os.path.expanduser("~")
STATE_DIR = os.path.join(HOME, ".claude", "ask-log")
PROJECTS_DIR = os.path.join(HOME, ".claude", "projects")
SCRIPT = os.path.abspath(__file__)

# Text blocks the app attaches to a human prompt; they are not part of the question.
INJECTED_BLOCK_RE = re.compile(r"^\s*<(system-reminder|ide_opened_file|ide_selection)>.*?</\1>\s*", re.S)
COMMAND_RE = re.compile(r"<command-name>(.*?)</command-name>", re.S)
COMMAND_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)
MD_ESCAPE = set("\\`*_{}[]<>()#+-.!|~&")
ANSWER_LIMIT = 6000


def log_path(sid):
    return os.path.join(STATE_DIR, f"{sid}.md")


def state_path(sid):
    return os.path.join(STATE_DIR, f"{sid}.json")


def flag_path(sid):
    return os.path.join(STATE_DIR, f"{sid}.on")


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
        if cmd.lstrip("/") == "ask-log":
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


def cell_verbatim(text):
    """Table-cell Markdown that renders the text exactly: punctuation escaped, line breaks as <br>."""
    lines = []
    for raw in text.strip("\n").split("\n"):
        esc = "".join("\\" + c if c in MD_ESCAPE else c for c in raw.rstrip())
        lead = len(esc) - len(esc.lstrip(" "))
        lines.append(" " * lead + esc[lead:])
    return "<br>".join(lines)


def cell_markdown(text):
    """Table cell for Claude-written Markdown: keep formatting, make it one line."""
    return " ".join(text.split("\n")).replace("|", "\\|")


def bullets_cell(items):
    return "<br>".join("• " + cell_markdown(i) for i in items)


def render(state):
    rows = []
    for e in reversed(state["entries"]):
        summary = bullets_cell(e["summary"]) if e["summary"] else "_Summary pending._"
        rows.append(f"| Q{e['n']} | {local_time(e['ts'], '%m-%d %H:%M')} | {cell_verbatim(e['question'])} | {summary} |")
    where = "\n".join(f"- {b}" for b in state["where_i_am"]) or "_Pending._"
    return (
        "# Ask Log\n\n"
        f"Session `{state['session'][:8]}` · started {state['started']} · `{state['project']}` · "
        f"{len(state['entries'])} questions, newest first\n\n"
        f"## Where I am\n\n{where}\n\n"
        "## Questions\n\n"
        "| # | Time | Question | Summary |\n"
        "|---|---|---|---|\n"
        + "\n".join(rows) + "\n"
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
    print(json.dumps({"log": log_path(sid), "created": created, "auto": True}, ensure_ascii=False))


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
    print(json.dumps({"log": log_path(sid), "added": report, "pending_summaries": pending},
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
    print(json.dumps({"log": log_path(sid), "pending_summaries": pending}))


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
    context = (
        "ask-log auto mode is on for this session. When this turn's work is done, before the "
        f"closing message, update the log: run `python3 {SCRIPT} append --session {sid}`, then "
        f"pipe the new summaries and the Where I am bullets to `python3 {SCRIPT} fill --session {sid}`, "
        f"then republish {log_path(sid)} as the same artifact. Full steps: "
        "~/.claude/skills/ask-log/SKILL.md (section Update)."
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
