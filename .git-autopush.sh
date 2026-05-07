#!/usr/bin/env bash
# RadScheduler — disk-watch GitHub autosync
#
# Watches index.html in the parent directory for changes; commits + pushes
# to the configured remote any time the file is modified. Debounces 3 sec
# so rapid successive saves cluster into one commit.
#
# Run from launchd (recommended) or manually for one-shot:
#   bash ~/RadApp/.git-autopush.sh
#
# Logs go to ~/Library/Logs/rs-autopush.{log,err}.
#
# Note: the project lives under ~/RadApp (NOT ~/Desktop/RadApp) so that
# launchd-launched bash isn't blocked by macOS Sequoia's TCC restrictions
# on the Desktop folder.

set -euo pipefail
REPO_DIR="${HOME}/RadApp"
WATCH_FILE="index.html"
DEBOUNCE_SECONDS=3
LOCK_FILE="${REPO_DIR}/.git-autopush.lock"

cd "${REPO_DIR}"

log(){ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Single-instance lock — portable PID-file approach (macOS doesn't ship
# `flock` from util-linux). If the lock file exists and the recorded PID
# is still running, exit. Otherwise claim the lock by writing our PID.
# The trap removes the lock on normal exit; stale locks from kill -9 are
# detected via `kill -0 <pid>` returning non-zero.
if [ -f "${LOCK_FILE}" ]; then
  OTHER_PID=$(cat "${LOCK_FILE}" 2>/dev/null || echo "")
  if [ -n "${OTHER_PID}" ] && kill -0 "${OTHER_PID}" 2>/dev/null; then
    log "another instance is already running (pid ${OTHER_PID}); exiting"
    exit 0
  fi
  log "stale lock from pid ${OTHER_PID:-?} — replacing"
fi
echo $$ > "${LOCK_FILE}"
trap 'rm -f "${LOCK_FILE}"' EXIT INT TERM

if ! command -v fswatch >/dev/null 2>&1; then
  log "ERROR: fswatch not installed — run: brew install fswatch"
  exit 1
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  log "ERROR: not a git repository — run: cd ${REPO_DIR} && git init"
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  log "ERROR: no 'origin' remote configured"
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
log "▶ Watching ${REPO_DIR}/${WATCH_FILE} → origin/${CURRENT_BRANCH}"

# fswatch outputs one line per change. -l 1 sets the latency to 1s so we
# don't fire on every micro-write of a save. Read in a loop with a debounce
# so a flurry of writes still produces one commit.
fswatch --one-per-batch --latency 1 "${WATCH_FILE}" | while read -r _; do
  sleep "${DEBOUNCE_SECONDS}"
  # fswatch's --one-per-batch already coalesces rapid successive writes
  # into a single line on the pipe, so an explicit drain loop isn't
  # needed (and `read -t 0.01` isn't reliable on macOS Bash 3.2 anyway).

  # Only push if the file actually differs from HEAD. fswatch fires on
  # touch / metadata-only changes too, which we want to ignore.
  if git diff --quiet HEAD -- "${WATCH_FILE}" 2>/dev/null; then
    log "  no content change — skipping"
    continue
  fi

  STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
  log "  detected change → committing"
  if git add "${WATCH_FILE}" \
     && git commit -m "rs: disk autosave ${STAMP}" >/dev/null 2>&1; then
    if git push origin "${CURRENT_BRANCH}" 2>&1; then
      log "  ✓ pushed to origin/${CURRENT_BRANCH}"
    else
      log "  ✗ push failed (check ~/Library/Logs/rs-autopush.err)"
    fi
  else
    log "  commit failed (likely no actual change after filter)"
  fi
done
