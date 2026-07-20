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

CREATE INDEX IF NOT EXISTS radscheduler_audit_practice_ts_idx
  ON public.radscheduler_audit (practice_id, ts DESC);

CREATE INDEX IF NOT EXISTS radscheduler_audit_action_idx
  ON public.radscheduler_audit (practice_id, action);

CREATE UNIQUE INDEX IF NOT EXISTS radscheduler_audit_dedupe_idx
  ON public.radscheduler_audit (
    practice_id,
    ts,
    action,
    coalesce(who_id, ''),
    md5(coalesce(detail::text, ''))
  );

ALTER TABLE public.radscheduler_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_insert_authed ON public.radscheduler_audit;
DROP POLICY IF EXISTS audit_insert_scoped ON public.radscheduler_audit;
CREATE POLICY audit_insert_scoped
  ON public.radscheduler_audit
  FOR INSERT
  TO authenticated
  WITH CHECK (
    ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (practice_id = (auth.jwt() -> 'app_metadata' ->> 'practiceId'))
  );

DROP POLICY IF EXISTS audit_select_authed ON public.radscheduler_audit;
DROP POLICY IF EXISTS audit_select_scoped ON public.radscheduler_audit;
CREATE POLICY audit_select_scoped
  ON public.radscheduler_audit
  FOR SELECT
  TO authenticated
  USING (
    ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (practice_id = (auth.jwt() -> 'app_metadata' ->> 'practiceId'))
  );

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
ON CONFLICT DO NOTHING;;
