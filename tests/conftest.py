"""The script edits the VS Code user settings, so the tests must never reach the real file."""
import hashlib
import os

import pytest


def real_settings():
    home = os.path.expanduser("~")
    return [os.path.join(home, "Library", "Application Support", "Code", "User", "settings.json"),
            os.path.join(home, ".config", "Code", "User", "settings.json"),
            os.path.join(os.environ.get("APPDATA", home), "Code", "User", "settings.json")]


def digest():
    return [hashlib.md5(open(p, "rb").read()).hexdigest() if os.path.exists(p) else None for p in real_settings()]


@pytest.fixture(autouse=True, scope="session")
def real_vscode_settings_stay_untouched():
    before = digest()
    yield
    assert digest() == before, "a test changed the real VS Code settings"
