#!/bin/zsh
# Draws the board's real render tree as a page and screenshots it: run.sh <out dir>. Needs python playwright.
set -eu
DIR="${0:A:h}"; ROOT="${DIR:h:h}"; OUT="${1:?out dir}"; mkdir -p "$OUT"
CLAUDE="${CLAUDE_BIN:-$(command -v claude || ls -d "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude | sort -V | tail -1)}"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cp -R "$ROOT/.claude-plugin" "$ROOT/hooks" "$ROOT/types" "$ROOT/tsconfig.json" "$WORK/"; mkdir "$WORK/tests"
cp "$DIR/dump.test.ts.txt" "$WORK/tests/dump.test.ts"
"$CLAUDE" plugin test "$WORK" > "$OUT/dump.txt" 2>&1
python3 "$DIR/tree2html.py" "$OUT"
python3 - "$OUT" <<'P'
import sys
from playwright.sync_api import sync_playwright
out=sys.argv[1]
with sync_playwright() as p:
    b=p.chromium.launch()
    for w,h in((420,1100),(760,1100),(1300,800)):
        pg=b.new_page(viewport={'width':w,'height':h}); pg.goto(f'file://{out}/board-preview.html'); pg.screenshot(path=f'{out}/shot{w}.png',full_page=True)
    b.close()
P
print "$OUT/shot{420,760,1300}.png"
