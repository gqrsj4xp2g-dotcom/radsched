-- jsonb_set only creates the LAST path element: with no prior picks object the
-- write silently no-opped. Ensure the intermediate containers exist first.
CREATE OR REPLACE FUNCTION public.rs_set_vac_picks(p_practice text, p_round integer, p_picks jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid text; v_pid int; v_vp jsonb; v_open int; v_maxrd int; v_clean jsonb; e jsonb; n int; cnt int := 0;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_round is null or p_picks is null or jsonb_typeof(p_picks) <> 'array' then
    return jsonb_build_object('ok',false,'error','bad args'); end if;
  if jsonb_array_length(p_picks) > 3 then return jsonb_build_object('ok',false,'error','max 3 choices'); end if;
  v_uid := (auth.uid())::text;
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;

  v_clean := '[]'::jsonb;
  for e in select value from jsonb_array_elements(p_picks) loop
    if jsonb_typeof(e) = 'null' then
      v_clean := v_clean || 'null'::jsonb;
    elsif jsonb_typeof(e) = 'number' then
      n := (e#>>'{}')::numeric::int;
      if n < 1 or n > 53 then return jsonb_build_object('ok',false,'error','week out of range'); end if;
      if v_clean @> to_jsonb(n) then return jsonb_build_object('ok',false,'error','duplicate week'); end if;
      v_clean := v_clean || to_jsonb(n);
      cnt := cnt + 1;
    else
      return jsonb_build_object('ok',false,'error','bad pick value');
    end if;
  end loop;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_pid
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=v_uid and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  if v_pid is null then return jsonb_build_object('ok',false,'error','your account is not linked to a physician'); end if;

  v_vp := coalesce(v_blob->'vacPicking','{}'::jsonb);
  v_open := coalesce((v_vp->>'roundOpen')::int, 1);
  if p_round <> v_open then return jsonb_build_object('ok',false,'error','round '||p_round||' is not open (open: '||v_open||')'); end if;
  v_maxrd := coalesce((v_vp->'physRounds'->>(v_pid::text))::int, (v_vp->>'defaultRounds')::int, 12);
  if p_round > v_maxrd then return jsonb_build_object('ok',false,'error','you have '||v_maxrd||' rounds — round '||p_round||' is beyond your allocation'); end if;

  -- Ensure intermediate containers exist (jsonb_set only creates the leaf).
  if v_vp->'picks' is null or jsonb_typeof(v_vp->'picks') <> 'object' then
    v_vp := jsonb_set(v_vp, '{picks}', '{}'::jsonb, true); end if;
  if v_vp->'picks'->(v_pid::text) is null or jsonb_typeof(v_vp->'picks'->(v_pid::text)) <> 'object' then
    v_vp := jsonb_set(v_vp, array['picks', v_pid::text], '{}'::jsonb, true); end if;
  v_vp := jsonb_set(v_vp, array['picks', v_pid::text, p_round::text], v_clean, true);
  v_blob := jsonb_set(v_blob, '{vacPicking}', v_vp);
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'physId',v_pid,'round',p_round,'picks',v_clean);
end $function$;;
