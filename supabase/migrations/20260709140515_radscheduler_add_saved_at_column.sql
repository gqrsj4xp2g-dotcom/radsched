-- Poll-efficiency: a lightweight saved_at column so clients can gate the full
-- multi-MB blob download on a cheap timestamp read. Mirrors the JSON payload's
-- own savedAt (same client clock the app already compares against), with a
-- BEFORE trigger so every writer — the app AND server-side edge functions —
-- keeps it current. Never blocks a write: any parse error falls back to now().

alter table public.radscheduler add column if not exists saved_at timestamptz;

create or replace function public.radscheduler_stamp_saved_at()
returns trigger language plpgsql as $$
begin
  begin
    new.saved_at := coalesce(nullif(new.data::json->>'savedAt','')::timestamptz, now());
  exception when others then
    new.saved_at := now();
  end;
  return new;
end;
$$;

drop trigger if exists trg_radscheduler_saved_at on public.radscheduler;
create trigger trg_radscheduler_saved_at
  before insert or update on public.radscheduler
  for each row execute function public.radscheduler_stamp_saved_at();

-- Backfill existing rows (the trigger re-derives the same value).
update public.radscheduler
set saved_at = coalesce(nullif(data::json->>'savedAt','')::timestamptz, now());;
