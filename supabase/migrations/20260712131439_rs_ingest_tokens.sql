-- Per-practice ingest credential. The admin issues one and hands it to the PACS
-- vendor's outbound config; the pacs-ingest edge function validates the Bearer
-- token against it AND derives the practice from it (never trusts a body-supplied
-- practice_id). Service-role only — never readable by clients.
create table if not exists public.rs_ingest_tokens (
  practice_id text primary key,
  token       text not null unique,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists rs_ingest_tokens_token on public.rs_ingest_tokens(token);
alter table public.rs_ingest_tokens enable row level security;
-- No policies granted to authenticated → only the service role (edge functions,
-- admin API) can read/write. A client cannot exfiltrate another practice's token.
revoke all on public.rs_ingest_tokens from authenticated, anon;;
