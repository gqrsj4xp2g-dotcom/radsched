-- Remove old weekly job, replace with weekly + quarterly-start jobs
SELECT cron.unschedule('weekly-traffic-refresh');

-- Weekly refresh: every Monday 5 AM UTC (builds up all 13 weeks of each quarter)
SELECT cron.schedule(
  'weekly-traffic-refresh',
  '0 5 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://tpbgwvisikbuqhmlqtky.supabase.co/functions/v1/auto-refresh-traffic',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Quarterly refresh: first Monday of Jan, Apr, Jul, Oct at 6 AM UTC
-- (ensures the new quarter snapshot is captured right at the start)
SELECT cron.schedule(
  'quarterly-traffic-q1',
  '0 6 1-7 1 1',
  $$SELECT net.http_post(url := 'https://tpbgwvisikbuqhmlqtky.supabase.co/functions/v1/auto-refresh-traffic', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb);$$
);
SELECT cron.schedule(
  'quarterly-traffic-q2',
  '0 6 1-7 4 1',
  $$SELECT net.http_post(url := 'https://tpbgwvisikbuqhmlqtky.supabase.co/functions/v1/auto-refresh-traffic', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb);$$
);
SELECT cron.schedule(
  'quarterly-traffic-q3',
  '0 6 1-7 7 1',
  $$SELECT net.http_post(url := 'https://tpbgwvisikbuqhmlqtky.supabase.co/functions/v1/auto-refresh-traffic', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb);$$
);
SELECT cron.schedule(
  'quarterly-traffic-q4',
  '0 6 1-7 10 1',
  $$SELECT net.http_post(url := 'https://tpbgwvisikbuqhmlqtky.supabase.co/functions/v1/auto-refresh-traffic', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb);$$
);;
