-- Pin search_path so the trigger function can't be influenced by a caller's
-- search_path (Supabase security-advisor best practice). All refs are built-ins
-- / the NEW pseudo-record, so an empty path is safe.
create or replace function public.radscheduler_stamp_saved_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  begin
    new.saved_at := coalesce(nullif(new.data::json->>'savedAt','')::timestamptz, now());
  exception when others then
    new.saved_at := now();
  end;
  return new;
end;
$$;;
