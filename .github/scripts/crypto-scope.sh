#!/usr/bin/env bash
# Decide whether crypto-review applies to the change BASE...HEAD.
#
# Usage: crypto-scope.sh <base-sha>
# Prints "applies=true" or "applies=false" on its last line, after the
# in-scope paths (if any). Exits non-zero if the diff can't be read or is empty.
#
# Scope (the brief): the protocol packages, docs/spec and agent instruction
# files at any depth, except under .github/ (CODEOWNERS routes it to the owner).
#
# Selection is by git pathspec, never by text-processing path names: a name
# that isn't valid UTF-8 can't make a filter drop the lines after it, and a
# gated root that is itself a file or symlink (`packages/verifier` -> elsewhere)
# matches like the directory would.
set -euo pipefail
export LC_ALL=C

base="${1:?usage: crypto-scope.sh <base-sha>}"

scope=(
  packages/crypto packages/circuits packages/contracts packages/verifier docs/spec
  ':(glob)**/AGENTS.md' ':(glob)**/CLAUDE.md' ':(glob)**/CLAUDE.local.md' ':(glob)**/.mcp.json'
  ':(glob)**/.claude' ':(glob)**/.claude/**'
  ':(exclude).github'
)

# An unreadable diff fails here (set -e); an empty one fails explicitly.
all="$(git diff --no-renames --name-only -z "$base...HEAD" | wc -c)"
if [ "$all" -eq 0 ]; then
  echo "could not determine the changed files; refusing to skip crypto-review" >&2
  exit 1
fi

# --quiet: 0 = nothing in scope, 1 = something in scope, anything else = error.
status=0
git -c core.quotePath=false diff --no-renames --quiet "$base...HEAD" -- "${scope[@]}" || status=$?
case "$status" in
  0) echo "applies=false" ;;
  1)
    git -c core.quotePath=false diff --no-renames --name-only "$base...HEAD" -- "${scope[@]}" | sed 's/^/- /'
    echo "applies=true"
    ;;
  *)
    echo "git diff failed (exit $status); refusing to skip crypto-review" >&2
    exit 1
    ;;
esac
