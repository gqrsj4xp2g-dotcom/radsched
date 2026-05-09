#!/usr/bin/env bash
# build-index.sh — concatenate src/parts/*.html into index.html.
#
# Today: src/parts/ is empty so this script is a no-op (existing
#   index.html ships unchanged). The autoship pipeline keeps working.
# As code is gradually extracted from the monolith into src/parts/
# files, this script takes ownership of more of index.html.
#
# Usage:
#   ./tools/build-index.sh                # rebuild index.html in-place
#   ./tools/build-index.sh --check        # diff src vs current index.html
#   ./tools/build-index.sh --output X.html # write to a different path
#
# See src/README.md for the migration plan.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PARTS_DIR="$ROOT/src/parts"
OUTPUT="$ROOT/index.html"
CHECK_ONLY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)  CHECK_ONLY=1; shift ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# If src/parts has no files yet, this is a no-op (today's state).
if [ ! -d "$PARTS_DIR" ] || [ -z "$(ls -A "$PARTS_DIR" 2>/dev/null)" ]; then
  echo "▶ src/parts/ is empty — no build needed (using existing index.html)"
  exit 0
fi

echo "▶ Concatenating $(ls "$PARTS_DIR" | wc -l | tr -d ' ') parts → $OUTPUT"
TMP=$(mktemp)
# The lexical sort is intentional: parts are named NN-… so order
# matches numeric prefix.
for f in "$PARTS_DIR"/*; do
  cat "$f" >> "$TMP"
done

if [ "$CHECK_ONLY" = "1" ]; then
  if diff -q "$ROOT/index.html" "$TMP" > /dev/null; then
    echo "✓ Build matches current index.html"
    rm -f "$TMP"
    exit 0
  else
    echo "✗ Build differs from current index.html. Diff:"
    diff "$ROOT/index.html" "$TMP" | head -40
    rm -f "$TMP"
    exit 1
  fi
fi

mv "$TMP" "$OUTPUT"
SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')
echo "✓ Wrote $OUTPUT ($SIZE bytes)"
