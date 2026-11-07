"""Run: python3 -m pytest tests  (needs markdown-it-py)"""
import html
import importlib.util
import json
import os
import re
import subprocess
import sys

from markdown_it import MarkdownIt

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "plugins", "ask-log", "skills", "ask-log", "ask_log.py")
spec = importlib.util.spec_from_file_location("ask_log", SCRIPT)
ask_log = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ask_log)
MD = MarkdownIt("commonmark")

TRICKY = [
    "plain question",
    "a|b *test* <tag> `code` [x](y) # h _u_ ~s~ &amp; 1. two\\",
    "line one\nline two\n\nafter a blank line",
    "    indented like code\n# not a heading\n- not a list\n> not a quote",
    "中文问题？",
]


def rendered_text(question):
    out = MD.render(ask_log.quote_verbatim(question))
    assert out.count("<blockquote>") == 1 and out.count("<p>") == question.strip("\n").count("\n\n") + 1
    assert not re.search(r"<(h\d|ul|ol|code|em|strong|a|pre|table)\b", out)
    inner = re.sub(r"[ \n]*</?(blockquote|p)>[ \n]*", "\n", out).strip("\n")
    inner = re.sub(r"<br />\n?", "\n", inner)
    return html.unescape(inner).replace(" ", " ")


def norm(text):
    return re.sub(r"\n+", "\n", text)


def test_questions_render_verbatim():
    for q in TRICKY:
        assert norm(rendered_text(q)) == norm(q)


def state(**kw):
    base = {"session": "abcdef123456", "started": "2026-11-06 17:00", "project": "demo", "where_i_am": ["goal"],
            "entries": [
                {"n": 1, "uuid": "a", "ts": "2026-11-06T10:00:00Z", "question": "first", "summary": ["one | two", "`x`"]},
                {"n": 2, "uuid": "b", "ts": "2026-11-06T11:00:00Z", "question": "second", "summary": None},
            ]}
    return {**base, **kw}


def test_page_has_no_table_and_shows_summaries_as_lists():
    out = MD.render(ask_log.render(state()))
    assert "<table" not in out
    assert "<li>one | two</li>" in out and "<li><code>x</code></li>" in out
    assert "Summary pending" in out


def test_newest_question_first():
    page = ask_log.render(state())
    assert page.index("### Q2") < page.index("### Q1")


def test_plugin_command_name_is_not_logged_as_a_question():
    for name in ("/ask-log", "/ask-log:ask-log"):
        text = f"<command-name>{name}</command-name><command-args>off</command-args>"
        assert ask_log.command_or_text(text, has_origin=True) is None


def run(args, config, stdin=""):
    env = {**os.environ, "CLAUDE_CONFIG_DIR": str(config)}
    return subprocess.run([sys.executable, SCRIPT, *args], input=stdin, env=env, capture_output=True, text=True, check=True)


def test_full_flow_uses_config_dir(tmp_path):
    sid = "11111111-2222-3333-4444-555555555555"
    (tmp_path / "projects" / "demo").mkdir(parents=True)
    (tmp_path / "projects" / "demo" / f"{sid}.jsonl").write_text(json.dumps(
        {"type": "user", "uuid": "u1", "timestamp": "2026-11-06T10:00:00Z", "origin": {"kind": "human"},
         "message": {"content": "hello?"}}) + "\n")
    log = json.loads(run(["start", "--session", sid], tmp_path).stdout)["log"]
    assert log.startswith(str(tmp_path))
    assert json.loads(run(["append", "--session", sid], tmp_path).stdout)["pending_summaries"] == [1]
    run(["fill", "--session", sid], tmp_path, json.dumps({"where_i_am": ["w"], "summaries": {"1": ["s"]}}))
    page = open(log, encoding="utf-8").read()
    assert "> hello?" in page and "- s" in page

    hook_in = json.dumps({"session_id": sid, "prompt": "hi"})
    context = json.loads(run(["hook"], tmp_path, hook_in).stdout)["hookSpecificOutput"]["additionalContext"]
    assert os.path.abspath(SCRIPT) in context and "SKILL.md" in context and ".claude/skills" not in context
    run(["off", "--session", sid], tmp_path)
    assert run(["hook"], tmp_path, hook_in).stdout == ""
