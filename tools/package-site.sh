#!/usr/bin/env bash
# This directory is the deployable artifact on both Pages and Vercel.
set -euo pipefail
cd "$(dirname "$0")/.."
bash tools/build-index.sh --check
node tools/check-public-shell.js index.html

stage=$(mktemp -d ./_site-build.XXXXXXXX)
trap 'rm -rf "$stage"' EXIT
cp index.html 404.html reset.html manifest.webmanifest robots.txt sw.js _headers "$stage/"
cp -R icons vendor "$stage/"
for entry in edge-functions/send-notification/index.ts supabase/functions/{create-user,admin-ops}/index.ts; do
  mkdir -p "$stage/$(dirname "$entry")"
  cp "$entry" "$stage/$entry"
done
RAD_PACKAGE_DIR="$stage" node --test tests/unit/release-entrypoints.test.js
rm -rf _site
mv "$stage" _site
