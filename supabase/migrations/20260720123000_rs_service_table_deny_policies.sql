-- Server-only credential tables are accessed exclusively through vetted
-- SECURITY DEFINER RPCs and service-role Edge Functions. Grants were already
-- revoked; explicit deny policies add defense in depth and make that intent
-- machine-verifiable for database security advisors.

alter table public.rs_ingest_tokens enable row level security;
alter table public.rs_widget_secrets enable row level security;

drop policy if exists rs_ingest_tokens_deny_clients on public.rs_ingest_tokens;
create policy rs_ingest_tokens_deny_clients
  on public.rs_ingest_tokens
  for all
  to public
  using (false)
  with check (false);

drop policy if exists rs_widget_secrets_deny_clients on public.rs_widget_secrets;
create policy rs_widget_secrets_deny_clients
  on public.rs_widget_secrets
  for all
  to public
  using (false)
  with check (false);

revoke all on table public.rs_ingest_tokens from public, anon, authenticated;
revoke all on table public.rs_widget_secrets from public, anon, authenticated;
