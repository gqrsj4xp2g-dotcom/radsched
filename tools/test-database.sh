#!/usr/bin/env bash
# Requires Docker and the Supabase CLI (2.101.0 in CI).
# Uses an empty local Supabase project so Auth, pg_cron, roles and the
# Realtime publication match production prerequisites.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
docker info >/dev/null
command -v supabase >/dev/null
scratch=$(mktemp -d "${TMPDIR:-/tmp}/radsched-db-XXXXXX")
project=$(basename "$scratch" | tr '[:upper:]' '[:lower:]')
export SUPABASE_TELEMETRY_DISABLED=1

cleanup() {
  supabase stop --workdir "$scratch" --no-backup >/dev/null || true
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir -p "$scratch/supabase"
sed "s/^project_id = .*/project_id = \"$project\"/" "$repo/supabase/config.toml" > "$scratch/supabase/config.toml"

# Start the upstream services before copying migrations. Some historical cron
# schedules include real URLs. Disable the pg_cron worker's job execution
# first, while allowing the real scheduling functions and tables to be tested.
supabase start --workdir "$scratch" -x analytics,edge-runtime,imgproxy,inbucket,meta,studio,vector
psql_local() {
  # The Supabase image requires a password even on its local socket.
  # Resolve it inside the disposable container so it never appears in CI logs.
  docker exec -i "supabase_db_$project" sh -eu -c '
    export PGPASSWORD="${POSTGRES_PASSWORD:?local database password missing}"
    exec psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres "$@"
  ' sh "$@"
}
psql_local <<'SQL'
create extension if not exists pg_cron;
alter system set cron.launch_active_jobs = off;
select pg_reload_conf();
SQL
for attempt in 1 2 3 4 5; do
  if [[ $(psql_local -Atc 'show cron.launch_active_jobs') == off ]]; then break; fi
  sleep 1
done
[[ $(psql_local -Atc 'show cron.launch_active_jobs') == off ]]

# Rehearse the private-chat cutover against actual legacy practice/backup rows.
# In each phase the Supabase migration runner tracks the version normally.
cutover_files=("$repo"/supabase/migrations/*_private_chat.sql)
[[ ${#cutover_files[@]} -eq 1 && -f ${cutover_files[0]} ]]
cutover=${cutover_files[0]##*/}
mkdir -p "$scratch/supabase/migrations"
[[ -f "$repo/supabase/migrations/$cutover" ]]
for migration in "$repo"/supabase/migrations/*.sql; do
  if [[ ${migration##*/} < $cutover ]]; then
    cp "$migration" "$scratch/supabase/migrations/"
  fi
done
supabase migration up --workdir "$scratch" --local
psql_local < "$repo/supabase/tests/fixtures/pre-private-chat.sql"
cp "$repo/supabase/migrations/$cutover" "$scratch/supabase/migrations/"
supabase migration up --workdir "$scratch" --local
psql_local < "$repo/supabase/tests/fixtures/post-private-chat.sql"

# Pick up future migrations after the cutover as part of the regular replay.
cp "$repo"/supabase/migrations/*.sql "$scratch/supabase/migrations/"
cp -R "$repo/supabase/tests" "$scratch/supabase/"
supabase migration up --workdir "$scratch" --local
# Make test discovery explicit so a missing or renamed suite cannot silently pass.
(
  cd "$scratch"
  shopt -s nullglob
  tests=(supabase/tests/database/*.test.sql)
  if [[ ${#tests[@]} -eq 0 ]]; then
    echo "No database regression tests found." >&2
    exit 1
  fi
  supabase test db --local "${tests[@]}"
)
