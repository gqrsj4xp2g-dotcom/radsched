#!/usr/bin/env bash
# RadScheduler Widget — one-command build for macOS.
#
# What it does:
#   1. Installs Node.js via Homebrew if missing
#   2. Runs `npm install` if node_modules isn't already populated
#   3. Generates a placeholder icon from the system if none exists
#   4. Builds an unsigned .dmg + .zip via electron-builder
#   5. Reveals the output in Finder
#
# Run from the repo root or from inside widget/:
#   ./widget/build-mac.sh
#
# Skip code-signing for an internal-distribution build — installers will
# work but show "unidentified developer" on first launch (right-click →
# Open to bypass). For a fully-signed build, set CSC_LINK +
# CSC_KEY_PASSWORD before running. See README.md.

set -e

# Resolve to widget/ regardless of where the user invoked this from.
cd "$(dirname "$0")"
WIDGET_DIR="$(pwd)"
echo "▶ RadScheduler widget build (macOS) — $WIDGET_DIR"

# ── 1. Node.js ──────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "▶ Node.js not found. Installing via Homebrew…"
  if ! command -v brew >/dev/null 2>&1; then
    echo "✖ Homebrew is required. Install from https://brew.sh first, then re-run."
    exit 1
  fi
  brew install node
fi
echo "  node: $(node --version)"
echo "  npm:  $(npm --version)"

# ── 2. npm install ──────────────────────────────────────────────────
if [ ! -d "node_modules/electron" ]; then
  echo "▶ Installing dependencies (this is a one-time ~2 min download)…"
  npm install
fi

# ── 3. Placeholder icon ─────────────────────────────────────────────
# electron-builder needs an icon at build/icon.png. If the user hasn't
# supplied one, we generate a 512x512 placeholder from emoji using
# macOS's bundled `sips` + `qlmanage`. This is throwaway — replace
# build/icon.png with your real icon before distribution.
if [ ! -f "build/icon.png" ]; then
  echo "▶ Generating placeholder icon (replace build/icon.png with your real one)…"
  # Use sips to render a colored square. Not pretty but gets the build
  # past electron-builder's icon-required check.
  python3 - <<'PY'
import struct, zlib, os
# Build a 512x512 solid-color PNG with a simple gradient (no PIL needed).
W, H = 512, 512
def png_chunk(typ, data):
  return (struct.pack('>I', len(data)) + typ + data
          + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff))
ihdr = struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)  # 8-bit RGB
raw = bytearray()
for y in range(H):
  raw.append(0)  # filter byte
  for x in range(W):
    # Dark navy → cyan diagonal gradient with a subtle "RS" feel.
    t = (x + y) / (W + H)
    r = int(15 + 23 * t)
    g = int(23 + 100 * t)
    b = int(42 + 180 * t)
    raw += bytes([r, g, b])
idat = zlib.compress(bytes(raw), 9)
png = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', ihdr) + png_chunk(b'IDAT', idat) + png_chunk(b'IEND', b'')
os.makedirs('build', exist_ok=True)
open('build/icon.png', 'wb').write(png)
print('  generated build/icon.png (512x512 placeholder)')
PY
fi

# ── 4. Build ────────────────────────────────────────────────────────
echo "▶ Building .dmg + .zip via electron-builder…"
npm run build:mac

# ── 5. Reveal in Finder ─────────────────────────────────────────────
DIST="$WIDGET_DIR/dist"
if [ -d "$DIST" ]; then
  echo ""
  echo "✓ Build complete. Output:"
  ls -lh "$DIST"/*.dmg "$DIST"/*.zip 2>/dev/null
  echo ""
  echo "Distribute the .dmg to physicians. They double-click → drag to"
  echo "Applications → first launch right-click → Open (to bypass the"
  echo "unsigned-app warning). Then they paste the pairing code."
  open "$DIST"
else
  echo "✖ Build did not produce a dist/ directory. Check the npm output above."
  exit 1
fi
