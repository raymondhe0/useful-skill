#!/bin/zsh
# L1 + L2 + L3: validate and run tests; engine warnings print only for failing tests, so tree lints live in the tests.
set -u
CLAUDE="${CLAUDE_BIN:-$(command -v claude || ls -d "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude | sort -V | tail -1)}"
DIR="${0:A:h}"

validate=$("$CLAUDE" plugin validate "$DIR" 2>&1)
if ! print -r -- "$validate" | grep -q "Validation passed"; then
  print -r -- "$validate"
  print "FAIL L1 validate"
  exit 1
fi

tests=$("$CLAUDE" plugin test "$DIR" 2>&1)
code=$?
print -r -- "$tests" | grep -vE "^\(pass\)"
if [[ $code -ne 0 ]] || print -r -- "$tests" | grep -qE "^\(fail\)"; then
  print "FAIL L2 tests"
  exit 1
fi
if print -r -- "$tests" | grep -qE "the engine reported|ui\.render \(|was skipped|drawn as plain text"; then
  print -r -- "$tests" | grep -E "the engine reported|ui\.render \(|was skipped|drawn as plain text" | sort -u
  print "FAIL L2 engine warnings"
  exit 1
fi
print "PASS L1-L3"
