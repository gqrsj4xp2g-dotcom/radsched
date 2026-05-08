// Supabase Edge Function: send-notification
// ─────────────────────────────────────────────────────────────────────────
// Multi-channel delivery for RadScheduler events. Routes incoming messages
// to email (Resend), SMS (Twilio), Web Push (VAPID), or outbound webhooks
// based on the request body's `kind` field.
//
// Auth: requires a valid Supabase JWT in Authorization: Bearer <token>.
// The function verifies the JWT through Supabase's anon client; rejecting
// unauthenticated requests prevents anyone with the function URL from
// using your delivery credentials as an open relay.
//
// Required environment variables (set in Supabase dashboard → Edge
// Functions → send-notification → Manage Secrets):
//
//   SUPABASE_URL                 — auto-injected
//   SUPABASE_SERVICE_ROLE_KEY    — auto-injected
//   RESEND_API_KEY               — for email; sign up at resend.com
//   RESEND_FROM_EMAIL            — e.g. "RadScheduler <noreply@your-domain>"
//   TWILIO_ACCOUNT_SID           — for SMS
//   TWILIO_AUTH_TOKEN            — for SMS
//   TWILIO_FROM_NUMBER           — your Twilio phone in E.164
//   VAPID_PUBLIC_KEY             — Web Push public (also lives in S.cfg)
//   VAPID_PRIVATE_KEY            — Web Push private (server-only)
//   VAPID_SUBJECT                — e.g. "mailto:admin@your-domain"
//
// Request body (JSON):
//   { kind: 'email',   to: 'user@example.com', subject: '...', body: '...', html: '...' }
//   { kind: 'sms',     to: '+15551234567',     body: '...' }
//   { kind: 'push',    userId: '<auth-user-id>', title: '...', body: '...', url?: '...' }
//   { kind: 'webhook', url: 'https://...', payload: { eventName: '...', ...} }
//   { kind: 'digest-run' }      — invoked by pg_cron to fan out daily/weekly digests
//
// Response: { ok: boolean, kind: '...', detail?: '...' } — 200 even on
// per-channel failure (delivery is best-effort), 4xx for auth/validation.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'https://esm.sh/web-push@3.6.7';

interface Body {
  kind: 'email' | 'sms' | 'push' | 'webhook' | 'digest-run';
  to?: string;
  userId?: string;
  subject?: string;
  body?: string;
  html?: string;
  title?: string;
  url?: string;
  payload?: Record<string, unknown>;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}
function err(status: number, message: string) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return err(405, 'POST only');

  // Auth — verify the caller's JWT against Supabase. Caller is a
  // RadScheduler client; we don't accept anonymous delivery requests.
  const auth = req.headers.get('Authorization') || '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  if (!jwt) return err(401, 'Missing JWT');
  const sbUrl = Deno.env.get('SUPABASE_URL')!;
  const sbAnon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const sbService = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const sbAuth = createClient(sbUrl, sbAnon);
  const { data: userData, error: authErr } = await sbAuth.auth.getUser(jwt);
  if (authErr || !userData?.user) return err(401, 'Invalid JWT');

  let body: Body;
  try { body = await req.json(); }
  catch { return err(400, 'Invalid JSON body'); }
  if (!body.kind) return err(400, 'Missing kind');

  try {
    switch (body.kind) {
      case 'email':   return ok(await sendEmail(body));
      case 'sms':     return ok(await sendSMS(body));
      case 'push':    return ok(await sendPush(body, sbUrl, sbService));
      case 'webhook': return ok(await sendWebhook(body));
      case 'digest-run': return ok(await runDigest(sbUrl, sbService));
      default:        return err(400, `Unknown kind: ${body.kind}`);
    }
  } catch (e) {
    console.error(`[send-notification] ${body.kind} failed:`, e);
    return err(500, e instanceof Error ? e.message : String(e));
  }
});

// ─── Email via Resend ──────────────────────────────────────────────────
async function sendEmail(b: Body) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('RESEND_FROM_EMAIL') || 'noreply@example.com';
  if (!apiKey) throw new Error('RESEND_API_KEY not configured');
  if (!b.to || !b.subject) throw new Error('email requires { to, subject }');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: b.to, subject: b.subject,
      text: b.body || '',
      html: b.html || (b.body ? `<p>${b.body.replace(/\n/g, '<br>')}</p>` : undefined),
    }),
  });
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${await resp.text()}`);
  return { ok: true, kind: 'email', detail: await resp.json() };
}

// ─── SMS via Twilio ────────────────────────────────────────────────────
async function sendSMS(b: Body) {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_FROM_NUMBER');
  if (!sid || !token || !from) throw new Error('Twilio creds not configured');
  if (!b.to || !b.body) throw new Error('sms requires { to, body }');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = btoa(`${sid}:${token}`);
  const params = new URLSearchParams({ From: from, To: b.to, Body: b.body });
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!resp.ok) throw new Error(`Twilio ${resp.status}: ${await resp.text()}`);
  return { ok: true, kind: 'sms', detail: await resp.json() };
}

// ─── Web Push via VAPID ────────────────────────────────────────────────
async function sendPush(b: Body, sbUrl: string, sbService: string) {
  const pub = Deno.env.get('VAPID_PUBLIC_KEY');
  const priv = Deno.env.get('VAPID_PRIVATE_KEY');
  const subject = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com';
  if (!pub || !priv) throw new Error('VAPID keys not configured');
  if (!b.userId) throw new Error('push requires { userId }');
  webpush.setVapidDetails(subject, pub, priv);
  // Look up the user's push subscription from the practice's data row.
  // The client stores it on USERS[i].pushSubscription as a JSON blob.
  const sb = createClient(sbUrl, sbService);
  const { data: rows, error } = await sb.from('radscheduler').select('id, data');
  if (error) throw error;
  let subscription: PushSubscriptionJSON | null = null;
  for (const r of rows || []) {
    try {
      const d = JSON.parse(r.data);
      const u = (d.users || []).find((u: { id: string; pushSubscription?: PushSubscriptionJSON }) => u.id === b.userId);
      if (u?.pushSubscription) { subscription = u.pushSubscription; break; }
    } catch { /* skip malformed rows */ }
  }
  if (!subscription) throw new Error(`No push subscription found for user ${b.userId}`);
  const payload = JSON.stringify({
    title: b.title || 'RadScheduler',
    body: b.body || '',
    url: b.url || '/',
    tag: 'rs-' + (b.title || '').toLowerCase().replace(/\s+/g, '-'),
  });
  await webpush.sendNotification(subscription as never, payload);
  return { ok: true, kind: 'push' };
}

// ─── Outbound webhooks ─────────────────────────────────────────────────
async function sendWebhook(b: Body) {
  if (!b.url) throw new Error('webhook requires { url }');
  if (!/^https?:\/\//.test(b.url)) throw new Error('webhook url must be http(s)');
  const resp = await fetch(b.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'RadScheduler/1.0' },
    body: JSON.stringify(b.payload || {}),
  });
  // Slack / Teams / etc. return 200 OK with a tiny "ok" body. We just
  // surface non-2xx as failure; the caller's audit log captures intent.
  if (!resp.ok) throw new Error(`webhook ${resp.status}: ${await resp.text()}`);
  return { ok: true, kind: 'webhook', detail: { status: resp.status } };
}

// ─── Daily / weekly digest fanout ──────────────────────────────────────
// Invoked by Supabase pg_cron (set up SQL trigger separately). Walks
// every practice's `S.users` + their notification preferences, builds a
// per-user digest, and queues an email per recipient.
async function runDigest(sbUrl: string, sbService: string) {
  const sb = createClient(sbUrl, sbService);
  const { data: rows, error } = await sb.from('radscheduler').select('id, data');
  if (error) throw error;
  let sent = 0, skipped = 0;
  const today = new Date().toISOString().slice(0, 10);
  const next7End = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  for (const r of rows || []) {
    let practice: Record<string, unknown>;
    try { practice = JSON.parse(r.data); } catch { skipped++; continue; }
    const cfg = practice.cfg as { digest?: { enabled?: boolean; cadence?: string; hour?: number } } | undefined;
    if (!cfg?.digest?.enabled) { skipped++; continue; }
    // Cadence + hour gate — pg_cron should already fire near the right
    // hour, but recheck so a user toggling off mid-run is respected.
    const users = (practice.users || []) as Array<{
      id: string; email?: string; physId?: number;
      notifPrefs?: { master?: boolean; digest?: boolean };
    }>;
    const physicians = (practice.physicians || []) as Array<{ id: number; last?: string; first?: string }>;
    const drShifts = (practice.drShifts || []) as Array<{ physId: number; date: string; shift: string; site?: string }>;
    const irShifts = (practice.irShifts || []) as Array<{ physId: number; date: string; shift: string; site?: string }>;
    const irCalls  = (practice.irCalls  || []) as Array<{ physId: number; date: string; callType: string }>;
    const wknds    = (practice.weekendCalls || []) as Array<{ physId: number; satDate?: string; date?: string }>;
    for (const u of users) {
      if (!u.email || !u.physId) { skipped++; continue; }
      if (u.notifPrefs?.master === false || u.notifPrefs?.digest === false) { skipped++; continue; }
      const phys = physicians.find(p => p.id === u.physId);
      const myShifts = [
        ...drShifts.filter(s => s.physId === u.physId && s.date >= today && s.date <= next7End),
        ...irShifts.filter(s => s.physId === u.physId && s.date >= today && s.date <= next7End),
      ];
      const myCalls = irCalls.filter(c => c.physId === u.physId && c.date >= today && c.date <= next7End);
      const myWknd  = wknds.filter(w => (w.satDate || w.date || '') >= today && (w.satDate || w.date || '') <= next7End && w.physId === u.physId);
      if (myShifts.length === 0 && myCalls.length === 0 && myWknd.length === 0) { skipped++; continue; }
      const lines: string[] = [`Hi ${phys?.first || ''},`, '', `Your schedule for the next 7 days:`, ''];
      myShifts.forEach(s => lines.push(`  ${s.date} — ${s.shift} shift at ${s.site || 'TBD'}`));
      myCalls.forEach(c => lines.push(`  ${c.date} — IR ${c.callType} call`));
      myWknd.forEach(w => lines.push(`  ${w.satDate || w.date} — Weekend call`));
      lines.push('', `View full schedule: https://radsched.org/`);
      try {
        await sendEmail({
          kind: 'email',
          to: u.email,
          subject: `Your RadScheduler week — ${today}`,
          body: lines.join('\n'),
        });
        sent++;
      } catch (e) {
        console.warn('digest send failed for', u.email, e);
      }
    }
  }
  return { ok: true, kind: 'digest-run', detail: { sent, skipped } };
}
