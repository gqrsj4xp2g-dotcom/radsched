#!/usr/bin/env bash
# Pre-commit hook: parse-check index.html before allowing commit.
# Install: ln -s ../../tools/precommit.sh .git/hooks/pre-commit; chmod +x tools/precommit.sh
#
# Skip with: git commit --no-verify (use sparingly).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Only run if the deployable shell or its managed sources are staged.
if ! git diff --cached --name-only | grep -Eq '^(index\.html|sw\.js|manifest\.webmanifest|src/parts/.*|docs/.*|\.github/.*|supabase/functions/.*|edge-functions/.*|tools/(smoke-check\.js|check-sql-rls\.js|check-migration-drift\.js|check-enterprise-readiness\.js|check-security-headers\.js|check-environment-config\.js|check-rbac-matrix\.js|check-toc\.sh))$'; then
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

echo "→ pre-commit: checking script TOC…"
"$ROOT/tools/check-toc.sh" || {
  echo "✖ TOC check failed. Update the MODULE TABLE OF CONTENTS block." >&2
  exit 1
}

echo "→ pre-commit: checking security headers…"
node "$ROOT/tools/check-security-headers.js" || {
  echo "✖ Security header check failed. Fix CSP/header drift before committing." >&2
  exit 1
}

echo "→ pre-commit: checking environment separation…"
node "$ROOT/tools/check-environment-config.js" || {
  echo "✖ Environment check failed. Fix staging/production drift before committing." >&2
  exit 1
}

echo "→ pre-commit: checking RBAC matrix…"
node "$ROOT/tools/check-rbac-matrix.js" || {
  echo "✖ RBAC matrix check failed. Update docs, tests, or role gates." >&2
  exit 1
}

echo "→ pre-commit: linting SQL/RLS examples…"
node "$ROOT/tools/check-sql-rls.js" || {
  echo "✖ SQL/RLS lint failed. Fix broad or stale policy examples before committing." >&2
  exit 1
}

echo "→ pre-commit: checking migration drift guardrails…"
node "$ROOT/tools/check-migration-drift.js" || {
  echo "✖ Migration drift check failed. Update hardening SQL or the expected policy set." >&2
  exit 1
}

echo "→ pre-commit: checking enterprise readiness evidence…"
node "$ROOT/tools/check-enterprise-readiness.js" || {
  echo "✖ Enterprise readiness check failed. Update docs, workflows, or migrations." >&2
  exit 1
}

echo "✓ checks OK"
