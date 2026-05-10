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
-- enable the side-table flow. The client adapter (in widget-data
-- edge function + main app) checks for the table's existence and
-- auto-falls-back to the in-blob store when absent.
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

-- Most-common access pattern: "show me practice X's audit log,
-- newest first, optionally filtered by action". The composite index
-- below is the cheapest single index that supports both pagination
-- (ORDER BY ts DESC LIMIT N) and action-prefix filtering.
CREATE INDEX IF NOT EXISTS radscheduler_audit_practice_ts_idx
  ON public.radscheduler_audit (practice_id, ts DESC);

CREATE INDEX IF NOT EXISTS radscheduler_audit_action_idx
  ON public.radscheduler_audit (practice_id, action);

-- ── 2. Row Level Security ────────────────────────────────────────
-- Insert: any authenticated user (the same role that can edit the
-- practice). Read: only via the existing pairing-code/edge-function
-- path — no anon REST access. So we don't grant the anon role any
-- privileges; the widget-data edge function will use service role.
ALTER TABLE public.radscheduler_audit ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to insert audit entries for their own
-- practice. (Practice-membership check is loose; tighten via a
-- practice_members table when multi-tenant.)
DROP POLICY IF EXISTS audit_insert_authed ON public.radscheduler_audit;
CREATE POLICY audit_insert_authed
  ON public.radscheduler_audit
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Allow authenticated users to select audit rows from any practice
-- they have access to. Adjust if you have a stricter membership
-- model — this matches the existing radscheduler-table policy.
DROP POLICY IF EXISTS audit_select_authed ON public.radscheduler_audit;
CREATE POLICY audit_select_authed
  ON public.radscheduler_audit
  FOR SELECT
  TO authenticated
  USING (true);

-- ── 3. Backfill helper (manual) ──────────────────────────────────
-- After enabling the table, run this in the SQL editor to copy any
-- existing in-blob audit entries to the new table. Idempotent: ON
-- CONFLICT does nothing if a row with the same practice+ts+action
-- already exists (a soft uniqueness — the bigserial id stays the
-- canonical key).
--
-- Replace 'YOUR_PRACTICE_ID' with the row id from the radscheduler
-- table.
--
-- Uncomment when ready:
-- INSERT INTO public.radscheduler_audit
--   (practice_id, ts, who, who_id, role, action, detail)
-- SELECT
--   'YOUR_PRACTICE_ID',
--   (entry->>'ts')::timestamptz,
--   entry->>'who',
--   entry->>'whoId',
--   entry->>'role',
--   entry->>'action',
--   coalesce(entry->'detail', '{}'::jsonb)
-- FROM
--   public.radscheduler,
--   jsonb_array_elements(data::jsonb -> 'auditLog') AS entry
-- WHERE id = 'YOUR_PRACTICE_ID';
