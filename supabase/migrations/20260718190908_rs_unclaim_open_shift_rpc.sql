-- Secure server-side unclaim (symmetric to rs_claim_open_shift). Only the
-- claimant (or an admin) may unclaim; removes the materialized shift(s) + the
-- auto-paired IR shift, clears the claim, atomically under a row lock.
create or replace function public.rs_unclaim_open_shift(p_practice text, p_oid bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_blob jsonb; v_caller_pid integer; v_is_admin boolean;
  v_open jsonb; v_idx int; v_claimed integer; v_date text;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_oid is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;

  select (u->>'physId')::int into v_caller_pid
  from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
  where (u->>'id')=(auth.uid())::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  v_is_admin := coalesce(radscheduler_admin_aal2(), false);

  select value, (ordinality-1)::int into v_open, v_idx
  from jsonb_array_elements(coalesce(v_blob->'openShifts','[]'::jsonb)) with ordinality
  where (value->>'id')::bigint = p_oid limit 1;
  if v_open is null then return jsonb_build_object('ok',false,'error','open shift not found'); end if;
  if coalesce(v_open->>'claimedBy','')='' then return jsonb_build_object('ok',false,'error','not claimed'); end if;
  v_claimed := (v_open->>'claimedBy')::int;
  v_date := v_open->>'date';
  if not v_is_admin and (v_caller_pid is null or v_caller_pid <> v_claimed) then
    return jsonb_build_object('ok',false,'error','you can only unclaim your own shift');
  end if;

  v_blob := jsonb_set(v_blob,'{drShifts}', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(v_blob->'drShifts','[]'::jsonb)) s
    where not ((s->>'physId')::int=v_claimed and s->>'date'=v_date and s->>'notes'='Claimed')), '[]'::jsonb));
  v_blob := jsonb_set(v_blob,'{irCalls}', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(v_blob->'irCalls','[]'::jsonb)) s
    where not ((s->>'physId')::int=v_claimed and s->>'date'=v_date and s->>'notes'='Claimed')), '[]'::jsonb));
  v_blob := jsonb_set(v_blob,'{weekendCalls}', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(v_blob->'weekendCalls','[]'::jsonb)) s
    where not ((s->>'physId')::int=v_claimed and (s->>'satDate'=v_date or s->>'date'=v_date) and s->>'notes'='Claimed')), '[]'::jsonb));
  v_blob := jsonb_set(v_blob,'{irShifts}', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(v_blob->'irShifts','[]'::jsonb)) s
    where not ((s->>'physId')::int=v_claimed and s->>'date'=v_date and (s->>'notes') like 'Auto-paired with IR call%')), '[]'::jsonb));

  v_blob := jsonb_set(v_blob, array['openShifts',v_idx::text,'claimedBy'], 'null'::jsonb);
  v_blob := jsonb_set(v_blob, array['openShifts',v_idx::text,'claimedAt'], 'null'::jsonb);
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'oid',p_oid,'pid',v_claimed);
end $$;
revoke all on function public.rs_unclaim_open_shift(text,bigint) from public, anon;
grant execute on function public.rs_unclaim_open_shift(text,bigint) to authenticated;;
