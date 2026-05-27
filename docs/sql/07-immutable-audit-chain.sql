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
  ADD COLUMN IF NOT EXISTS actor_hash text,
  ADD COLUMN IF NOT EXISTS prev_hash text,
  ADD COLUMN IF NOT EXISTS entry_hash text;

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

WITH RECURSIVE ordered AS (
  SELECT
    id,
    practice_id,
    ts,
    who,
    who_id,
    role,
    action,
    detail,
    row_number() OVER (PARTITION BY practice_id ORDER BY ts, id) AS rn
  FROM public.radscheduler_audit
),
chain AS (
  SELECT
    id,
    practice_id,
    rn,
    NULL::text AS prev_hash,
    public.radscheduler_audit_hash(practice_id, ts, who, who_id, role, action, detail, NULL::text) AS entry_hash
  FROM ordered
  WHERE rn = 1

  UNION ALL

  SELECT
    o.id,
    o.practice_id,
    o.rn,
    c.entry_hash AS prev_hash,
    public.radscheduler_audit_hash(o.practice_id, o.ts, o.who, o.who_id, o.role, o.action, o.detail, c.entry_hash) AS entry_hash
  FROM ordered o
  JOIN chain c
    ON c.practice_id = o.practice_id
   AND c.rn + 1 = o.rn
)
UPDATE public.radscheduler_audit a
SET
  prev_hash = coalesce(a.prev_hash, c.prev_hash),
  entry_hash = coalesce(a.entry_hash, c.entry_hash),
  actor_hash = coalesce(a.actor_hash, public.radscheduler_audit_actor_hash(a.who_id, a.who))
FROM chain c
WHERE a.id = c.id
  AND (a.entry_hash IS NULL OR a.actor_hash IS NULL);

CREATE OR REPLACE FUNCTION public.radscheduler_audit_hash_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  previous_hash text;
BEGIN
  SELECT entry_hash
  INTO previous_hash
  FROM public.radscheduler_audit
  WHERE practice_id = NEW.practice_id
    AND entry_hash IS NOT NULL
  ORDER BY ts DESC, id DESC
  LIMIT 1;

  NEW.inserted_at := coalesce(NEW.inserted_at, now());
  NEW.actor_hash := coalesce(NEW.actor_hash, public.radscheduler_audit_actor_hash(NEW.who_id, NEW.who));
  NEW.prev_hash := coalesce(NEW.prev_hash, previous_hash);
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
