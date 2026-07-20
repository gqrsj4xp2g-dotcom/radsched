CREATE TABLE IF NOT EXISTS public.radscheduler_shifts (
  id            bigserial    PRIMARY KEY,
  practice_id   text         NOT NULL,
  client_id     bigint       NOT NULL,
  kind          text         NOT NULL CHECK (kind IN ('dr','ir','weekend','ircall')),
  phys_id       bigint       NOT NULL,
  shift_date    date         NOT NULL,
  shift         text,
  site          text,
  sub           text,
  slot_label    text,
  notes         text,
  auto_home     boolean       DEFAULT false,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (practice_id, kind, client_id)
);

CREATE INDEX IF NOT EXISTS radscheduler_shifts_practice_date_idx
  ON public.radscheduler_shifts (practice_id, shift_date);

CREATE INDEX IF NOT EXISTS radscheduler_shifts_practice_kind_date_idx
  ON public.radscheduler_shifts (practice_id, kind, shift_date);

CREATE INDEX IF NOT EXISTS radscheduler_shifts_practice_phys_idx
  ON public.radscheduler_shifts (practice_id, phys_id);

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

ALTER TABLE public.radscheduler_shifts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shifts_insert_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_insert_authed ON public.radscheduler_shifts
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS shifts_update_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_update_authed ON public.radscheduler_shifts
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS shifts_delete_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_delete_authed ON public.radscheduler_shifts
  FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS shifts_select_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_select_authed ON public.radscheduler_shifts
  FOR SELECT TO authenticated USING (true);;
