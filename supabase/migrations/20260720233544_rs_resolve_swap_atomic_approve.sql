-- rs_resolve_swap v3: the APPROVE leg now reassigns the shifts server-side in
-- the SAME transaction as the status commit — previously the table said
-- 'approved' while the shift moves rode a separate client blob push that could
-- fail or die with the tab, leaving two unreconciled stores. Mirrors the
-- client's moveAssignments: both legs, all four assignment collections
-- (drShifts/irShifts/irCalls/weekendCalls), '[swap-approved]' note tag.
CREATE OR REPLACE FUNCTION public.rs_resolve_swap(p_practice text, p_client_id bigint, p_status text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_count int; v_current text;
  v_from int; v_to int; v_date text; v_theirdate text;
  v_moved int := 0; v_moved_back int := 0;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  k text; arr jsonb; newarr jsonb; n int;
begin
  if p_practice is null or p_client_id is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  if p_status not in ('approved','denied') then return jsonb_build_object('ok',false,'error','bad status'); end if;
  if not coalesce(radscheduler_admin_same_practice(p_practice), false) then
    return jsonb_build_object('ok',false,'error','admin only'); end if;

  -- Lock the blob FIRST so status commit + shift reassignment are one atomic unit.
  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;

  update public.rs_swap_requests set status = p_status
   where practice_id = p_practice and client_id = p_client_id and status = 'pending'
   returning from_phys_id, to_phys_id, coalesce(shift_date,''), coalesce(their_date,'')
   into v_from, v_to, v_date, v_theirdate;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    select status into v_current from public.rs_swap_requests
     where practice_id = p_practice and client_id = p_client_id;
    if v_current is null then return jsonb_build_object('ok',false,'error','swap not found'); end if;
    return jsonb_build_object('ok',false,'error','swap already '||v_current,'status',v_current);
  end if;

  if p_status = 'approved' and v_blob is not null and v_from is not null and v_to is not null then
    -- Leg 1: fromPhys → toPhys on v_date; Leg 2 (two-sided): toPhys → fromPhys
    -- on v_theirdate. Weekend calls match satDate/sunDate/date; others match date.
    for k in select unnest(array['drShifts','irShifts','irCalls','weekendCalls']) loop
      arr := coalesce(v_blob->k, '[]'::jsonb);
      if jsonb_typeof(arr) <> 'array' then continue; end if;
      select coalesce(jsonb_agg(
               case when hit1 or hit2 then
                 e || jsonb_build_object(
                   'physId', case when hit1 then v_to else v_from end,
                   'notes', btrim(coalesce(e->>'notes','') || ' [swap-approved]'))
               else e end order by ord),'[]'::jsonb),
             count(*) filter (where hit1 or hit2)
        into newarr, n
        from (
          select e, ord,
            (v_date <> '' and (e->>'physId') = v_from::text and
             case when k='weekendCalls'
                  then (e->>'satDate' = v_date or e->>'sunDate' = v_date or e->>'date' = v_date)
                  else e->>'date' = v_date end) as hit1,
            (v_theirdate <> '' and (e->>'physId') = v_to::text and
             case when k='weekendCalls'
                  then (e->>'satDate' = v_theirdate or e->>'sunDate' = v_theirdate or e->>'date' = v_theirdate)
                  else e->>'date' = v_theirdate end) as hit2
          from jsonb_array_elements(arr) with ordinality t(e, ord)
        ) q;
      if n > 0 then
        v_blob := jsonb_set(v_blob, array[k], newarr);
        v_moved := v_moved + (select count(*) from jsonb_array_elements(newarr) e
          where (e->>'physId') = v_to::text and e->>'notes' like '%[swap-approved]%');
      end if;
    end loop;
    -- Recompute per-leg counts precisely (the loop total above overcounts on
    -- repeat approvals of other swaps; derive from the hit flags instead).
    v_moved := 0; v_moved_back := 0;
    for k in select unnest(array['drShifts','irShifts','irCalls','weekendCalls']) loop
      arr := coalesce(v_blob->k, '[]'::jsonb);
      if jsonb_typeof(arr) <> 'array' then continue; end if;
      select v_moved + count(*) filter (where v_date <> '' and (e->>'physId') = v_to::text and
               case when k='weekendCalls' then (e->>'satDate'=v_date or e->>'sunDate'=v_date or e->>'date'=v_date)
                    else e->>'date'=v_date end and e->>'notes' like '%[swap-approved]%'),
             v_moved_back + count(*) filter (where v_theirdate <> '' and (e->>'physId') = v_from::text and
               case when k='weekendCalls' then (e->>'satDate'=v_theirdate or e->>'sunDate'=v_theirdate or e->>'date'=v_theirdate)
                    else e->>'date'=v_theirdate end and e->>'notes' like '%[swap-approved]%')
        into v_moved, v_moved_back
        from jsonb_array_elements(arr) t(e);
    end loop;
  end if;

  if v_blob is not null then
    v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
    update public.radscheduler set data=v_blob::text where id=p_practice;
  end if;
  return jsonb_build_object('ok',true,'status',p_status,'moved',v_moved,'movedBack',v_moved_back);
end $function$;;
