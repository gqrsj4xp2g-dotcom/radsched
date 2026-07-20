CREATE TABLE IF NOT EXISTS public.radscheduler_audit (
  id           bigserial    PRIMARY KEY,
  practice_id  text         NOT NULL,
  ts           timestamptz  NOT NULL DEFAULT now(),
  who          text,
  who_id       text,
  role         text,
  action       text         NOT NULL,
  detail       jsonb        DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS radscheduler_audit_practice_ts_idx
  ON public.radscheduler_audit (practice_id, ts DESC);

CREATE INDEX IF NOT EXISTS radscheduler_audit_action_idx
  ON public.radscheduler_audit (practice_id, action);

ALTER TABLE public.radscheduler_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_insert_authed ON public.radscheduler_audit;
CREATE POLICY audit_insert_authed
  ON public.radscheduler_audit
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS audit_select_authed ON public.radscheduler_audit;
CREATE POLICY audit_select_authed
  ON public.radscheduler_audit
  FOR SELECT
  TO authenticated
  USING (true);;
