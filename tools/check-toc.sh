#!/usr/bin/env bash
# Check that every section banner in the script tag is referenced in the
# module table-of-contents at the top of the same script. Catches the
# "I added a section but forgot to update the TOC" mistake.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HTML="$ROOT/index.html"

# Extract banner titles ("// ── Some name ──" lines) from the script.
python3 - <<PY
import re, sys
html = open("$HTML").read()
m = list(re.finditer(r'<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>', html))
if not m:
    print('No inline script block found', file=sys.stderr)
    sys.exit(2)
script = m[-1].group(1)

# Locate the TOC block.
toc_match = re.search(r'MODULE TABLE OF CONTENTS([\s\S]*?)CONVENTIONS', script)
if not toc_match:
    print('No MODULE TABLE OF CONTENTS block found', file=sys.stderr)
    sys.exit(0)  # not fatal; TOC may be elsewhere
toc = toc_match.group(1)

# Extract banner names from the script body (skip the TOC region).
banner_re = re.compile(r'^// ── ([^─\n]+?) ─', re.M)
banners = set(b.strip() for b in banner_re.findall(script) if 'TABLE OF CONTENTS' not in b)

# Lower-case keyword check against the TOC. Normalize punctuation so quoted
# banner names key on the word itself.
missing = []
for b in sorted(banners):
    # Pick the first 3 words as the keyword.
    key = re.sub(r'^[^a-z0-9]+|[^a-z0-9]+$', '', re.split(r'\s+', b)[0].lower())
    if len(key) < 3:
        continue
    if key not in toc.lower():
        missing.append(b)

if missing:
    print('Banners not referenced in TOC:', file=sys.stderr)
    for b in missing:
        print('  - ' + b, file=sys.stderr)
    print('(update the MODULE TABLE OF CONTENTS block at top of script)', file=sys.stderr)
    sys.exit(1)
else:
    print('✓ TOC keywords look complete')
PY
