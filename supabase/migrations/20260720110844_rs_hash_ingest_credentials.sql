-- Store PACS ingest credentials as one-way hashes. A database read must not
-- turn into immediate write access to every practice's report-ingest API.
alter table public.rs_ingest_tokens
  add column if not exists token_hash text,
  add column if not exists token_hint text;

update public.rs_ingest_tokens
   set token_hash = encode(extensions.digest(token, 'sha256'), 'hex'),
       token_hint = right(token, 6)
 where token_hash is null
   and token is not null;

alter table public.rs_ingest_tokens
  alter column token drop not null,
  alter column token drop default;

update public.rs_ingest_tokens set token = null where token_hash is not null;

alter table public.rs_ingest_tokens
  alter column token_hash set not null;

create unique index if not exists rs_ingest_tokens_token_hash
  on public.rs_ingest_tokens(token_hash);

-- Existing secrets can only be identified by their final characters. The
-- complete token is returned exactly once by rotate and must be copied to the
-- PACS/RIS at that time.
create or replace function public.rs_ingest_token_get(p_practice text)
returns text
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare v_hint text;
begin
  if not (radscheduler_admin_aal2() or radscheduler_admin_same_practice(p_practice)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select token_hint into v_hint
    from public.rs_ingest_tokens
   where practice_id = p_practice;
  return case when v_hint is null then null else 'configured:••••••' || v_hint end;
end;
$function$;

create or replace function public.rs_ingest_token_rotate(p_practice text)
returns text
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare v_token text := 'pit_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not (radscheduler_admin_aal2() or radscheduler_admin_same_practice(p_practice)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.rs_ingest_tokens (practice_id, token, token_hash, token_hint, created_at, last_used_at)
    values (
      p_practice,
      null,
      encode(extensions.digest(v_token, 'sha256'), 'hex'),
      right(v_token, 6),
      now(),
      null
    )
    on conflict (practice_id) do update
      set token = null,
          token_hash = excluded.token_hash,
          token_hint = excluded.token_hint,
          created_at = now(),
          last_used_at = null;
  return v_token;
end;
$function$;

revoke all on function public.rs_ingest_token_get(text) from public, anon;
revoke all on function public.rs_ingest_token_rotate(text) from public, anon;
grant execute on function public.rs_ingest_token_get(text) to authenticated;
grant execute on function public.rs_ingest_token_rotate(text) to authenticated;

-- Remove browser-supplied vendor keys from client-readable practice blobs.
-- The Maps proxy may use a browser-local key or its server environment secret,
-- but shared schedule state must never act as a credential store.
update public.radscheduler
   set data = ((data::jsonb #- '{cfg,mapsKey}' #- '{cfg,gmapsKey}')::text)
 where ((data::jsonb #> '{cfg}') ? 'mapsKey')
    or ((data::jsonb #> '{cfg}') ? 'gmapsKey');
