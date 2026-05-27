-- Enterprise telemetry table for durable operational events.
--
-- This stores app-level events such as readiness checks, failed saves,
-- runtime errors, edge probes, and manual operator probes. It is not a
-- replacement for Supabase platform logs; it is scoped application evidence
-- that admins can query/export by practice.

CREATE TABLE IF NOT EXISTS public.radscheduler_telemetry (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL,
  user_id TEXT,
  user_email TEXT,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  event TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS radscheduler_telemetry_practice_created_idx
  ON public.radscheduler_telemetry (practice_id, created_at DESC);

CREATE INDEX IF NOT EXISTS radscheduler_telemetry_event_idx
  ON public.radscheduler_telemetry (practice_id, event, created_at DESC);

ALTER TABLE public.radscheduler_telemetry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS telemetry_insert_scoped ON public.radscheduler_telemetry;
CREATE POLICY telemetry_insert_scoped
  ON public.radscheduler_telemetry
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser') AND coalesce((select auth.jwt()) ->> 'aal','aal1') = 'aal2') OR
    (practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId'))
  );

DROP POLICY IF EXISTS telemetry_select_scoped ON public.radscheduler_telemetry;
CREATE POLICY telemetry_select_scoped
  ON public.radscheduler_telemetry
  FOR SELECT
  TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser') AND coalesce((select auth.jwt()) ->> 'aal','aal1') = 'aal2') OR
    (practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId'))
  );
