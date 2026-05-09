#!/usr/bin/env bash
# find-feature.sh — locate every piece of one feature across the codebase.
#
# Usage:
#   ./tools/find-feature.sh <feature-name>
#   ./tools/find-feature.sh fairness
#   ./tools/find-feature.sh "shift trade"
#
# Greps:
#   1. The FEATURE INDEX block at the top of index.html
#   2. Function/var names containing the term (case-insensitive)
#   3. _PERSISTED_KEYS entries
#   4. _MIGRATIONS entries
#   5. Audit-log calls (`_audit('foo.bar', ...)`)
#   6. DOM ID/class references
#
# Designed for the single-file architecture: knowing where one feature
# lives in a 38000-line file is the slowest part of editing.

set -e

if [ -z "$1" ]; then
  echo "usage: $0 <feature-name>"
  echo "examples:"
  echo "  $0 fairness"
  echo "  $0 oncall"
  echo "  $0 \"shift trade\""
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILE="$ROOT/index.html"
SW="$ROOT/sw.js"
TERM="$1"
TERM_LOWER="$(echo "$TERM" | tr '[:upper:]' '[:lower:]')"

if [ ! -f "$FILE" ]; then
  echo "error: $FILE not found"
  exit 1
fi

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
hr()   { printf '\033[2m─────────────────────────────────────────────────────\033[0m\n'; }

bold "🔍 Finding everywhere '$TERM' lives in RadScheduler"
hr

# 1) FEATURE INDEX block at top of file
bold "1. FEATURE INDEX entries"
awk '/── FEATURE INDEX ──/,/═════════════════════════════════════════════════════════════════════/' "$FILE" \
  | grep -in "$TERM" || dim "  (no FEATURE INDEX entries — consider adding one)"
hr

# 2) Function and variable definitions
bold "2. Function / variable definitions"
grep -nE "^(function |const |let |var |async function )[A-Za-z_]*[Ff]?[Oo]?[Oo]?" "$FILE" \
  | grep -i "$TERM" \
  | head -30 \
  | sed 's/^/  /' \
  || dim "  (no defs found — try a shorter term)"
hr

# 3) PERSISTED_KEYS entries
bold "3. _PERSISTED_KEYS entries"
awk '/_PERSISTED_KEYS = \[/,/^\];/' "$FILE" \
  | grep -in "$TERM" \
  | sed 's/^/  /' \
  || dim "  (no persisted-state field by that name)"
hr

# 4) _MIGRATIONS entries
bold "4. _MIGRATIONS entries"
awk '/_MIGRATIONS = \[/,/^\];/' "$FILE" \
  | grep -in "$TERM" \
  | sed 's/^/  /' \
  || dim "  (no schema migration touches this)"
hr

# 5) Audit-log calls
bold "5. Audit-log calls (_audit)"
grep -nE "_audit\(['\"][^'\"]*$TERM_LOWER" "$FILE" \
  | head -10 \
  | sed 's/^/  /' \
  || dim "  (no audit entries — may not be writing to audit log yet)"
hr

# 6) DOM IDs / classes referencing the term
bold "6. DOM elements (id= or class= containing term)"
grep -nE "(id|class)=\"[^\"]*$TERM_LOWER" "$FILE" \
  | head -10 \
  | sed 's/^/  /' \
  || dim "  (no DOM elements named for this feature)"
hr

# 7) sw.js mentions (push handlers, cache entries)
if [ -f "$SW" ]; then
  bold "7. sw.js mentions"
  grep -in "$TERM" "$SW" \
    | sed 's/^/  /' \
    || dim "  (no service-worker code touches this)"
  hr
fi

# 8) Inline call sites (every line that mentions the term)
bold "8. All call sites (capped at 20 lines)"
COUNT=$(grep -ic "$TERM" "$FILE" || echo 0)
echo "  Total mentions in index.html: $COUNT"
grep -in "$TERM" "$FILE" | head -20 | sed 's/^/  /'
if [ "$COUNT" -gt 20 ]; then
  dim "  (… and $((COUNT - 20)) more — narrow the search term to see them all)"
fi
hr
echo
echo "Tip: open index.html, jump to any line above with your editor's :<line> command."
