-- Marketplace create/cancel writes → SECURITY DEFINER RPCs. Identity (seller /
-- claimant / offerer) is pinned to the caller's roster physId (auth.uid) so it
-- can't be forged; owner checks added. Atomic (row lock). Return created object.

-- helper-ish inline: each fn resolves v_caller_pid from users[] by auth.uid.

create or replace function public.rs_create_shift_listing(p_practice text, p_kind text, p_shift_id bigint, p_note text)
returns jsonb language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_blob jsonb; v_cp integer; v_arr text; v_shift jsonb; v_meta jsonb; v_nid bigint; v_listing jsonb;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_cp from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=(auth.uid())::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  if v_cp is null then return jsonb_build_object('ok',false,'error','not linked to a physician'); end if;
  v_arr := case p_kind when 'dr' then 'drShifts' when 'ir' then 'irShifts' when 'irc' then 'irCalls' when 'wk' then 'weekendCalls' else null end;
  if v_arr is null then return jsonb_build_object('ok',false,'error','unknown shift kind'); end if;
  select value into v_shift from jsonb_array_elements(coalesce(v_blob->v_arr,'[]'::jsonb)) value where (value->>'id')::bigint=p_shift_id limit 1;
  if v_shift is null then return jsonb_build_object('ok',false,'error','shift not found — may have been reassigned'); end if;
  if (v_shift->>'physId')::int is distinct from v_cp then return jsonb_build_object('ok',false,'error','that shift is not yours to list'); end if;
  if exists(select 1 from jsonb_array_elements(coalesce(v_blob->'shiftListings','[]'::jsonb)) l
      where l->>'status'='open' and l->'shift'->>'kind'=p_kind and (l->'shift'->>'id')::bigint=p_shift_id) then
    return jsonb_build_object('ok',false,'error','this shift is already listed for sale'); end if;
  v_meta := case p_kind
    when 'dr' then jsonb_build_object('kind','dr','id',p_shift_id,'date',v_shift->>'date','shift',v_shift->>'shift','site',v_shift->>'site','sub',coalesce(v_shift->>'sub',''))
    when 'ir' then jsonb_build_object('kind','ir','id',p_shift_id,'date',v_shift->>'date','shift',coalesce(nullif(v_shift->>'shift',''),'1st'),'site',v_shift->>'site','sub',coalesce(v_shift->>'sub',''))
    when 'irc' then jsonb_build_object('kind','irc','id',p_shift_id,'date',v_shift->>'date','shift','IR Call','site',coalesce(v_shift->>'site',''),'callType',coalesce(nullif(v_shift->>'callType',''),'daily'))
    when 'wk' then jsonb_build_object('kind','wk','id',p_shift_id,'date',v_shift->>'satDate','shift','Weekend Call','sub',coalesce(v_shift->>'sub',''),'satDate',v_shift->>'satDate','sunDate',v_shift->>'sunDate')
  end;
  v_nid := coalesce((v_blob->>'nextId')::bigint,1);
  v_listing := jsonb_build_object('id',v_nid,'sellerPhysId',v_cp,'shift',v_meta,'note',left(coalesce(p_note,''),500),'ts',v_now,'status','open','claims','[]'::jsonb,'acceptedClaimId',null);
  v_blob := jsonb_set(v_blob,'{shiftListings}', coalesce(v_blob->'shiftListings','[]'::jsonb) || v_listing);
  v_blob := jsonb_set(v_blob,'{nextId}', to_jsonb(v_nid+1));
  v_blob := jsonb_set(v_blob,'{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'listing',v_listing);
end $$;

create or replace function public.rs_request_listing_claim(p_practice text, p_listing_id bigint, p_message text)
returns jsonb language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_blob jsonb; v_cp integer; v_listing jsonb; v_lidx int; v_nid bigint; v_claim jsonb;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_cp from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=(auth.uid())::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  if v_cp is null then return jsonb_build_object('ok',false,'error','not linked to a physician'); end if;
  select value,(ordinality-1)::int into v_listing,v_lidx from jsonb_array_elements(coalesce(v_blob->'shiftListings','[]'::jsonb)) with ordinality where (value->>'id')::bigint=p_listing_id limit 1;
  if v_listing is null then return jsonb_build_object('ok',false,'error','listing not found'); end if;
  if coalesce(v_listing->>'status','')<>'open' then return jsonb_build_object('ok',false,'error','this listing is no longer open'); end if;
  if (v_listing->>'sellerPhysId')::int = v_cp then return jsonb_build_object('ok',false,'error','you cannot claim your own listing'); end if;
  if exists(select 1 from jsonb_array_elements(coalesce(v_listing->'claims','[]'::jsonb)) c where (c->>'claimantPhysId')::int=v_cp) then
    return jsonb_build_object('ok',false,'error','you have already claimed this shift'); end if;
  v_nid := coalesce((v_blob->>'nextId')::bigint,1);
  v_claim := jsonb_build_object('id',v_nid,'claimantPhysId',v_cp,'message',left(coalesce(p_message,''),500),'ts',v_now);
  v_blob := jsonb_set(v_blob, array['shiftListings',v_lidx::text,'claims'], coalesce(v_listing->'claims','[]'::jsonb) || v_claim);
  v_blob := jsonb_set(v_blob,'{nextId}', to_jsonb(v_nid+1));
  v_blob := jsonb_set(v_blob,'{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'claim',v_claim,'sellerPid',(v_listing->>'sellerPhysId')::int);
end $$;

create or replace function public.rs_cancel_shift_listing(p_practice text, p_listing_id bigint)
returns jsonb language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_blob jsonb; v_cp integer; v_is_admin boolean; v_listing jsonb; v_lidx int;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_cp from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=(auth.uid())::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  v_is_admin := coalesce(radscheduler_admin_aal2(),false);
  select value,(ordinality-1)::int into v_listing,v_lidx from jsonb_array_elements(coalesce(v_blob->'shiftListings','[]'::jsonb)) with ordinality where (value->>'id')::bigint=p_listing_id limit 1;
  if v_listing is null then return jsonb_build_object('ok',false,'error','listing not found'); end if;
  if not v_is_admin and (v_cp is null or (v_listing->>'sellerPhysId')::int<>v_cp) then return jsonb_build_object('ok',false,'error','only the seller can cancel their listing'); end if;
  if coalesce(v_listing->>'status','')<>'open' then return jsonb_build_object('ok',false,'error','this listing is no longer open'); end if;
  v_blob := jsonb_set(v_blob, array['shiftListings',v_lidx::text,'status'], '"cancelled"'::jsonb);
  v_blob := jsonb_set(v_blob,'{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.rs_offer_shift(p_practice text, p_kind text, p_shift_id bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_blob jsonb; v_cp integer; v_arr text; v_shift jsonb; v_nid bigint; v_offer jsonb;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_cp from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=(auth.uid())::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  if v_cp is null then return jsonb_build_object('ok',false,'error','not linked to a physician'); end if;
  v_arr := case p_kind when 'dr' then 'drShifts' when 'ir' then 'irShifts' else null end;
  if v_arr is null then return jsonb_build_object('ok',false,'error','unknown shift kind'); end if;
  select value into v_shift from jsonb_array_elements(coalesce(v_blob->v_arr,'[]'::jsonb)) value where (value->>'id')::bigint=p_shift_id limit 1;
  if v_shift is null then return jsonb_build_object('ok',false,'error','shift not found'); end if;
  if (v_shift->>'physId')::int is distinct from v_cp then return jsonb_build_object('ok',false,'error','that shift is not yours to offer'); end if;
  if exists(select 1 from jsonb_array_elements(coalesce(v_blob->'shiftOffers','[]'::jsonb)) o
      where o->>'kind'=p_kind and (o->>'shiftId')::bigint=p_shift_id and coalesce(o->>'claimedBy','')='' and not coalesce((o->>'cancelled')::boolean,false)) then
    return jsonb_build_object('ok',false,'error','this shift is already on the marketplace'); end if;
  v_nid := coalesce((v_blob->>'nextId')::bigint,1);
  v_offer := jsonb_build_object('id',v_nid,'kind',p_kind,'shiftId',p_shift_id,'fromPhysId',v_cp,'date',v_shift->>'date',
    'shift',coalesce(v_shift->>'shift',''),'site',coalesce(v_shift->>'site',''),'sub',coalesce(v_shift->>'sub',''),
    'shiftLabel',(case when p_kind='ir' then 'IR ' else '' end)||coalesce(v_shift->>'shift',''),
    'reason',left(coalesce(p_reason,''),200),'postedAt',v_now,'claimedBy',null,'claimedAt',null,'cancelled',false);
  v_blob := jsonb_set(v_blob,'{shiftOffers}', coalesce(v_blob->'shiftOffers','[]'::jsonb) || v_offer);
  v_blob := jsonb_set(v_blob,'{nextId}', to_jsonb(v_nid+1));
  v_blob := jsonb_set(v_blob,'{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'offer',v_offer);
end $$;

create or replace function public.rs_cancel_shift_offer(p_practice text, p_offer_id bigint)
returns jsonb language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_blob jsonb; v_cp integer; v_is_admin boolean; v_offer jsonb; v_oidx int;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_cp from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=(auth.uid())::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  v_is_admin := coalesce(radscheduler_admin_aal2(),false);
  select value,(ordinality-1)::int into v_offer,v_oidx from jsonb_array_elements(coalesce(v_blob->'shiftOffers','[]'::jsonb)) with ordinality where (value->>'id')::bigint=p_offer_id limit 1;
  if v_offer is null then return jsonb_build_object('ok',false,'error','offer not found'); end if;
  if coalesce(v_offer->>'claimedBy','')<>'' then return jsonb_build_object('ok',false,'error','offer already claimed'); end if;
  if not v_is_admin and (v_cp is null or (v_offer->>'fromPhysId')::int<>v_cp) then return jsonb_build_object('ok',false,'error','only the offerer can withdraw this offer'); end if;
  v_blob := jsonb_set(v_blob, array['shiftOffers',v_oidx::text,'cancelled'], 'true'::jsonb);
  v_blob := jsonb_set(v_blob,'{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true);
end $$;

revoke all on function public.rs_create_shift_listing(text,text,bigint,text) from public, anon;
revoke all on function public.rs_request_listing_claim(text,bigint,text) from public, anon;
revoke all on function public.rs_cancel_shift_listing(text,bigint) from public, anon;
revoke all on function public.rs_offer_shift(text,text,bigint,text) from public, anon;
revoke all on function public.rs_cancel_shift_offer(text,bigint) from public, anon;
grant execute on function public.rs_create_shift_listing(text,text,bigint,text) to authenticated;
grant execute on function public.rs_request_listing_claim(text,bigint,text) to authenticated;
grant execute on function public.rs_cancel_shift_listing(text,bigint) to authenticated;
grant execute on function public.rs_offer_shift(text,text,bigint,text) to authenticated;
grant execute on function public.rs_cancel_shift_offer(text,bigint) to authenticated;;
