#!/usr/bin/env bash
# RadScheduler Widget — publish built installers to GitHub Releases.
#
# Workflow:
#   1. Build the widget first (./build-mac.sh produces dist/*.dmg)
#   2. Run this script: ./publish-release.sh [tag]
#      Default tag = "widget-v$(jq .version package.json)"
#   3. Copy the printed asset URLs into RadScheduler →
#      Desktop Widget → "macOS download URL" + "Windows download URL"
#
# Requires the GitHub CLI (gh) — install via:
#     brew install gh
#     gh auth login
#
# Re-runs are safe: if the release already exists, this overwrites the
# attached assets. Useful for shipping a hotfix without bumping the
# package.json version.

set -e

cd "$(dirname "$0")"
WIDGET_DIR="$(pwd)"
DIST="$WIDGET_DIR/dist"

# ── Sanity checks ───────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  echo "✖ The GitHub CLI (gh) is not installed."
  echo "  Install with: brew install gh"
  echo "  Then sign in: gh auth login"
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "✖ Not signed into gh. Run: gh auth login"
  exit 1
fi
if [ ! -d "$DIST" ]; then
  echo "✖ No dist/ directory. Build the widget first:"
  echo "  ./build-mac.sh   # mac"
  echo "  ./build-win.cmd  # windows (run on a Windows box)"
  exit 1
fi

# ── Pick a tag ──────────────────────────────────────────────────────
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0)"
TAG="${1:-widget-v$VERSION}"
echo "▶ Publishing release tag: $TAG"

# Collect every distributable artifact (dmg + exe + zip).
ARTIFACTS=()
for f in "$DIST"/*.dmg "$DIST"/*.exe "$DIST"/*.zip; do
  [ -f "$f" ] && ARTIFACTS+=("$f")
done
if [ ${#ARTIFACTS[@]} -eq 0 ]; then
  echo "✖ No installer files found in $DIST"
  exit 1
fi
echo "▶ Found ${#ARTIFACTS[@]} artifact(s):"
for f in "${ARTIFACTS[@]}"; do
  printf '    %s (%s)\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)"
done

# ── Create or update the release ────────────────────────────────────
REPO_FLAGS=""
# Auto-detect repo from git remote so this works in forks.
if git remote get-url origin >/dev/null 2>&1; then
  ORIGIN="$(git remote get-url origin)"
  case "$ORIGIN" in
    *github.com*radsched*) ;;
    *) echo "  (Using auto-detected repo: $ORIGIN)" ;;
  esac
fi

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "▶ Release $TAG already exists — overwriting assets."
  gh release upload "$TAG" "${ARTIFACTS[@]}" --clobber
else
  echo "▶ Creating new release $TAG…"
  gh release create "$TAG" "${ARTIFACTS[@]}" \
    --title "RadScheduler Widget $VERSION" \
    --notes "Desktop widget v$VERSION. Downloads:
- macOS (Apple Silicon): RadScheduler Widget-${VERSION}-arm64.dmg
- macOS (Intel): RadScheduler Widget-${VERSION}.dmg
- Windows: RadScheduler Widget Setup ${VERSION}.exe

After installing, copy your pairing code (issued by your admin in
RadScheduler → Desktop Widget → Send install kit) and launch the app —
it auto-pairs from your clipboard."
fi

# ── Print the asset URLs ────────────────────────────────────────────
echo ""
echo "✓ Release published. Asset URLs (paste these into RadScheduler):"
echo ""
gh release view "$TAG" --json assets --jq '.assets[] | "  " + .name + "\n    " + .url'
echo ""
echo "Then in RadScheduler → 🖥 Desktop Widget → top of page,"
echo "paste the matching URLs into 'macOS download URL' and"
echo "'Windows download URL'. The 'Send install kit' button will"
echo "embed them into every physician's install email."
