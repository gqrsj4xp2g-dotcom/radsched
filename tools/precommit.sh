#!/usr/bin/env bash
# Pre-commit hook: parse-check index.html before allowing commit.
# Install: ln -s ../../tools/precommit.sh .git/hooks/pre-commit; chmod +x tools/precommit.sh
#
# Skip with: git commit --no-verify (use sparingly).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Only run if the deployable shell or its managed sources are staged.
if ! git diff --cached --name-only | grep -Eq '^(index\.html|sw\.js|manifest\.webmanifest|src/parts/.*|supabase/functions/.*|edge-functions/.*|tools/smoke-check\.js)$'; then
  exit 0
fi

echo "→ pre-commit: parse-checking index.html…"
"$ROOT/tools/parsecheck.sh" || {
  echo "✖ Parse failed. Fix syntax errors before committing." >&2
  exit 1
}

echo "→ pre-commit: smoke-checking app shell…"
node "$ROOT/tools/smoke-check.js" || {
  echo "✖ Smoke check failed. Fix shell/asset/security drift before committing." >&2
  exit 1
}

echo "✓ checks OK"
