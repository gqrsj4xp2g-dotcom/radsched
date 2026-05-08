#!/usr/bin/env bash
# Pre-commit hook: parse-check index.html before allowing commit.
# Install: ln -s ../../tools/precommit.sh .git/hooks/pre-commit; chmod +x tools/precommit.sh
#
# Skip with: git commit --no-verify (use sparingly).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Only run if index.html is staged.
if ! git diff --cached --name-only | grep -q '^index\.html$'; then
  exit 0
fi

echo "→ pre-commit: parse-checking index.html…"
"$ROOT/tools/parsecheck.sh" || {
  echo "✖ Parse failed. Fix syntax errors before committing." >&2
  exit 1
}

echo "✓ parse OK"
