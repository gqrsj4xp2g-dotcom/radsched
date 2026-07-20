-- Secure server-side accept of a marketplace listing claim (seller reassigns
-- their shift to a claimant). Only the seller (or admin) may accept. Mirrors the
-- client acceptClaim: reassigns dr/ir/irc/wk, and for a daily IR call moves the
-- auto-paired IR day shift to the claimant. Returns data for client notifications.
create or replace function public.rs_accept_listing_claim(p_practice text, p_listing_id bigint, p_claim_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_blob jsonb; v_caller_pid integer; v_is_admin boolean;
  v_listing jsonb; v_lidx int; v_seller integer; v_status text;
  v_claim jsonb; v_claimant integer; v_cphys jsonb; v_irgroup text; v_irsiteprim text;
  v_kind text; v_shiftid bigint; v_sdate text; v_ssite text; v_sshift text;
  v_arr text; v_sidx int; v_spid integer; v_snotes text; v_calltype text;
  v_reassigned boolean := false; v_others jsonb; v_nextid bigint; v_resolved_site text;
  v_dr_conflict boolean; v_we_conflict boolean; v_has_ir boolean;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_listing_id is null or p_claim_id is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;

  select (u->>'physId')::int into v_caller_pid
  from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
  where (u->>'id')=(auth.uid())::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  v_is_admin := coalesce(radscheduler_admin_aal2(), false);

  select value,(ordinality-1)::int into v_listing,v_lidx
  from jsonb_array_elements(coalesce(v_blob->'shiftListings','[]'::jsonb)) with ordinality
  where (value->>'id')::bigint=p_listing_id limit 1;
  if v_listing is null then return jsonb_build_object('ok',false,'error','listing not found'); end if;
  v_seller := (v_listing->>'sellerPhysId')::int;
  v_status := coalesce(v_listing->>'status','');
  if not v_is_admin and (v_caller_pid is null or v_caller_pid <> v_seller) then
    return jsonb_build_object('ok',false,'error','only the seller can accept claims on this listing'); end if;
  if v_status <> 'open' then return jsonb_build_object('ok',false,'error','this listing is no longer open'); end if;

  select value into v_claim from jsonb_array_elements(coalesce(v_listing->'claims','[]'::jsonb)) value
  where (value->>'id')::bigint=p_claim_id limit 1;
  if v_claim is null then return jsonb_build_object('ok',false,'error','claim not found'); end if;
  v_claimant := (v_claim->>'claimantPhysId')::int;

  v_kind := coalesce(v_listing->'shift'->>'kind','dr');
  v_shiftid := (v_listing->'shift'->>'id')::bigint;
  v_sdate := v_listing->'shift'->>'date';
  v_ssite := coalesce(v_listing->'shift'->>'site','');
  v_sshift := coalesce(v_listing->'shift'->>'shift','');
  select value into v_cphys from jsonb_array_elements(coalesce(v_blob->'physicians','[]'::jsonb)) value where (value->>'id')::int=v_claimant limit 1;
  v_irgroup := coalesce(v_cphys->>'irGroup',''); v_irsiteprim := coalesce(v_cphys->>'irSitePrim','');

  v_arr := case v_kind when 'dr' then 'drShifts' when 'ir' then 'irShifts' when 'irc' then 'irCalls' when 'wk' then 'weekendCalls' else null end;
  if v_arr is not null then
    select (ordinality-1)::int, (value->>'physId')::int, (value->>'notes'), (value->>'callType')
      into v_sidx, v_spid, v_snotes, v_calltype
    from jsonb_array_elements(coalesce(v_blob->v_arr,'[]'::jsonb)) with ordinality where (value->>'id')::bigint=v_shiftid limit 1;
    if v_sidx is not null and v_spid = v_seller then
      v_blob := jsonb_set(v_blob, array[v_arr,v_sidx::text,'physId'], to_jsonb(v_claimant));
      v_blob := jsonb_set(v_blob, array[v_arr,v_sidx::text,'notes'], to_jsonb((case when coalesce(v_snotes,'')<>'' then v_snotes||' ' else '' end)||'[marketplace]'));
      v_reassigned := true;
      if v_kind='irc' then
        if v_irgroup<>'' then v_blob := jsonb_set(v_blob, array['irCalls',v_sidx::text,'irGroup'], to_jsonb(v_irgroup)); end if;
        if coalesce(v_calltype,'')='daily' then
          -- remove seller's auto-paired IR day shift
          v_blob := jsonb_set(v_blob,'{irShifts}', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(v_blob->'irShifts','[]'::jsonb)) s
            where not ((s->>'physId')::int=v_seller and s->>'date'=v_sdate and (s->>'notes') like 'Auto-paired with IR call%')), '[]'::jsonb));
          -- add claimant's auto-pair (mirror _ensureIRShiftForCall guards)
          v_has_ir := exists(select 1 from jsonb_array_elements(coalesce(v_blob->'irShifts','[]'::jsonb)) s where (s->>'physId')::int=v_claimant and s->>'date'=v_sdate);
          v_dr_conflict := exists(select 1 from jsonb_array_elements(coalesce(v_blob->'drShifts','[]'::jsonb)) s where (s->>'physId')::int=v_claimant and s->>'date'=v_sdate and coalesce(s->>'shift','')<>'Home');
          v_we_conflict := exists(select 1 from jsonb_array_elements(coalesce(v_blob->'weekendCalls','[]'::jsonb)) w where (w->>'physId')::int=v_claimant and (w->>'satDate'=v_sdate or w->>'sunDate'=v_sdate or w->>'date'=v_sdate));
          if not v_has_ir and not v_dr_conflict and not v_we_conflict then
            v_nextid := coalesce((v_blob->>'nextId')::bigint,1);
            v_resolved_site := coalesce(nullif(v_ssite,''), nullif(v_irsiteprim,''), 'At Home / Remote');
            v_blob := jsonb_set(v_blob,'{irShifts}', coalesce(v_blob->'irShifts','[]'::jsonb) ||
              jsonb_build_object('id',v_nextid,'physId',v_claimant,'date',v_sdate,'shift','1st','site',v_resolved_site,'sub','','notes','Auto-paired with IR call (marketplace)','irGroup',v_irgroup));
            v_blob := jsonb_set(v_blob,'{nextId}', to_jsonb(v_nextid+1));
          end if;
        end if;
      end if;
    end if;
  end if;

  v_blob := jsonb_set(v_blob, array['shiftListings',v_lidx::text,'status'], '"completed"'::jsonb);
  v_blob := jsonb_set(v_blob, array['shiftListings',v_lidx::text,'acceptedClaimId'], to_jsonb(p_claim_id));
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;

  select coalesce(jsonb_agg((c->>'claimantPhysId')::int), '[]'::jsonb) into v_others
  from jsonb_array_elements(coalesce(v_listing->'claims','[]'::jsonb)) c where (c->>'id')::bigint <> p_claim_id;

  return jsonb_build_object('ok',true,'reassigned',v_reassigned,'claimantPid',v_claimant,'sellerPid',v_seller,
    'kind',v_kind,'date',v_sdate,'site',v_ssite,'shift',v_sshift,'others',v_others);
end $$;
revoke all on function public.rs_accept_listing_claim(text,bigint,bigint) from public, anon;
grant execute on function public.rs_accept_listing_claim(text,bigint,bigint) to authenticated;;
