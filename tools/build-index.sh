#!/usr/bin/env bash
# build-index.sh — inject src/parts/* into index.html at marked sites.
#
# How it works: index.html contains comment markers that delimit
# regions managed by this script. The script reads each marker pair
# from index.html, finds the corresponding source file in src/parts/,
# and replaces the region's contents in-place.
#
# Markers look like:
#   /* @TOKENS_BEGIN — managed by tools/build-index.sh ... */
#   <existing content>
#   /* @TOKENS_END */
#
# When you add a new source file:
#   1. Drop a CSS/JS region in src/parts/foo.css
#   2. Wrap that region in index.html with /* @FOO_BEGIN ... */ + /* @FOO_END */
#   3. Add an entry to the SOURCE_MAP below
#
# Today managed:
#   - css-tokens.css → /* @TOKENS_BEGIN ... */ ... /* @TOKENS_END */
#
# Usage:
#   ./tools/build-index.sh                  # rebuild index.html in-place
#   ./tools/build-index.sh --check          # diff src vs current index.html
#                                            (exit nonzero if they differ)

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PARTS_DIR="$ROOT/src/parts"
HTML="$ROOT/index.html"
CHECK_ONLY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Skip cleanly if we don't even have source files yet.
if [ ! -d "$PARTS_DIR" ] || [ -z "$(ls -A "$PARTS_DIR" 2>/dev/null)" ]; then
  echo "▶ src/parts/ is empty — no build needed (using existing index.html)"
  exit 0
fi

# Source-of-truth mapping: BEGIN/END marker name → source file.
# Add a new line per region as you extract more.
declare -a REGIONS=(
  "TOKENS:css-tokens.css"
  "MOBILE:css-mobile.css"
)

# Use Python for the replacement — sed/awk are too fragile for
# multi-line in-place edits with arbitrary content.
TMPFILE=$(mktemp)
cp "$HTML" "$TMPFILE"

for region in "${REGIONS[@]}"; do
  marker="${region%%:*}"
  src="$PARTS_DIR/${region##*:}"
  if [ ! -f "$src" ]; then
    echo "✖ Missing source: $src (referenced by $marker)" >&2
    exit 1
  fi
  python3 - "$TMPFILE" "$marker" "$src" <<'PY'
import sys, re
target_path, marker, src_path = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(target_path).read()
src  = open(src_path).read()
# Strip the source's leading + trailing whitespace so it slots into
# the marker block cleanly.
src = src.strip('\n') + '\n'
begin_pat = r'(/\*\s*@' + re.escape(marker) + r'_BEGIN[^*]*\*/\n)'
end_pat   = r'(\n/\*\s*@' + re.escape(marker) + r'_END\s*\*/)'
m = re.search(begin_pat + r'(.*?)' + end_pat, html, re.DOTALL)
if not m:
    print(f'✖ Could not find @{marker}_BEGIN ... @{marker}_END markers in index.html', file=sys.stderr)
    sys.exit(2)
new_html = html[:m.start(2)] + src + html[m.end(2):]
open(target_path, 'w').write(new_html)
print(f'  injected {marker} ({len(src)} chars)')
PY
done

if [ "$CHECK_ONLY" = "1" ]; then
  if diff -q "$HTML" "$TMPFILE" > /dev/null; then
    echo "✓ index.html matches src/parts (no changes needed)"
    rm -f "$TMPFILE"
    exit 0
  else
    echo "✗ index.html and src/parts disagree. Diff:"
    diff "$HTML" "$TMPFILE" | head -40
    rm -f "$TMPFILE"
    exit 1
  fi
fi

if diff -q "$HTML" "$TMPFILE" > /dev/null; then
  echo "✓ No changes (index.html already matches src/parts)"
  rm -f "$TMPFILE"
else
  mv "$TMPFILE" "$HTML"
  SIZE=$(wc -c < "$HTML" | tr -d ' ')
  echo "✓ Updated index.html ($SIZE bytes)"
fi
