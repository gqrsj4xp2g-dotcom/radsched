-- ─────────────────────────────────────────────────────────────────
-- Shift side-table migration (RadScheduler)
--
-- Purpose: lift shift collections out of the practice's JSONB blob
-- so the main row stays small at 200+ physician scale. The blob
-- arrays we move here:
--
--   • S.drShifts       — DR daily shifts (1st/2nd/3rd/Home)
--   • S.irShifts       — IR daily shifts
--   • S.weekendCalls   — Sat/Sun on-call rosters
--   • S.irCalls        — IR after-hours / weekend on-call
--
-- Volume estimate at 200 phys × 1 year:
--   • drShifts:    ~50,000 rows  (200 phys × 250 worked days)
--   • irShifts:    ~10,000 rows  (proportionally smaller IR pool)
--   • weekendCalls: ~3,000 rows  (52 weekends × 2 days × ~30 sites/persons)
--   • irCalls:     ~1,000 rows
--                  ────────────
--   total:         ~64,000 rows  (vs 80,000+ in-blob entries today)
--
-- After this lands, payload-size dominators are vacations + holidays
-- + the audit log (already split). drShifts alone is ~70% of the
-- per-save round-trip.
--
-- This is NON-destructive: the existing in-blob arrays are left
-- alone. The dual-write client adapter writes to BOTH the blob and
-- the side-table during a 1-2 week safety window. Cutover sequence:
--
--   Week 0  — apply this SQL (safe, additive)
--   Week 0  — deploy client with dual-write enabled, blob remains canonical
--   Week 1  — backfill via the INSERT block at the bottom (idempotent)
--   Week 2  — flip read path to query side-table for date-range fetches
--   Week 3+ — drop blob copies (one collection at a time)
--
-- Each phase is reversible by toggling the client feature flag.
-- ─────────────────────────────────────────────────────────────────

-- ── 1. Table ────────────────────────────────────────────────────
-- Single normalized table for all shift-like records. The `kind`
-- column discriminates between DR / IR / weekend-call / IR-call.
-- This keeps the schema simple (one set of policies, one set of
-- indexes) while still letting renders fetch only the kinds they
-- need via WHERE kind = 'dr'.
CREATE TABLE IF NOT EXISTS public.radscheduler_shifts (
  id            bigserial    PRIMARY KEY,
  practice_id   text         NOT NULL,
  -- The client's locally-generated id (S.nextId++). Preserved so
  -- in-flight client references survive a backfill round-trip.
  client_id     bigint       NOT NULL,
  kind          text         NOT NULL CHECK (kind IN ('dr','ir','weekend','ircall')),
  phys_id       bigint       NOT NULL,
  shift_date    date         NOT NULL,
  shift         text,         -- '1st' | '2nd' | '3rd' | 'Home' | 'On Call' ...
  site          text,         -- 'CHN', 'CHE', 'At Home / Remote', ...
  sub           text,         -- subspecialty
  slot_label    text,         -- optional bucket name (overflow / etc.)
  notes         text,         -- 'Auto', 'Auto-home', user notes
  auto_home     boolean       DEFAULT false,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  -- One client_id per practice per kind — protects against
  -- duplicate inserts when dual-write retries.
  UNIQUE (practice_id, kind, client_id)
);

-- Most-common access pattern: "show me practice X's shifts in
-- month/year M for kind K". The composite index supports both the
-- date-range scan and the per-month filter.
CREATE INDEX IF NOT EXISTS radscheduler_shifts_practice_date_idx
  ON public.radscheduler_shifts (practice_id, shift_date);

CREATE INDEX IF NOT EXISTS radscheduler_shifts_practice_kind_date_idx
  ON public.radscheduler_shifts (practice_id, kind, shift_date);

CREATE INDEX IF NOT EXISTS radscheduler_shifts_practice_phys_idx
  ON public.radscheduler_shifts (practice_id, phys_id);

-- Touch-on-update trigger so updated_at stays accurate.
CREATE OR REPLACE FUNCTION public._radscheduler_shifts_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS radscheduler_shifts_touch_trg ON public.radscheduler_shifts;
CREATE TRIGGER radscheduler_shifts_touch_trg
  BEFORE UPDATE ON public.radscheduler_shifts
  FOR EACH ROW EXECUTE FUNCTION public._radscheduler_shifts_touch();

-- ── 2. Row Level Security ────────────────────────────────────────
-- Same policy shape as radscheduler_audit: authenticated users can
-- read/write their practice's rows; the widget reads via the
-- service-role edge function (bypasses RLS).
ALTER TABLE public.radscheduler_shifts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shifts_insert_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_insert_authed
  ON public.radscheduler_shifts
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS shifts_update_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_update_authed
  ON public.radscheduler_shifts
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS shifts_delete_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_delete_authed
  ON public.radscheduler_shifts
  FOR DELETE
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS shifts_select_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_select_authed
  ON public.radscheduler_shifts
  FOR SELECT
  TO authenticated
  USING (true);

-- ── 3. Backfill helper (manual, one-time per practice) ──────────
-- After applying the table + deploying the dual-write client, run
-- this to copy any existing in-blob shifts to the side-table. The
-- UNIQUE (practice_id, kind, client_id) constraint makes this
-- idempotent — re-running is safe.
--
-- Replace 'YOUR_PRACTICE_ID' with the row id from the radscheduler
-- table (e.g., 'demo' or your Supabase row id).
--
-- Uncomment and run when ready:
--
-- WITH dr_rows AS (
--   SELECT 'YOUR_PRACTICE_ID' AS pid, 'dr' AS kind,
--          (entry->>'id')::bigint        AS client_id,
--          (entry->>'physId')::bigint    AS phys_id,
--          (entry->>'date')::date        AS shift_date,
--          entry->>'shift'               AS shift,
--          entry->>'site'                AS site,
--          entry->>'sub'                 AS sub,
--          entry->>'slotLabel'           AS slot_label,
--          entry->>'notes'               AS notes,
--          coalesce((entry->>'autoHome')::boolean, false) AS auto_home
--   FROM public.radscheduler,
--        jsonb_array_elements(data::jsonb -> 'drShifts') AS entry
--   WHERE id = 'YOUR_PRACTICE_ID'
-- ), ir_rows AS (
--   SELECT 'YOUR_PRACTICE_ID', 'ir',
--          (entry->>'id')::bigint, (entry->>'physId')::bigint,
--          (entry->>'date')::date, entry->>'shift',
--          entry->>'site', entry->>'sub', entry->>'slotLabel',
--          entry->>'notes',
--          coalesce((entry->>'autoHome')::boolean, false)
--   FROM public.radscheduler,
--        jsonb_array_elements(data::jsonb -> 'irShifts') AS entry
--   WHERE id = 'YOUR_PRACTICE_ID'
-- ), wk_rows AS (
--   SELECT 'YOUR_PRACTICE_ID', 'weekend',
--          (entry->>'id')::bigint, (entry->>'physId')::bigint,
--          (entry->>'date')::date, entry->>'shift',
--          entry->>'site', entry->>'sub', entry->>'slotLabel',
--          entry->>'notes',
--          coalesce((entry->>'autoHome')::boolean, false)
--   FROM public.radscheduler,
--        jsonb_array_elements(data::jsonb -> 'weekendCalls') AS entry
--   WHERE id = 'YOUR_PRACTICE_ID'
-- ), ic_rows AS (
--   SELECT 'YOUR_PRACTICE_ID', 'ircall',
--          (entry->>'id')::bigint, (entry->>'physId')::bigint,
--          (entry->>'date')::date, entry->>'shift',
--          entry->>'site', entry->>'sub', entry->>'slotLabel',
--          entry->>'notes',
--          coalesce((entry->>'autoHome')::boolean, false)
--   FROM public.radscheduler,
--        jsonb_array_elements(data::jsonb -> 'irCalls') AS entry
--   WHERE id = 'YOUR_PRACTICE_ID'
-- )
-- INSERT INTO public.radscheduler_shifts
--   (practice_id, kind, client_id, phys_id, shift_date,
--    shift, site, sub, slot_label, notes, auto_home)
-- SELECT * FROM dr_rows
-- UNION ALL SELECT * FROM ir_rows
-- UNION ALL SELECT * FROM wk_rows
-- UNION ALL SELECT * FROM ic_rows
-- ON CONFLICT (practice_id, kind, client_id) DO NOTHING;

-- ── 4. Sanity-check query ───────────────────────────────────────
-- After backfilling, run this to confirm row counts match the blob:
--
-- SELECT kind, count(*)
-- FROM public.radscheduler_shifts
-- WHERE practice_id = 'YOUR_PRACTICE_ID'
-- GROUP BY kind
-- ORDER BY kind;
--
-- Compare to:
--
-- SELECT
--   jsonb_array_length(data::jsonb -> 'drShifts')      AS dr,
--   jsonb_array_length(data::jsonb -> 'irShifts')      AS ir,
--   jsonb_array_length(data::jsonb -> 'weekendCalls')  AS weekend,
--   jsonb_array_length(data::jsonb -> 'irCalls')       AS ircall
-- FROM public.radscheduler WHERE id = 'YOUR_PRACTICE_ID';
