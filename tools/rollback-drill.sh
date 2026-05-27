#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
LIVE_URL="${RS_PAGES_URL:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --live-url) LIVE_URL="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

extract_marker() {
  local file="$1" name="$2"
  sed -nE "s/.*const ${name} = ['\"]([^'\"]+)['\"].*/\\1/p" "$file" | head -n1
}

need git
need sed
need python3

HEAD_SHA="$(git rev-parse --short HEAD)"
BRANCH="$(git branch --show-current)"
HTML_BUILD="$(extract_marker index.html _RS_HTML_BUILD)"
HTML_SW="$(extract_marker index.html _SW_VERSION)"
SW_VERSION="$(extract_marker sw.js CACHE_VERSION)"

echo "Rollback drill preflight"
echo "branch: ${BRANCH:-detached}"
echo "head: $HEAD_SHA"
echo "html build: ${HTML_BUILD:-missing}"
echo "html sw: ${HTML_SW:-missing}"
echo "sw.js: ${SW_VERSION:-missing}"

if [[ -z "$HTML_BUILD" || -z "$HTML_SW" || -z "$SW_VERSION" || "$HTML_BUILD" != "$HTML_SW" || "$HTML_SW" != "$SW_VERSION" ]]; then
  echo "version markers are not aligned" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is dirty; rollback commands should start from a clean tree" >&2
  if [[ "$DRY_RUN" -eq 0 ]]; then exit 1; fi
fi

git ls-remote --exit-code --heads origin main >/dev/null

if [[ -n "$LIVE_URL" ]]; then
  need curl
  LIVE_URL="${LIVE_URL%/}"
  LIVE_SW="$(curl -fsSL "$LIVE_URL/sw.js" | sed -nE "s/.*const CACHE_VERSION = ['\"]([^'\"]+)['\"].*/\\1/p" | head -n1 || true)"
  LIVE_HTML="$(curl -fsSL "$LIVE_URL/index.html" | sed -nE "s/.*const _RS_HTML_BUILD = ['\"]([^'\"]+)['\"].*/\\1/p" | head -n1 || true)"
  echo "live html: ${LIVE_HTML:-missing}"
  echo "live sw: ${LIVE_SW:-missing}"
fi

cat <<'EOF'

Recovery drill steps:
1. Confirm the fault using Tools -> Logs & ops -> System health.
2. Preserve evidence: export Error log and Audit log CSV.
3. Restore app data first if data is wrong:
   - Tools -> Logs & ops -> Rollback timeline, or
   - Settings -> Backups -> restore the last known-good snapshot.
4. Restore code if the deploy is wrong:
   git revert --no-edit <bad_commit_sha>
   ./tools/precommit.sh
   git push origin main
5. Watch GitHub Pages:
   gh run list --branch main --event push --limit 3
   gh run watch <run_id> --exit-status
6. Verify live:
   curl -fsSL <app_url>/sw.js | grep CACHE_VERSION
   curl -fsSL <app_url>/index.html | grep _RS_HTML_BUILD
   Open Tools -> Logs & ops -> System health -> Run health check.

EOF

echo "dry-run: rollback drill preflight passed"
