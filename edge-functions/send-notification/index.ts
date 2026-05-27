// Supabase Edge Function: send-notification
// ─────────────────────────────────────────────────────────────────────────
// Multi-channel delivery for RadScheduler events. Routes incoming messages
// to email (Resend), SMS (Twilio), Web Push (VAPID), or outbound webhooks
// based on the request body's `kind` field.
//
// Auth: regular client delivery requires a valid Supabase JWT in
// Authorization: Bearer <token>. The digest fanout can also be invoked
// by pg_cron with x-rs-cron-secret, because pg_cron cannot supply a user
// session. The function enforces both paths internally.
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
//   RS_CRON_SECRET               — shared secret for scheduled digest fanout
//
// Request body (JSON):
//   { kind: 'email',   to: 'user@example.com', subject: '...', body: '...', html: '...' }
//   { kind: 'broadcast', recipients: [{ email, name }], subject: '...', body: '...' }
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
  kind: string;
  to?: string;
  userId?: string;
  subject?: string;
  body?: string;
  html?: string;
  title?: string;
  url?: string;
  recipients?: Array<{ email?: string; name?: string; first?: string; last?: string }>;
  from_practice?: string;
  payload?: Record<string, unknown>;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-rs-cron-secret',
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

function resendFrom(): string {
  const explicit = Deno.env.get('RESEND_FROM_EMAIL');
  if (explicit) return explicit;
  const email = Deno.env.get('FROM_EMAIL');
  const name = Deno.env.get('FROM_NAME') || 'RadScheduler';
  return email ? `${name} <${email}>` : 'noreply@example.com';
}

// ── Per-caller in-memory rate limit ──────────────────────────────────
// Cheap defense against an authed user using the function as a delivery
// bomb (e.g. mass-emailing). Bucket persists across invocations within
// the same isolate but resets on cold start — acceptable for our
// threat model. Service-role calls bypass.
const _rl = new Map<string, { n: number; t: number }>();
function rateLimit(key: string, capPerMinute: number): boolean {
  const now = Date.now();
  const b = _rl.get(key);
  if (!b || (now - b.t) > 60_000) { _rl.set(key, { n: 1, t: now }); return true; }
  if (b.n >= capPerMinute) return false;
  b.n++; return true;
}

// SSRF guard: reject webhook URLs that resolve to private / link-local
// / loopback addresses, or to hostnames that look like cloud metadata.
// Cheap host-based check — doesn't DNS-resolve (Edge runtimes can't
// reliably do that synchronously), so an attacker with control of an
// external DNS could still redirect, but they can't directly target
// 169.254.169.254 / 127.0.0.1 / 10.x / internal hostnames.
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata' || h === 'metadata.google.internal') return true;
  // IPv4 literal checks
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // loopback
    if (a === 169 && b === 254) return true;         // link-local incl. AWS/GCP metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 0) return true;                        // 0.0.0.0/8
  }
  // IPv6 loopback / link-local literals
  if (h === '::1' || h.startsWith('[::1]') || h.startsWith('fe80:') || h.startsWith('[fe80')) return true;
  return false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return err(405, 'POST only');

  const sbUrl = Deno.env.get('SUPABASE_URL')!;
  const sbAnon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const sbService = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  let body: Body;
  try { body = await req.json(); }
  catch { return err(400, 'Invalid JSON body'); }
  if (!body.kind) return err(400, 'Missing kind');

  const cronHdr = req.headers.get('x-rs-cron-secret') || '';
  const cronSecret = Deno.env.get('RS_CRON_SECRET') || '';
  const isCronDigest = body.kind === 'digest-run' && !!cronSecret && cronHdr === cronSecret;

  let callerUid = 'cron:digest-run';
  let callerRole = 'cron';
  let callerPid = '';

  if (isCronDigest) {
    if (!rateLimit(callerUid, 5)) return err(429, 'Too many digest requests; slow down.');
  } else {
    // Auth — verify the caller's JWT against Supabase. Caller is a
    // RadScheduler client; we don't accept anonymous delivery requests.
    const auth = req.headers.get('Authorization') || '';
    const jwt = auth.replace(/^Bearer\s+/i, '');
    if (!jwt) return err(401, 'Missing JWT');
    const sbAuth = createClient(sbUrl, sbAnon);
    const { data: userData, error: authErr } = await sbAuth.auth.getUser(jwt);
    if (authErr || !userData?.user) return err(401, 'Invalid JWT');

    // ── Caller identity & multi-tenant scoping ────────────────────────
    // Extract practiceId + role from server-issued app_metadata. Never
    // trust user_metadata for authorization. Without this, any authed
    // user from any practice could send arbitrary email/SMS/push/webhook
    // (open relay) and could spoof another tenant's users (cross-tenant
    // IDOR via the push handler's userId scan).
    callerUid = userData.user.id;
    const appMeta = (userData.user.app_metadata || {}) as { role?: string; practiceId?: string };
    callerRole = appMeta.role || '';
    callerPid  = appMeta.practiceId || '';

    // Rate limit per-caller — applies to all non-cron requests.
    if (!rateLimit(callerUid, 60)) return err(429, 'Too many requests; slow down.');
  }

  try {
    switch (body.kind) {
      case 'email':   return ok(await sendEmail(body, sbUrl, sbService, callerPid));
      case 'sms':     return ok(await sendSMS(body, sbUrl, sbService, callerPid));
      case 'push':    return ok(await sendPush(body, sbUrl, sbService, callerPid));
      case 'webhook': return ok(await sendWebhook(body, callerRole));
      case 'digest-run': {
        // digest-run is a privileged fanout. Reject unless either:
        //   (a) caller has admin role in their tenant (manual digest),
        //   (b) the special cron header is present + matches the env
        //       secret (pg_cron self-invocation).
        if (!isCronDigest && callerRole !== 'admin' && callerRole !== 'superuser') return err(403, 'Admin role or cron secret required');
        return ok(await runDigest(sbUrl, sbService));
      }
      default: {
        if (Array.isArray(body.recipients) && body.recipients.length && body.subject && body.body) {
          return ok(await sendEmailBatch(body, sbUrl, sbService, callerPid));
        }
        return err(400, `Unknown kind: ${body.kind}`);
      }
    }
  } catch (e) {
    console.error(`[send-notification] ${body.kind} failed:`, e instanceof Error ? e.message : String(e));
    return err(500, e instanceof Error ? e.message : String(e));
  }
});

// Verify that the caller's practice owns the recipient identifier
// (email address or phone number). Without this, any authed user can
// send arbitrary email/SMS to any address using the org's credentials.
async function _recipientInPractice(
  field: 'email' | 'phone',
  value: string,
  sbUrl: string,
  sbService: string,
  practiceId: string,
): Promise<boolean> {
  if (!practiceId || !value) return false;
  const sb = createClient(sbUrl, sbService);
  const { data, error } = await sb.from('radscheduler').select('data').eq('id', practiceId).single();
  if (error || !data) return false;
  let practice: {
    cfg?: { adminAlertEmail?: string };
    users?: Array<{ email?: string; notifyEmail?: string; phone?: string }>;
    physicians?: Array<{ email?: string; phone?: string }>;
  } = {};
  try { practice = JSON.parse((data as any).data); } catch { return false; }
  const needle = String(value).trim().toLowerCase();
  const norm = (s: string|undefined) => String(s||'').trim().toLowerCase();
  const users = practice.users || [];
  const physes = practice.physicians || [];
  if (field === 'email') {
    return users.some(u => norm(u.email) === needle || norm(u.notifyEmail) === needle) ||
           physes.some(p => norm(p.email) === needle) ||
           norm(practice.cfg?.adminAlertEmail) === needle;
  } else {
    // Phone match — strip non-digits for comparison.
    const digits = (s: string|undefined) => String(s||'').replace(/\D/g, '');
    const target = digits(value);
    if (!target || target.length < 7) return false;
    return users.some(u => digits(u.phone) === target) ||
           physes.some(p => digits(p.phone) === target);
  }
}

// Escape HTML for the email-body fallback path. The previous fallback
// only replaced \n→<br>, allowing an attacker (via body field) to
// inject <script> / <a href> / phishing markup that the recipient's
// mail client would render — coming from the practice's verified
// sender domain. Anything explicitly passed in `html` is still trusted
// (the caller has chosen to pass HTML), so admin-built templates work.
function escHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Email via Resend ──────────────────────────────────────────────────
async function sendEmail(b: Body, sbUrl?: string, sbService?: string, callerPid?: string) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = resendFrom();
  if (!apiKey) throw new Error('RESEND_API_KEY not configured');
  if (!b.to || !b.subject) throw new Error('email requires { to, subject }');
  if (typeof b.to !== 'string' || b.to.length > 254) throw new Error('email "to" invalid');
  if (b.subject.length > 998) throw new Error('email subject too long');
  if (b.body && b.body.length > 100_000) throw new Error('email body too long');
  // Multi-tenant guard — the recipient address must belong to a user
  // or physician in the caller's practice. The runDigest path passes
  // sbUrl/sbService/callerPid empty (server-side fanout); when those
  // are missing we trust the caller as a server-internal call.
  if (sbUrl && sbService && callerPid) {
    const inPractice = await _recipientInPractice('email', b.to, sbUrl, sbService, callerPid);
    if (!inPractice) throw new Error('Recipient is not a member of your practice. Refusing to send.');
  }
  // Length-cap the HTML fallback and escape user-provided body to
  // prevent injection. Caller can still pass explicit `html` for rich
  // emails — they're trusted to escape themselves there.
  const safeBody = (b.body || '').slice(0, 100_000);
  const htmlFallback = safeBody ? `<p>${escHtml(safeBody).replace(/\n/g, '<br>')}</p>` : undefined;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: b.to, subject: b.subject,
      text: safeBody,
      html: b.html || htmlFallback,
    }),
  });
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${await resp.text()}`);
  return { ok: true, kind: 'email', detail: await resp.json() };
}

async function sendEmailBatch(b: Body, sbUrl: string, sbService: string, callerPid: string) {
  if (!b.subject || !b.body) throw new Error('batch email requires { subject, body, recipients[] }');
  if (!Array.isArray(b.recipients) || !b.recipients.length) throw new Error('batch email requires recipients[]');
  if (b.recipients.length > 250) throw new Error('batch email recipient limit is 250');

  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];
  let sent = 0;
  let failed = 0;

  for (const r of b.recipients) {
    const email = String(r?.email || '').trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    try {
      const detail = await sendEmail({
        kind: 'email',
        to: email,
        subject: b.subject,
        body: b.body,
        html: b.html,
      }, sbUrl, sbService, callerPid);
      sent++;
      results.push({ email, ok: true, detail });
    } catch (e) {
      failed++;
      results.push({ email, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (sent === 0 && failed > 0) {
    const firstError = String(results.find(r => r.ok === false)?.error || 'all recipients failed');
    throw new Error(firstError);
  }
  return { ok: failed === 0, kind: 'email-batch', originalKind: b.kind, sent, failed, results };
}

// ─── SMS via Twilio ────────────────────────────────────────────────────
async function sendSMS(b: Body, sbUrl?: string, sbService?: string, callerPid?: string) {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_FROM_NUMBER');
  if (!sid || !token || !from) throw new Error('Twilio creds not configured');
  if (!b.to || !b.body) throw new Error('sms requires { to, body }');
  if (b.to.length > 20 || !/^\+?[\d\-\s().]+$/.test(b.to)) throw new Error('sms "to" invalid');
  if (b.body.length > 1600) throw new Error('sms body too long');
  // Multi-tenant guard for SMS (mirrors email path).
  if (sbUrl && sbService && callerPid) {
    const inPractice = await _recipientInPractice('phone', b.to, sbUrl, sbService, callerPid);
    if (!inPractice) throw new Error('Recipient is not a member of your practice. Refusing to send.');
  }
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
async function sendPush(b: Body, sbUrl: string, sbService: string, callerPid?: string) {
  const pub = Deno.env.get('VAPID_PUBLIC_KEY');
  const priv = Deno.env.get('VAPID_PRIVATE_KEY');
  const subject = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com';
  if (!pub || !priv) throw new Error('VAPID keys not configured');
  if (!b.userId) throw new Error('push requires { userId }');
  webpush.setVapidDetails(subject, pub, priv);
  // Multi-tenant scoping — previously the function scanned EVERY
  // practice's users[] for a matching userId, which let an attacker
  // in practice A send a push to a user in practice B (with attacker-
  // controlled title/body/url, i.e. phishing). Restrict to the
  // caller's practice; non-cron callers MUST supply callerPid.
  const sb = createClient(sbUrl, sbService);
  let rows: Array<{ id: string; data: any }> = [];
  if (callerPid) {
    const { data, error } = await sb.from('radscheduler').select('id, data').eq('id', callerPid).single();
    if (error) throw error;
    if (data) rows = [data as any];
  } else {
    // Server-internal callers (runDigest) can still scan — they trust
    // their own userId source.
    const { data, error } = await sb.from('radscheduler').select('id, data');
    if (error) throw error;
    rows = (data || []) as any;
  }
  let subscription: PushSubscriptionJSON | null = null;
  for (const r of rows) {
    try {
      const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      const u = (d.users || []).find((u: { id: string; pushSubscription?: PushSubscriptionJSON }) => u.id === b.userId);
      if (u?.pushSubscription) { subscription = u.pushSubscription; break; }
    } catch { /* skip malformed rows */ }
  }
  if (!subscription) throw new Error(`No push subscription found for user ${b.userId} in your practice`);
  // Length-cap payload — sw.js displays this verbatim. Browser push
  // services typically cap at 4KB; we cap earlier so we never get
  // surprise 413s.
  const payload = JSON.stringify({
    title: (b.title || 'RadScheduler').slice(0, 100),
    body: (b.body || '').slice(0, 500),
    url: (b.url || '/').slice(0, 1024),
    tag: 'rs-' + (b.title || '').toLowerCase().replace(/\s+/g, '-').slice(0, 40),
  });
  await webpush.sendNotification(subscription as never, payload);
  return { ok: true, kind: 'push' };
}

// ─── Outbound webhooks ─────────────────────────────────────────────────
async function sendWebhook(b: Body, callerRole?: string) {
  if (!b.url) throw new Error('webhook requires { url }');
  if (!/^https?:\/\//.test(b.url)) throw new Error('webhook url must be http(s)');
  if (b.url.length > 2048) throw new Error('webhook url too long');
  // Only admins can configure + invoke webhooks. Without this gate, a
  // physician-tier user could POST to any URL the practice's edge
  // function can reach — a vector for SSRF / pivot / spam.
  if (callerRole !== 'admin' && callerRole !== 'superuser') throw new Error('Webhook delivery requires admin role.');
  // SSRF guard — block private/loopback/metadata destinations.
  let parsed: URL;
  try { parsed = new URL(b.url); }
  catch { throw new Error('webhook url malformed'); }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error('webhook url targets a private/internal host — refusing.');
  }
  // Length-cap the JSON body to keep error responses from being
  // weaponized as data exfil channels.
  const bodyStr = JSON.stringify(b.payload || {});
  if (bodyStr.length > 32_768) throw new Error('webhook payload too large (>32KB)');
  // 10s timeout — webhooks shouldn't be long-running fetches; if the
  // remote is slow we don't want to tie up edge resources.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let resp: Response;
  try {
    resp = await fetch(parsed.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'RadScheduler/1.0' },
      body: bodyStr,
      signal: ctrl.signal,
      redirect: 'error', // refuse 3xx — prevents redirect-to-internal SSRF
    });
  } finally {
    clearTimeout(timer);
  }
  // Slack / Teams / etc. return 200 OK with a tiny "ok" body. We just
  // surface non-2xx as failure but DON'T echo the remote body to the
  // caller — it could contain internal hints (e.g. "Slack Webhook
  // 'invalid_token'" leaks practice config). Caller's audit log
  // captures intent.
  if (!resp.ok) throw new Error(`webhook ${resp.status}`);
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
      id: string; email?: string; notifyEmail?: string; physId?: number;
      notifPrefs?: { master?: boolean; digest?: boolean };
    }>;
    const physicians = (practice.physicians || []) as Array<{ id: number; last?: string; first?: string }>;
    const drShifts = (practice.drShifts || []) as Array<{ physId: number; date: string; shift: string; site?: string }>;
    const irShifts = (practice.irShifts || []) as Array<{ physId: number; date: string; shift: string; site?: string }>;
    const irCalls  = (practice.irCalls  || []) as Array<{ physId: number; date: string; callType: string }>;
    const wknds    = (practice.weekendCalls || []) as Array<{ physId: number; satDate?: string; date?: string }>;
    for (const u of users) {
      const deliveryEmail = (u.notifyEmail || u.email || '').trim().toLowerCase();
      if (!deliveryEmail || !u.physId) { skipped++; continue; }
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
          to: deliveryEmail,
          subject: `Your RadScheduler week — ${today}`,
          body: lines.join('\n'),
        });
        sent++;
      } catch (e) {
        console.warn('digest send failed for', deliveryEmail, e);
      }
    }
  }
  return { ok: true, kind: 'digest-run', detail: { sent, skipped } };
}
