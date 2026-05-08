#!/usr/bin/env bash
# Parse-check the inline JS in index.html.
# Uses node if available, otherwise the macOS bundled jsc helper, otherwise deno.
# Exits non-zero on any parse error.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HTML="$ROOT/index.html"
OUT="${TMPDIR:-/tmp}/rs-inline.js"

if [ ! -f "$HTML" ]; then
  echo "✖ Missing $HTML"
  exit 1
fi

# Extract every inline <script> block (not src=...) and concatenate.
python3 - <<PY
import re, sys
html = open("$HTML").read()
html = re.sub(r'<!--[\s\S]*?-->', '', html)
parts = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>', html)
combined = '\n;\n'.join(parts)
open("$OUT", "w").write(combined)
print(f'extracted {len(combined):,} chars across {len(parts)} block(s)', file=sys.stderr)
PY

# Pick a JS engine (any of these will catch syntax errors).
if command -v node >/dev/null 2>&1; then
  exec node --check "$OUT"
fi

if command -v deno >/dev/null 2>&1; then
  # Deno has no plain --check for ES; lint produces the same effect.
  exec deno check "$OUT"
fi

JSC="/System/Volumes/Preboot/Cryptexes/OS/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"
if [ -x "$JSC" ]; then
  # Wrap in Function() so it parses (but doesn't run) the code.
  exec "$JSC" -e "Function(read('$OUT')); print('PARSE_OK')"
fi

echo "✖ No JS engine found (need node, deno, or macOS jsc)" >&2
exit 2
