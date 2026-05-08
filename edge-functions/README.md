# Edge functions

Server-side delivery for RadScheduler's outbound channels — email, SMS,
Web Push, generic webhooks, and scheduled email digests.

## What's here

```
edge-functions/
├── send-notification/
│   └── index.ts        Multi-channel delivery (email / SMS / push / webhook / digest)
└── README.md           This file
```

A single function handles all channels because they share the same auth +
rate-limit infrastructure. The `kind` field in each request body routes to
the right handler.

## Deploy

```bash
# From the project root
supabase functions deploy send-notification

# Set per-channel secrets
supabase secrets set RESEND_API_KEY=re_xxx
supabase secrets set RESEND_FROM_EMAIL='RadScheduler <noreply@your-domain>'
supabase secrets set TWILIO_ACCOUNT_SID=ACxxx
supabase secrets set TWILIO_AUTH_TOKEN=your_auth_token
supabase secrets set TWILIO_FROM_NUMBER=+15551234567
supabase secrets set VAPID_PUBLIC_KEY=BJxxxxx
supabase secrets set VAPID_PRIVATE_KEY=xxxxx
supabase secrets set VAPID_SUBJECT='mailto:admin@your-domain'
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected.

## Generate VAPID keys

```bash
npx web-push generate-vapid-keys
```

Set the **public** key as `VAPID_PUBLIC_KEY` here AND in `S.cfg.vapidPublicKey`
(via Settings → Practice → Push notifications). Set the **private** key as
`VAPID_PRIVATE_KEY` — it never leaves the server.

## Schedule the digest

In the Supabase SQL editor, install pg_cron and schedule the daily digest:

```sql
-- Once-per-project install
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Run digest fanout daily at 7 AM UTC
SELECT cron.schedule(
  'radsched-daily-digest',
  '0 7 * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR-PROJECT.supabase.co/functions/v1/send-notification',
    headers := '{"Authorization":"Bearer YOUR-SERVICE-ROLE-JWT","Content-Type":"application/json"}'::jsonb,
    body   := '{"kind":"digest-run"}'::jsonb
  );
  $$
);
```

For **weekly** Mondays at 7 AM, change the cron expression to `0 7 * * 1`.

To stop scheduling:

```sql
SELECT cron.unschedule('radsched-daily-digest');
```

## Calling from the client

The RadScheduler client invokes this function via the same plumbing it uses
for every other authenticated request — the user's JWT goes in
`Authorization: Bearer <token>`. The function rejects unauthenticated
calls so your delivery credentials can't be used as an open relay.

```js
// Email — used by Tools → Integrations → Test SMS, broadcast email, etc.
await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.access_token}`,
  },
  body: JSON.stringify({
    kind: 'email',
    to: 'doctor@hospital.org',
    subject: 'Your shift on May 5',
    body: 'You\'re assigned to 1st shift at CHN.',
  }),
});

// SMS, push, webhook, digest-run — same shape, different `kind`.
```

## Auth model

Every request requires a valid Supabase JWT. The function:

1. Verifies the JWT through `supabase.auth.getUser(jwt)`.
2. Returns 401 if invalid.
3. Otherwise routes to the channel-specific handler.

This is intentional — without auth, anyone with the function URL could
burn through your Twilio / Resend credits or spam users on Web Push.

## Testing

```bash
# Test SMS delivery (replace with your phone number)
TOKEN="$(supabase functions invoke get-test-jwt | jq -r .token)"
curl -X POST https://YOUR-PROJECT.supabase.co/functions/v1/send-notification \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"sms","to":"+15551234567","body":"Test from RadScheduler"}'

# Test digest fanout
curl -X POST https://YOUR-PROJECT.supabase.co/functions/v1/send-notification \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"digest-run"}'
```

## Delivery is best-effort

Per-channel failures return a 500 to the caller but don't roll back any
state. The client's audit log records the intent; the edge function's
own logs (Supabase dashboard → Edge Functions → send-notification → Logs)
record the outcome. If you need at-least-once delivery, wrap the relevant
calls in a queue table + a worker that retries with backoff.
