#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPABASE_URL="${RS_SUPABASE_URL:-${SUPABASE_URL:-}}"

if [ -z "$SUPABASE_URL" ]; then
  SUPABASE_URL="$(node - "$ROOT/index.html" <<'NODE'
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const match = html.match(/const\s+_SUPABASE_URL\s*=\s*\/\*CREDS_URL_START\*\/\s*['"]([^'"]+)['"]/);
process.stdout.write(match ? match[1] : '');
NODE
)"
fi

if [ -z "$SUPABASE_URL" ] || ! printf '%s' "$SUPABASE_URL" | grep -Eq '^https://[^/]+\.supabase\.(co|in)$'; then
  echo "Missing or invalid Supabase URL. Set RS_SUPABASE_URL=https://your-project.supabase.co" >&2
  exit 1
fi

SUPABASE_URL="${SUPABASE_URL%/}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

FAIL=0

probe() {
  local name="$1"
  local method="$2"
  local allowed="$3"
  local url="$SUPABASE_URL/functions/v1/$name"
  local curl_args=(-sS -m 12 -o "$TMP" -w '%{http_code}' -X "$method")
  if [ "$method" != "GET" ]; then
    curl_args+=(-H 'Content-Type: application/json' --data '{}')
  fi
  local status
  status="$(curl "${curl_args[@]}" "$url" || true)"
  if printf ',%s,' "$allowed" | grep -q ",$status,"; then
    echo "OK   $name returned HTTP $status"
  else
    echo "FAIL $name returned HTTP $status; expected one of: $allowed" >&2
    if [ -s "$TMP" ]; then
      head -c 500 "$TMP" >&2
      echo >&2
    fi
    FAIL=1
  fi
}

echo "Probing edge functions at $SUPABASE_URL"
probe create-user POST "200,400,401,403,405"
probe send-notification POST "200,400,401,403,405"
probe widget-data GET "200,400,401,403,405"
probe calendar-feed GET "200,400,401,403,405"
probe maps-proxy POST "200,400,401,403,405"
probe ai-proxy POST "200,400,401,403,405"

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "Edge function monitor passed"
