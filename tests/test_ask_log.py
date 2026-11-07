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


def test_skill_text_names_the_plugin_command():
    skill = open(os.path.join(os.path.dirname(SCRIPT), "SKILL.md"), encoding="utf-8").read()
    assert not re.search(r"(?<![\w./-])/ask-log(?![\w:/-])", skill)
    assert "/ask-log:ask-log off" in skill


def test_one_question_is_singular():
    page = ask_log.render(state(entries=state()["entries"][:1]))
    assert "1 question, newest first" in page
    assert "2 questions, newest first" in ask_log.render(state())


# --- where the log is shown: VS Code preview or artifact ---

GLOB = ask_log.preview_glob()
OLD_KEY = "workbench.editorAssociations"


def fake_vscode(tmp_path):
    """A fake VS Code: a user dir plus a CLI that records what it was asked to open."""
    calls = tmp_path / "cli_calls"
    app = tmp_path / "app"
    (app / "bin").mkdir(parents=True)
    (app / "out").mkdir()
    cli = app / "bin" / "code"
    cli.write_text(f'#!/bin/sh\necho "$@" >> "{calls}"\n')
    cli.chmod(0o755)
    user = tmp_path / "userdata" / "User"
    user.mkdir(parents=True)
    env = {
        "VSCODE_CODE_CACHE_PATH": str(tmp_path / "userdata" / "CachedData" / "abc"),
        "VSCODE_NLS_CONFIG": json.dumps({"defaultMessagesFile": str(app / "out" / "nls.messages.json")}),
    }
    return env, user / "settings.json", calls


def run_script(tmp_path, entrypoint, extra_env, *args, stdin=None):
    (tmp_path / "config" / "projects" / "p").mkdir(parents=True, exist_ok=True)
    (tmp_path / "config" / "projects" / "p" / "sid1.jsonl").touch()
    env = {k: v for k, v in os.environ.items() if not k.startswith("VSCODE_")}
    env.update(extra_env, CLAUDE_CONFIG_DIR=str(tmp_path / "config"), CLAUDE_CODE_ENTRYPOINT=entrypoint,
               PATH="/usr/bin:/bin")
    r = subprocess.run([sys.executable, SCRIPT, *args], env=env, input=stdin, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout


def test_only_the_vscode_panel_uses_the_file_preview(monkeypatch):
    for entry, want in [("claude-vscode", "file"), ("claude-desktop", "artifact"), ("cli", "artifact"), ("", "artifact")]:
        monkeypatch.setenv("CLAUDE_CODE_ENTRYPOINT", entry)
        assert ask_log.display_mode() == want


def test_vscode_adds_the_setting_at_start_and_opens_the_finished_page_at_fill(tmp_path):
    env, settings, calls = fake_vscode(tmp_path)
    out = json.loads(run_script(tmp_path, "claude-vscode", env, "start", "--session", "sid1"))
    assert out["display"] == "file" and out["preview_setting"] == "added"
    assert not calls.exists()
    filled = json.loads(run_script(tmp_path, "claude-vscode", env, "fill", "--session", "sid1",
                                   stdin='{"where_i_am": ["x"]}'))
    assert filled["opened"] is True and out["log"] in calls.read_text()
    glob_ = "**/config/ask-log/*.md"
    assert json.loads(settings.read_text())[OLD_KEY] == {glob_: "vscode.markdown.preview.editor"}


def test_desktop_start_touches_no_vscode_state(tmp_path):
    env, settings, calls = fake_vscode(tmp_path)
    out = json.loads(run_script(tmp_path, "claude-desktop", env, "start", "--session", "sid1"))
    filled = json.loads(run_script(tmp_path, "claude-desktop", env, "fill", "--session", "sid1", stdin="{}"))
    assert out["display"] == filled["display"] == "artifact"
    assert "preview_setting" not in out and "opened" not in filled
    assert not settings.exists() and not calls.exists()


def test_vscode_updates_do_not_reopen_the_file(tmp_path):
    env, _, calls = fake_vscode(tmp_path)
    run_script(tmp_path, "claude-vscode", env, "start", "--session", "sid1")
    run_script(tmp_path, "claude-vscode", env, "fill", "--session", "sid1", stdin="{}")
    before = calls.read_text()
    assert json.loads(run_script(tmp_path, "claude-vscode", env, "append", "--session", "sid1"))["display"] == "file"
    filled = json.loads(run_script(tmp_path, "claude-vscode", env, "fill", "--session", "sid1",
                                   stdin='{"where_i_am": ["x"]}'))
    assert filled["display"] == "file" and "opened" not in filled
    assert calls.read_text() == before


def test_running_start_again_reopens_a_closed_preview(tmp_path):
    env, _, calls = fake_vscode(tmp_path)
    fill = lambda: run_script(tmp_path, "claude-vscode", env, "fill", "--session", "sid1", stdin="{}")
    run_script(tmp_path, "claude-vscode", env, "start", "--session", "sid1")
    fill()
    run_script(tmp_path, "claude-vscode", env, "start", "--session", "sid1")
    assert json.loads(fill())["opened"] is True
    assert len(calls.read_text().splitlines()) == 2


def test_vscode_start_reports_when_it_cannot_open(tmp_path):
    env, _, _ = fake_vscode(tmp_path)
    env["VSCODE_NLS_CONFIG"] = "not json"
    run_script(tmp_path, "claude-vscode", env, "start", "--session", "sid1")
    out = json.loads(run_script(tmp_path, "claude-vscode", env, "fill", "--session", "sid1", stdin="{}"))
    assert out["opened"] is False


def test_hook_reminder_matches_the_display(tmp_path):
    run_script(tmp_path, "claude-vscode", {}, "start", "--session", "sid1")
    stdin = json.dumps({"session_id": "sid1", "prompt": "hello"})
    vs = json.loads(run_script(tmp_path, "claude-vscode", {}, "hook", stdin=stdin))
    desk = json.loads(run_script(tmp_path, "claude-desktop", {}, "hook", stdin=stdin))
    assert "artifact" not in vs["hookSpecificOutput"]["additionalContext"].lower()
    assert "same artifact" in desk["hookSpecificOutput"]["additionalContext"]


def add(path):
    return ask_log.ensure_preview_setting(str(path))


def test_setting_on_missing_and_empty_files(tmp_path):
    p = tmp_path / "settings.json"
    assert add(p) == "added"
    assert json.loads(p.read_text())[OLD_KEY][GLOB]
    p.write_text("  \n")
    assert add(p) == "added"
    assert json.loads(p.read_text())[OLD_KEY][GLOB]
    p.write_text("{}")
    assert add(p) == "added"
    assert json.loads(p.read_text())[OLD_KEY][GLOB]


def test_setting_keeps_comments_and_other_values(tmp_path):
    p = tmp_path / "settings.json"
    original = '// my settings\n{\n  // zoom "quoted" {\n  "window.zoomLevel": 2,\n  "a": "// not a comment, {",\n}\n'
    p.write_text(original)
    assert add(p) == "added"
    text = p.read_text()
    assert "// my settings" in text and '// zoom "quoted" {' in text and '"a": "// not a comment, {"' in text
    parsed = json.loads(ask_log.strip_jsonc(text))
    assert parsed["window.zoomLevel"] == 2 and parsed["a"] == "// not a comment, {" and parsed[OLD_KEY][GLOB]
    assert (tmp_path / "settings.json.ask-log-backup").read_text() == original


def test_setting_merges_into_existing_associations(tmp_path):
    p = tmp_path / "settings.json"
    p.write_text('{"workbench.editorAssociations": {"*.ipynb": "jupyter"}, "b": 1}')
    assert add(p) == "added"
    parsed = json.loads(p.read_text())
    assert parsed[OLD_KEY]["*.ipynb"] == "jupyter" and parsed[OLD_KEY][GLOB] and parsed["b"] == 1


def test_setting_is_added_once(tmp_path):
    p = tmp_path / "settings.json"
    p.write_text('{"b": 1}')
    assert add(p) == "added"
    first = p.read_text()
    assert add(p) == "present"
    assert p.read_text() == first


def test_setting_leaves_files_it_cannot_read_alone(tmp_path):
    p = tmp_path / "settings.json"
    for bad in ['{"b": ', '{"workbench.editorAssociations": [{"filenamePattern": "*.md"}]}', '[1]',
                '{"[markdown]": {"workbench.editorAssociations": {}}}']:
        p.write_text(bad)
        result = add(p)
        if bad.startswith('{"[markdown]'):
            # Same key nested elsewhere: it must land at the top level, not inside that block.
            assert result == "added" and json.loads(p.read_text())[OLD_KEY][GLOB]
            assert json.loads(p.read_text())["[markdown]"][OLD_KEY] == {}
        else:
            assert result == "failed" and p.read_text() == bad


def test_setting_follows_a_symlinked_file(tmp_path):
    real = tmp_path / "dotfiles.json"
    real.write_text('{"b": 1}')
    link = tmp_path / "settings.json"
    link.symlink_to(real)
    assert add(link) == "added"
    assert link.is_symlink() and json.loads(real.read_text())[OLD_KEY][GLOB]


def test_preview_glob_cannot_catch_the_plugins_own_files():
    assert GLOB.startswith("**/") and GLOB.endswith("/ask-log/*.md") and GLOB != "**/ask-log/*.md"
