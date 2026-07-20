-- Give the ingest token a server-side default so it is never client-generated.
alter table public.rs_ingest_tokens
  alter column token set default ('pit_' || encode(gen_random_bytes(24), 'hex'));

-- Admin-only accessor RPCs (SECURITY DEFINER — the table itself stays
-- service-role-locked with no authenticated RLS grants). Each RPC enforces
-- "caller is an AAL2 admin whose JWT practiceId matches the requested practice"
-- before touching the row. Returns the practice's ingest bearer token.
create or replace function public.rs_ingest_token_get(p_practice text)
returns text
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare v_token text;
begin
  if not (radscheduler_admin_aal2() and radscheduler_non_admin_same_practice(p_practice)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.rs_ingest_tokens (practice_id)
    values (p_practice)
    on conflict (practice_id) do nothing;
  select token into v_token from public.rs_ingest_tokens where practice_id = p_practice;
  return v_token;
end;
$$;

create or replace function public.rs_ingest_token_rotate(p_practice text)
returns text
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare v_token text;
begin
  if not (radscheduler_admin_aal2() and radscheduler_non_admin_same_practice(p_practice)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.rs_ingest_tokens (practice_id, token)
    values (p_practice, 'pit_' || encode(gen_random_bytes(24), 'hex'))
    on conflict (practice_id)
      do update set token = 'pit_' || encode(gen_random_bytes(24), 'hex'),
                    created_at = now(), last_used_at = null;
  select token into v_token from public.rs_ingest_tokens where practice_id = p_practice;
  return v_token;
end;
$$;

revoke all on function public.rs_ingest_token_get(text)    from public, anon;
revoke all on function public.rs_ingest_token_rotate(text) from public, anon;
grant execute on function public.rs_ingest_token_get(text)    to authenticated;
grant execute on function public.rs_ingest_token_rotate(text) to authenticated;

-- Live updates: broadcast row changes to same-practice authenticated clients
-- (realtime honors the SELECT RLS on these tables).
alter publication supabase_realtime add table public.rs_reports;
alter publication supabase_realtime add table public.rs_peer_reviews;;
