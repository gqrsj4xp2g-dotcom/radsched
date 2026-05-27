-- ─────────────────────────────────────────────────────────────────
-- Audit-log side-table migration (RadScheduler)
--
-- Purpose: lift S.auditLog out of the practice's JSONB blob so the
-- main row stays small. At 200-physician scale the audit log is the
-- largest growing array (~200 KB per year). Splitting it:
--   • shrinks the main blob (faster every save)
--   • removes the LRU cap (we keep history forever now)
--   • lets us paginate + filter via SQL instead of in-memory JS
--
-- Run this once in the Supabase SQL editor when you're ready to
-- enable the side-table flow. The main app checks for the table's
-- existence and auto-falls-back to the in-blob store when absent.
--
-- This is NON-destructive: the existing in-blob auditLog is left
-- alone. A follow-up backfill script copies it into the new table.
-- ─────────────────────────────────────────────────────────────────

-- ── 1. Table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.radscheduler_audit (
  id           bigserial    PRIMARY KEY,
  practice_id  text         NOT NULL,
  ts           timestamptz  NOT NULL DEFAULT now(),
  who          text,                   -- email or name as captured client-side
  who_id       text,                   -- supabase user id when available
  role         text,                   -- 'admin' | 'physician' | 'superuser'
  action       text         NOT NULL,
  detail       jsonb        DEFAULT '{}'::jsonb
);

-- Keep older installs aligned with the current shape.
ALTER TABLE public.radscheduler_audit
  ADD COLUMN IF NOT EXISTS who text,
  ADD COLUMN IF NOT EXISTS who_id text,
  ADD COLUMN IF NOT EXISTS role text,
  ADD COLUMN IF NOT EXISTS detail jsonb DEFAULT '{}'::jsonb;

UPDATE public.radscheduler_audit
SET detail = '{}'::jsonb
WHERE detail IS NULL;

ALTER TABLE public.radscheduler_audit
  ALTER COLUMN detail SET DEFAULT '{}'::jsonb,
  ALTER COLUMN detail SET NOT NULL;

-- Most-common access pattern: "show me practice X's audit log,
-- newest first, optionally filtered by action". The composite index
-- below is the cheapest single index that supports both pagination
-- (ORDER BY ts DESC LIMIT N) and action-prefix filtering.
CREATE INDEX IF NOT EXISTS radscheduler_audit_practice_ts_idx
  ON public.radscheduler_audit (practice_id, ts DESC);

CREATE INDEX IF NOT EXISTS radscheduler_audit_action_idx
  ON public.radscheduler_audit (practice_id, action);

-- Backfill and retry safety. The client writes audit rows fire-and-forget;
-- this index keeps a retried insert or repeated backfill from creating
-- duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS radscheduler_audit_dedupe_idx
  ON public.radscheduler_audit (
    practice_id,
    ts,
    action,
    coalesce(who_id, ''),
    md5(coalesce(detail::text, ''))
  );

-- ── 2. Row Level Security ────────────────────────────────────────
-- Authenticated users can insert/read rows for their own practice.
-- Admins and superusers can see all practices, matching the client
-- role model. The anon role receives no privileges.
ALTER TABLE public.radscheduler_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_insert_authed ON public.radscheduler_audit;
DROP POLICY IF EXISTS audit_insert_scoped ON public.radscheduler_audit;
CREATE POLICY audit_insert_scoped
  ON public.radscheduler_audit
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId'))
  );

DROP POLICY IF EXISTS audit_select_authed ON public.radscheduler_audit;
DROP POLICY IF EXISTS audit_select_scoped ON public.radscheduler_audit;
CREATE POLICY audit_select_scoped
  ON public.radscheduler_audit
  FOR SELECT
  TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId'))
  );

-- ── 3. Backfill helper ───────────────────────────────────────────
-- Copies any existing in-blob audit entries to the side table. Safe to
-- re-run: the dedupe index plus ON CONFLICT DO NOTHING prevents doubles.
INSERT INTO public.radscheduler_audit
  (practice_id, ts, who, who_id, role, action, detail)
SELECT
  r.id,
  CASE
    WHEN entry->>'ts' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (entry->>'ts')::timestamptz
    ELSE now()
  END,
  entry->>'who',
  entry->>'whoId',
  entry->>'role',
  coalesce(nullif(entry->>'action', ''), 'unknown'),
  coalesce(entry->'detail', '{}'::jsonb)
FROM public.radscheduler r
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(r.data::jsonb -> 'auditLog') = 'array' THEN r.data::jsonb -> 'auditLog'
    ELSE '[]'::jsonb
  END
) AS entry
ON CONFLICT DO NOTHING;
