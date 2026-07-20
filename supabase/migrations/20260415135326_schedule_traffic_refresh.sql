-- Enable pg_cron if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule weekly traffic refresh: every Monday at 5:00 AM UTC
SELECT cron.schedule(
  'weekly-traffic-refresh',
  '0 5 * * 1',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url', true) || '/functions/v1/auto-refresh-traffic',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
;
