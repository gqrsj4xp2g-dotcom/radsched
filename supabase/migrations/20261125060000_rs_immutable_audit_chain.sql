-- Immutable audit chain for RadScheduler.
--
-- Adds tamper-evident hashes to public.radscheduler_audit and prevents
-- UPDATE/DELETE after backfill. New inserts get:
--   actor_hash: hash of who_id/who so exports can prove actor stability
--   prev_hash:  previous entry_hash for the same practice
--   entry_hash: hash of the row payload + prev_hash
--
-- This is defense in depth. Supabase service-role owners can always alter
-- database objects, but ordinary app paths and RLS-authenticated sessions
-- become append-only.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE public.radscheduler_audit
  ADD COLUMN IF NOT EXISTS inserted_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS chain_order bigint,
  ADD COLUMN IF NOT EXISTS actor_hash text,
  ADD COLUMN IF NOT EXISTS prev_hash text,
  ADD COLUMN IF NOT EXISTS entry_hash text;

CREATE SEQUENCE IF NOT EXISTS public.radscheduler_audit_chain_seq;
REVOKE ALL ON SEQUENCE public.radscheduler_audit_chain_seq FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS radscheduler_audit_chain_order_idx
  ON public.radscheduler_audit (practice_id, chain_order DESC NULLS LAST, ts DESC, id DESC);

-- If a transaction runs at a stricter isolation level and sees an old head
-- after waiting on the lock, reject the competing branch.
CREATE UNIQUE INDEX IF NOT EXISTS radscheduler_audit_one_successor
  ON public.radscheduler_audit(practice_id, prev_hash)
  WHERE chain_order IS NOT NULL AND prev_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS radscheduler_audit_one_root
  ON public.radscheduler_audit(practice_id)
  WHERE chain_order IS NOT NULL AND prev_hash IS NULL;

CREATE INDEX IF NOT EXISTS radscheduler_audit_entry_hash_idx
  ON public.radscheduler_audit (practice_id, entry_hash);

CREATE OR REPLACE FUNCTION public.radscheduler_audit_hash(
  practice_id text,
  ts timestamptz,
  who text,
  who_id text,
  role text,
  action text,
  detail jsonb,
  prev_hash text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT encode(extensions.digest(concat_ws('|',
    coalesce(practice_id, ''),
    coalesce(ts::text, ''),
    coalesce(who, ''),
    coalesce(who_id, ''),
    coalesce(role, ''),
    coalesce(action, ''),
    coalesce(detail::text, '{}'),
    coalesce(prev_hash, '')
  ), 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.radscheduler_audit_actor_hash(who_id text, who text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT encode(extensions.digest(concat_ws('|', coalesce(who_id, ''), coalesce(who, '')), 'sha256'), 'hex');
$$;

-- Preserve all previously installed hashes. A fresh database with historical
-- rows gets a linear pass in timestamp/ID order, without recursive joins.
DO $migration$
DECLARE
  r record;
  previous_practice text;
  previous_hash text;
  new_hash text;
BEGIN
  LOCK TABLE public.radscheduler_audit IN SHARE ROW EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT FROM public.radscheduler_audit WHERE entry_hash IS NULL OR actor_hash IS NULL) THEN
    RETURN;
  END IF;
  FOR r IN SELECT * FROM public.radscheduler_audit ORDER BY practice_id, ts, id LOOP
    IF r.practice_id IS DISTINCT FROM previous_practice THEN previous_hash := NULL; END IF;
    new_hash := coalesce(r.entry_hash, public.radscheduler_audit_hash(r.practice_id,r.ts,r.who,r.who_id,r.role,r.action,r.detail,previous_hash));
    IF r.entry_hash IS NULL OR r.actor_hash IS NULL THEN
      UPDATE public.radscheduler_audit
         SET prev_hash = CASE WHEN r.entry_hash IS NULL THEN previous_hash ELSE r.prev_hash END,
             entry_hash = new_hash,
             actor_hash = coalesce(r.actor_hash,public.radscheduler_audit_actor_hash(r.who_id,r.who))
       WHERE id = r.id;
    END IF;
    previous_practice := r.practice_id;
    previous_hash := new_hash;
  END LOOP;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.radscheduler_audit_hash_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  previous_hash text;
BEGIN
  -- Serialize within each practice, including inserts carrying old event dates.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.practice_id, 43115));
  NEW.chain_order := nextval('public.radscheduler_audit_chain_seq');
  SELECT entry_hash
  INTO previous_hash
  FROM public.radscheduler_audit
  WHERE practice_id = NEW.practice_id
    AND entry_hash IS NOT NULL
  ORDER BY chain_order DESC NULLS LAST, ts DESC, id DESC
  LIMIT 1;

  NEW.inserted_at := clock_timestamp();
  NEW.actor_hash := public.radscheduler_audit_actor_hash(NEW.who_id, NEW.who);
  NEW.prev_hash := previous_hash;
  NEW.entry_hash := public.radscheduler_audit_hash(
    NEW.practice_id,
    NEW.ts,
    NEW.who,
    NEW.who_id,
    NEW.role,
    NEW.action,
    NEW.detail,
    NEW.prev_hash
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS radscheduler_audit_hash_before_insert_trg ON public.radscheduler_audit;
CREATE TRIGGER radscheduler_audit_hash_before_insert_trg
  BEFORE INSERT ON public.radscheduler_audit
  FOR EACH ROW
  EXECUTE FUNCTION public.radscheduler_audit_hash_before_insert();

CREATE OR REPLACE FUNCTION public.radscheduler_audit_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'radscheduler_audit is append-only; insert a compensating event instead';
END;
$$;

DROP TRIGGER IF EXISTS radscheduler_audit_prevent_update_trg ON public.radscheduler_audit;
CREATE TRIGGER radscheduler_audit_prevent_update_trg
  BEFORE UPDATE ON public.radscheduler_audit
  FOR EACH ROW
  EXECUTE FUNCTION public.radscheduler_audit_prevent_mutation();

DROP TRIGGER IF EXISTS radscheduler_audit_prevent_delete_trg ON public.radscheduler_audit;
CREATE TRIGGER radscheduler_audit_prevent_delete_trg
  BEFORE DELETE ON public.radscheduler_audit
  FOR EACH ROW
  EXECUTE FUNCTION public.radscheduler_audit_prevent_mutation();

REVOKE UPDATE, DELETE ON public.radscheduler_audit FROM anon;
REVOKE UPDATE, DELETE ON public.radscheduler_audit FROM authenticated;

REVOKE TRUNCATE ON public.radscheduler_audit FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS radscheduler_audit_prevent_truncate_trg ON public.radscheduler_audit;
CREATE TRIGGER radscheduler_audit_prevent_truncate_trg
  BEFORE TRUNCATE ON public.radscheduler_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.radscheduler_audit_prevent_mutation();
