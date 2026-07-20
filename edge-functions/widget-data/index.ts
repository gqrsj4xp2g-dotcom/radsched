// widget-data — read/write proxy for the RadScheduler desktop widget.
//
// The desktop widget authenticates with a short-lived, signed pairing
// credential rather than a browser user session.
//
// Auth model:
//   1. The widget POSTs the full pairing code (the same base64 blob
//      the admin generated in RadScheduler) as { code }.
//   2. We decode + verify the HMAC-SHA256 signature using the server-side
//      per-practice widget secret stored in a service-role-only table.
//   3. For v2+ codes, we also confirm the code is still present in the
//      active widgetPairings list so admin revocation takes effect.
//   4. On verify-success we use the SERVICE ROLE key (server-side only)
//      to fetch / update the practice row. Bypasses RLS but only for
//      codes we cryptographically verified.
//
// Operations (all POST, body shapes below):
//   { code }
//     → returns { data: <full practice JSON> }
//   { code, action: 'add-credit', credit: {ts, hours, reason} }
//     → appends to practice.physicianCredits, returns { ok, credit }
//   { code, action: 'edit-credit', creditId, patch: {ts?, hours?, reason?} }
//     → updates the matching credit by id (must belong to this physId)
//   { code, action: 'delete-credit', creditId }
//     → removes the credit (must belong to this physId)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SB_URL  = Deno.env.get('SUPABASE_URL')!;
const SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type RateState = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateState>();

function clientAddress(req: Request): string {
  return (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown')
    .split(',')[0].trim().slice(0, 80);
}

function rateAllowed(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    if (rateBuckets.size > 5_000) {
      for (const [bucket, state] of rateBuckets) {
        if (state.resetAt <= now) rateBuckets.delete(bucket);
      }
    }
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function fromB64Url(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

async function hmacB64Url(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  const bytes = new Uint8Array(mac);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function codeFingerprint(code: string): string {
  return String(code || '').trim().slice(-8);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function jwtAal(token: string): string {
  try {
    const part = token.split('.')[1] || '';
    return String(JSON.parse(fromB64Url(part))?.aal || '').toLowerCase();
  } catch { return ''; }
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function practiceSigningSecret(sb: any, practiceId: string, create = false): Promise<string | null> {
  const { data, error } = await sb.from('rs_widget_secrets')
    .select('secret').eq('practice_id', practiceId).maybeSingle();
  if (error) throw new Error('pairing secret lookup failed: ' + error.message);
  if (data?.secret) return String(data.secret);
  if (!create) return null;
  const secret = randomSecret();
  const { data: created, error: createErr } = await sb.from('rs_widget_secrets')
    .upsert({ practice_id: practiceId, secret }, { onConflict: 'practice_id', ignoreDuplicates: true })
    .select('secret').maybeSingle();
  if (createErr) throw new Error('pairing secret creation failed: ' + createErr.message);
  if (created?.secret) return String(created.secret);
  // Another request may have inserted the row between the lookup and upsert.
  // Re-read instead of returning the losing request's transient secret.
  const { data: raced, error: racedErr } = await sb.from('rs_widget_secrets')
    .select('secret').eq('practice_id', practiceId).single();
  if (racedErr || !raced?.secret) throw new Error('pairing secret creation could not be confirmed');
  return String(raced.secret);
}

// Strip practice-level secrets from the blob before handing it to the widget.
// SECURITY (2026-07): the `read` action returned the entire practice JSON,
// which included cfg._widgetSecret (the HMAC signing key for pairing codes) and
// the widgetPairings records — a widget that received one could forge or
// enumerate pairings. The widget only needs schedule/wRVU/credit data, so we
// deep-clone and remove anything secret-shaped.
function sanitizeForWidget(p: any): any {
  let c: any;
  try { c = JSON.parse(JSON.stringify(p)); } catch (_) { return {}; }
  if (c && c.cfg && typeof c.cfg === 'object') {
    // Broadened to catch bare *key (e.g. mapsKey — a live Google Maps API key)
    // and *credential, not just *apikey.
    for (const k of Object.keys(c.cfg)) {
      if (/secret|token|password|api|key|credential|private/i.test(k)) delete c.cfg[k];
    }
  }
  if (c) delete c.widgetPairings;               // per-code signing material
  // WHITELIST user fields — the widget only needs identity/display. A blacklist
  // missed per-user bearer credentials (calFeedToken, a 30-day ICS bearer that
  // survives pairing revocation); a whitelist drops those and any future secret.
  if (Array.isArray(c?.users)) {
    c.users = c.users.map((u: any) => u ? {
      id: u.id, physId: u.physId, first: u.first, last: u.last,
      role: u.role, degree: u.degree, active: u.active, color: u.color,
    } : u);
  }
  return c;
}

// `purpose` differentiates two issuing flows that share the same
// HMAC envelope: 'widget' (read+write — credits) vs 'cal-feed'
// (read-only — ICS). The verifier enforces that the caller's
// requested action matches the code's purpose, so a leaked
// cal-feed URL CAN'T be pasted into the widget to add credits,
// and a leaked widget pairing CAN'T be turned into an ICS URL
// (which would otherwise leak read access for 30+ days even if
// the admin revokes the widget pairing).
//
// Backward compat: codes issued before the kind discriminator
// landed have neither `kind` nor `purpose` and default to
// 'widget' so existing pairings keep working.
function payloadPurpose(payload: any): 'widget' | 'cal-feed' {
  if (payload?.kind === 'cal-feed' || payload?.purpose === 'cal-feed') return 'cal-feed';
  return 'widget';
}

// Two-stage decoder:
//   1. Decode + sanity-check the base64 envelope.
//   2. Stage-2 verify the HMAC against the practice's server-side
//      secret. The practice secret is fetched in the caller (since
//      the caller already does a Supabase fetch for the data) and
//      passed back into _verifyHmac().
function _decodeEnvelope(code: string): any {
  if (!code || typeof code !== 'string') throw new Error('missing code');
  if (code.length > 8_192) throw new Error('pairing code is too large');
  let payload: any;
  try { payload = JSON.parse(fromB64Url(code.trim())); }
  catch (_) { throw new Error('malformed code'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('malformed code');
  if (typeof payload.sig !== 'string' || payload.sig.length !== 43 ||
      typeof payload.practiceId !== 'string' || !payload.practiceId.trim() || payload.practiceId.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(payload.practiceId) ||
      !Number.isSafeInteger(+payload.physId) || +payload.physId <= 0) {
    throw new Error('pairing payload missing required fields');
  }
  // exp is now REQUIRED. Tokens without an expiry are forever-valid
  // and outlive any reasonable threat-model assumption.
  if (!payload.exp) throw new Error('pairing has no expiry — re-issue required');
  const expiry = new Date(payload.exp).getTime();
  if (!Number.isFinite(expiry)) throw new Error('pairing expiry is invalid');
  if (expiry < Date.now()) {
    throw new Error('pairing expired');
  }
  // Hard ceiling: reject tokens with absurd expiry (e.g. 100 years
  // out) — a misissued token shouldn't live longer than the company.
  const maxExp = Date.now() + 366 * 86400_000 * 2; // ~2 years
  if (expiry > maxExp) {
    throw new Error('pairing expiry too far in the future');
  }
  return payload;
}

async function _verifyHmac(
  payload: any,
  practiceSecret: string | null,
  requiredPurpose: 'widget' | 'cal-feed' | 'any',
): Promise<void> {
  const { sig, ...rest } = payload;
  // Only v2+ tokens are accepted. Legacy v1 tokens were signed with the
  // public anon key and were therefore forgeable by any site visitor.
  const tokenVersion = +(payload.v || 1);
  if (tokenVersion < 2) throw new Error('legacy pairing code rejected — ask an administrator to re-pair this widget');
  if (!practiceSecret) throw new Error('practice pairing secret is not configured');
  let matched = false;
  if (practiceSecret) {
    const expected = await hmacB64Url(practiceSecret, JSON.stringify(rest));
    matched = constantTimeEqual(expected, sig);
  }
  if (!matched) throw new Error('signature mismatch — pairing must be re-issued');
  const actual = payloadPurpose(payload);
  if (requiredPurpose !== 'any' && actual !== requiredPurpose) {
    throw new Error(`token purpose mismatch (got '${actual}', need '${requiredPurpose}')`);
  }
}

function assertActiveWidgetPairing(practice: any, payload: any, code: string): void {
  // The registry is mandatory. Missing and empty registries both fail closed;
  // an administrator must issue a tracked v2 pairing before access works.
  if (!Array.isArray(practice?.widgetPairings)) throw new Error('pairing registry is not configured');
  const pairings = practice.widgetPairings;
  const tokenVersion = +(payload?.v || 1);
  if (tokenVersion < 2 || payload?.pairingId == null) throw new Error('untracked legacy pairing rejected');
  const fp = codeFingerprint(code);
  const pairingId = payload?.pairingId != null ? +payload.pairingId : null;
  const now = Date.now();
  const match = pairings.find((p: any) => {
    if (!p) return false;
    const idMatches = pairingId != null && +p.id === pairingId;
    const fpMatches = pairingId == null && fp && p.fingerprint === fp;
    if (!idMatches && !fpMatches) return false;
    if (+p.physId !== +payload.physId) return false;
    if (p.exp && new Date(p.exp).getTime() < now) return false;
    return true;
  });
  if (!match) throw new Error('pairing revoked or not active — ask admin to issue a fresh code');
}

// ── ICS calendar feed ────────────────────────────────────────────
// Generates an RFC 5545 iCalendar document containing every shift
// for the physician identified in the pairing code, from 30 days
// ago through 365 days in the future. Calendar apps (Google,
// Apple, Outlook) refresh this URL periodically — typically every
// 4-24h — so schedule changes propagate without any push.
//
// Security: the URL contains the full HMAC-signed pairing code as
// a query parameter. Same auth model as the rest of the function.
// Physicians treat the URL like a password.
function _icsEscape(s: string): string {
  // RFC 5545: commas, semicolons, backslashes, newlines need escaping.
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\r?\n/g, '\\n');
}
function _icsDateLocal(isoDate: string): string {
  // All-day event format: YYYYMMDD (date only, no time, no TZ).
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate || '');
  if (!m) return '';
  return m[1] + m[2] + m[3];
}
function _icsDtStamp(d?: Date): string {
  const dd = d || new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return dd.getUTCFullYear() + pad(dd.getUTCMonth() + 1) + pad(dd.getUTCDate())
    + 'T' + pad(dd.getUTCHours()) + pad(dd.getUTCMinutes()) + pad(dd.getUTCSeconds()) + 'Z';
}
function buildICSForPhysician(practice: any, physId: number, physName: string): string {
  // Window: 30 days ago through 365 days ahead. Calendar clients
  // can cache more, but no client needs older shifts.
  const today = new Date();
  const start = new Date(today); start.setDate(start.getDate() - 30);
  const end   = new Date(today); end.setDate(end.getDate() + 365);
  const startISO = start.toISOString().slice(0, 10);
  const endISO   = end.toISOString().slice(0, 10);
  const events: string[] = [];
  const stamp = _icsDtStamp();
  // Helper to emit one VEVENT for an all-day "block".
  function emit(uid: string, dateISO: string, summary: string, description: string){
    if (!dateISO || dateISO < startISO || dateISO > endISO) return;
    // All-day event: DTSTART is the date, DTEND is the next day
    // (exclusive). DTSTAMP is when the iCal was generated.
    const next = new Date(dateISO + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    const nextISO = next.toISOString().slice(0, 10);
    events.push([
      'BEGIN:VEVENT',
      'UID:' + uid + '@radscheduler.app',
      'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + _icsDateLocal(dateISO),
      'DTEND;VALUE=DATE:' + _icsDateLocal(nextISO),
      'SUMMARY:' + _icsEscape(summary),
      'DESCRIPTION:' + _icsEscape(description),
      'CATEGORIES:RadScheduler',
      'TRANSP:OPAQUE',
      'END:VEVENT',
    ].join('\r\n'));
  }
  // DR shifts
  for (const s of (practice.drShifts || [])) {
    if (s.physId !== physId) continue;
    const summary = `🩻 ${s.shift || ''} · ${s.site || ''}`.trim();
    const desc = [
      s.shift ? `Shift: ${s.shift}` : '',
      s.site ? `Site: ${s.site}` : '',
      s.sub ? `Subspecialty: ${s.sub}` : '',
      s.notes ? `Notes: ${s.notes}` : '',
    ].filter(Boolean).join('\n');
    emit(`dr-${s.id}`, s.date, summary, desc);
  }
  // IR shifts
  for (const s of (practice.irShifts || [])) {
    if (s.physId !== physId) continue;
    const summary = `🩺 IR ${s.shift || ''} · ${s.site || ''}`.trim();
    const desc = [
      s.shift ? `IR shift: ${s.shift}` : '',
      s.site ? `Site: ${s.site}` : '',
      s.sub ? `Subspecialty: ${s.sub}` : '',
      s.notes ? `Notes: ${s.notes}` : '',
    ].filter(Boolean).join('\n');
    emit(`ir-${s.id}`, s.date, summary, desc);
  }
  // IR calls
  for (const c of (practice.irCalls || [])) {
    if (c.physId !== physId) continue;
    const summary = `📟 IR ${c.callType || 'daily'} call`;
    const desc = [
      `Call type: ${c.callType || 'daily'}`,
      c.irGroup ? `IR group: ${c.irGroup}` : '',
      c.notes ? `Notes: ${c.notes}` : '',
    ].filter(Boolean).join('\n');
    emit(`irc-${c.id}`, c.date, summary, desc);
  }
  // Weekend calls
  for (const w of (practice.weekendCalls || [])) {
    if (w.physId !== physId) continue;
    const summary = '📟 Weekend call';
    const desc = w.notes ? `Notes: ${w.notes}` : '';
    if (w.satDate) emit(`wk-${w.id}-sat`, w.satDate, summary + ' (Sat)', desc);
    if (w.sunDate) emit(`wk-${w.id}-sun`, w.sunDate, summary + ' (Sun)', desc);
  }
  // Holidays
  for (const h of (practice.holidays || [])) {
    if (h.physId !== physId) continue;
    const summary = `🎉 Holiday: ${h.name || ''}`;
    const desc = [
      h.group ? `Group: ${h.group}` : '',
      h.notes ? `Notes: ${h.notes}` : '',
    ].filter(Boolean).join('\n');
    emit(`hol-${h.id}`, h.date, summary, desc);
  }
  // Vacations — show as multi-day blocks.
  for (const v of (practice.vacations || [])) {
    if (v.physId !== physId) continue;
    if (!v.start || !v.end || v.end < v.start) continue;
    const summary = `🏖 Vacation${v.type ? ' · ' + v.type : ''}`;
    const desc = v.notes ? `Notes: ${v.notes}` : '';
    // Emit one VEVENT spanning start → end+1.
    const startD = _icsDateLocal(v.start);
    if (!startD) continue;
    if (v.start > endISO || v.end < startISO) continue;
    const endPlus = new Date(v.end + 'T00:00:00Z');
    endPlus.setUTCDate(endPlus.getUTCDate() + 1);
    const endPlusISO = endPlus.toISOString().slice(0, 10);
    events.push([
      'BEGIN:VEVENT',
      `UID:vac-${v.id}@radscheduler.app`,
      'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + _icsDateLocal(v.start),
      'DTEND;VALUE=DATE:' + _icsDateLocal(endPlusISO),
      'SUMMARY:' + _icsEscape(summary),
      'DESCRIPTION:' + _icsEscape(desc),
      'CATEGORIES:RadScheduler',
      'TRANSP:TRANSPARENT',  // vacation = not busy
      'END:VEVENT',
    ].join('\r\n'));
  }
  // Wrap in VCALENDAR. The X-WR-CALNAME header sets the calendar's
  // display name in most clients (Google, Apple). REFRESH-INTERVAL
  // is a hint to clients to re-fetch every 4 hours.
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RadScheduler//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + _icsEscape(`RadScheduler — ${physName}`),
    'X-WR-TIMEZONE:UTC',
    'X-PUBLISHED-TTL:PT4H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT4H',
    ...events,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // ── ICS feed: GET ?code=... → text/calendar ──────────────────────
  // Calendar clients (Google Cal, Apple Cal, Outlook) hit subscribe
  // URLs with GET. They do NOT send custom headers, so we accept the
  // code as a query string param. The HMAC sig in the code is still
  // verified before any data leaves the function.
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const code = url.searchParams.get('code') || '';
    if (!rateAllowed(`ics-ip:${clientAddress(req)}`, 300)) {
      return new Response('Too many calendar requests.', { status: 429, headers: { ...CORS, 'Cache-Control': 'private, no-store' } });
    }
    if (!rateAllowed(`ics:${clientAddress(req)}:${codeFingerprint(code)}`, 120)) {
      return new Response('Too many calendar requests.', { status: 429, headers: { ...CORS, 'Cache-Control': 'private, no-store' } });
    }
    const action = url.searchParams.get('action') || 'ics';
    if (action !== 'ics') {
      return new Response('Use POST for read/write actions; GET only supports action=ics.', { status: 405, headers: CORS });
    }
    let payload: any;
    try { payload = _decodeEnvelope(code); }
    catch (e) { return new Response('Invalid or expired calendar feed URL: ' + (e as Error).message, { status: 401, headers: CORS }); }
    const sb = createClient(SB_URL, SVC_KEY);
    // Authenticate the envelope before reading any practice data.
    let practiceSecret: string | null = null;
    try { practiceSecret = await practiceSigningSecret(sb, payload.practiceId); }
    catch (_) { return new Response('Calendar credential verification failed.', { status: 500, headers: CORS }); }
    try { await _verifyHmac(payload, practiceSecret, 'cal-feed'); }
    catch (e) { return new Response('Invalid or expired calendar feed URL: ' + (e as Error).message, { status: 401, headers: CORS }); }
    const { data, error } = await sb
      .from('radscheduler').select('data').eq('id', payload.practiceId).single();
    if (error) return new Response('Calendar data is temporarily unavailable.', { status: 500, headers: CORS });
    if (!data) return new Response('Practice not found', { status: 404, headers: CORS });
    const practice = (function parse(raw: any){
      if (raw == null) return {};
      if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
      return raw;
    })((data as any).data);
    const physName = `${payload.physFirst || ''} ${payload.physLast || ''}`.trim() || `Physician ${payload.physId}`;
    const ics = buildICSForPhysician(practice, payload.physId, physName);
    return new Response(ics, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `inline; filename="radscheduler-${payload.physId}.ics"`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  if (req.method !== 'POST') return jsonResp({ error: 'POST or GET only' }, 405);
  const declaredLength = +(req.headers.get('content-length') || 0);
  if (declaredLength > 65_536) return jsonResp({ error: 'request body too large' }, 413);
  let rawBody = '';
  try { rawBody = await req.text(); }
  catch (_) { return jsonResp({ error: 'could not read request body' }, 400); }
  if (new TextEncoder().encode(rawBody).length > 65_536) return jsonResp({ error: 'request body too large' }, 413);
  let body: any;
  try { body = JSON.parse(rawBody); }
  catch (_) { return jsonResp({ error: 'invalid JSON body' }, 400); }
  if (typeof body !== 'object' || body == null || Array.isArray(body)) return jsonResp({ error: 'invalid body' }, 400);
  const sb = createClient(SB_URL, SVC_KEY);
  const action = body.action || 'read';
  if (!rateAllowed(`post-ip:${clientAddress(req)}`, 300)) return jsonResp({ error: 'too many requests; retry shortly' }, 429);

  // Pairing/calendar credentials are issued only by this server. The signing
  // key never crosses the trust boundary into the browser or practice blob.
  if (action === 'issue') {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return jsonResp({ error: 'authenticated session required' }, 401);
    const authClient = createClient(SB_URL, ANON_KEY);
    const { data: authData, error: authErr } = await authClient.auth.getUser(jwt);
    if (authErr || !authData?.user) return jsonResp({ error: 'invalid or expired session' }, 401);
    const user = authData.user;
    if (!rateAllowed(`issue:${clientAddress(req)}:${user.id}`, 10)) {
      return jsonResp({ error: 'too many credential issuance requests; retry shortly' }, 429);
    }
    const meta = user.app_metadata || {};
    const role = String(meta.role || '');
    const practiceId = typeof body.practiceId === 'string' ? body.practiceId.trim() : '';
    const physId = +body.physId;
    const purpose = body.purpose === 'cal-feed' ? 'cal-feed' : 'widget';
    if (!practiceId || practiceId.length > 200 || /[\u0000-\u001f\u007f]/.test(practiceId) ||
        !Number.isSafeInteger(physId) || physId <= 0) {
      return jsonResp({ error: 'practiceId and a valid physId are required' }, 400);
    }
    if (role !== 'superuser' && String(meta.practiceId || '') !== practiceId) {
      return jsonResp({ error: 'cross-practice issuance denied' }, 403);
    }
    const { data: issueRow, error: issueErr } = await sb.from('radscheduler')
      .select('data,saved_at').eq('id', practiceId).single();
    if (issueErr || !issueRow) return jsonResp({ error: 'practice not found' }, 404);
    let issuePractice: any;
    try { issuePractice = typeof issueRow.data === 'string' ? JSON.parse(issueRow.data) : issueRow.data; }
    catch (_) { return jsonResp({ error: 'practice data is malformed' }, 500); }
    if (!issuePractice || typeof issuePractice !== 'object') return jsonResp({ error: 'practice data is malformed' }, 500);
    const physician = (issuePractice.physicians || []).find((p: any) => +p.id === physId);
    if (!physician) return jsonResp({ error: 'physician not found in practice' }, 404);
    if (purpose === 'widget') {
      if (!['admin', 'superuser'].includes(role) || jwtAal(jwt) !== 'aal2') {
        return jsonResp({ error: 'admin MFA verification required to issue a widget pairing' }, 403);
      }
    } else {
      const ownsPhysician = (issuePractice.users || []).some((u: any) =>
        String(u?.id || '') === user.id && +u?.physId === physId
      );
      if (!ownsPhysician) return jsonResp({ error: 'calendar feeds may only be issued for your linked physician' }, 403);
    }
    const secret = await practiceSigningSecret(sb, practiceId, true);
    if (!secret) return jsonResp({ error: 'pairing secret unavailable' }, 500);
    const requestedDays = body.days == null ? (purpose === 'widget' ? 30 : 365) : +body.days;
    if (!Number.isFinite(requestedDays)) return jsonResp({ error: 'days must be a number' }, 400);
    const days = Math.max(1, Math.min(Math.floor(requestedDays), 365));
    const issuedAt = new Date().toISOString();
    const exp = new Date(Date.now() + days * 86400_000).toISOString();
    const pairingId = purpose === 'widget'
      ? Math.max(+(issuePractice.nextId || 100), ...(issuePractice.widgetPairings || []).map((p: any) => +p?.id || 0)) + 1
      : undefined;
    const unsigned: any = {
      v: 2,
      ...(purpose === 'widget' ? { pairingId } : { kind: 'cal-feed' }),
      practiceId,
      physId,
      physLast: physician.last || '',
      physFirst: physician.first || '',
      sbUrl: SB_URL,
      sbAnonKey: ANON_KEY,
      issuedAt,
      exp,
    };
    const sig = await hmacB64Url(secret, JSON.stringify(unsigned));
    const code = btoa(JSON.stringify({ ...unsigned, sig }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (purpose === 'widget') {
      if (!Array.isArray(issuePractice.widgetPairings)) issuePractice.widgetPairings = [];
      issuePractice.widgetPairings.push({
        id: pairingId,
        physId,
        issuedAt,
        exp,
        issuedBy: user.id,
        fingerprint: codeFingerprint(code),
      });
      issuePractice.nextId = Math.max(+(issuePractice.nextId || 0), pairingId!);
      const { data: saved, error: saveErr } = await sb.rpc('rs_save_practice_cas', {
        p_practice: practiceId,
        p_data: JSON.stringify(issuePractice),
        p_expected_saved_at: issueRow.saved_at || null,
      });
      if (saveErr) return jsonResp({ error: 'pairing registry save failed: ' + saveErr.message }, 500);
      if (!saved?.ok) return jsonResp({ error: 'practice changed while issuing; retry' }, 409);
    }
    return jsonResp({ ok: true, code, exp, pairingId, purpose });
  }
  let payload: any;
  // POST path: widget operations (read practice / add+edit+delete
  // credit). Stage-1 decode (no HMAC verify yet — need the practice's
  // server-side secret first).
  try { payload = _decodeEnvelope(body.code); }
  catch (e) { return jsonResp({ error: String((e as Error).message) }, 401); }
  // Action allowlist — reject anything we don't explicitly support
  // before we waste a DB read on it.
  const ALLOWED_ACTIONS = new Set(['read', 'add-credit', 'edit-credit', 'delete-credit', 'peer-open']);
  if (!ALLOWED_ACTIONS.has(action)) return jsonResp({ error: `unknown action: ${action}` }, 400);
  const requestLimit = action === 'read' ? 120 : 20;
  if (!rateAllowed(`widget:${action}:${clientAddress(req)}:${codeFingerprint(body.code)}`, requestLimit)) {
    return jsonResp({ error: 'too many widget requests; retry shortly' }, 429);
  }

  // Helper: the radscheduler table's `data` column is text (NOT jsonb)
  // — the main app stores JSON.stringify(...) into it. PostgREST
  // therefore returns it as a string. We MUST parse before returning
  // to the widget, or every array access (.drShifts, .physicians,
  // etc.) is undefined on the widget side. Past behaviour silently
  // returned a string and the widget rendered an empty schedule.
  function parsePracticeData(raw: any): any {
    if (raw == null) return {};
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); }
      catch (_) { return {}; }
    }
    return raw;
  }

  // Verify the signed envelope before reading any practice data.
  let practiceSecret: string | null = null;
  try { practiceSecret = await practiceSigningSecret(sb, payload.practiceId); }
  catch (_) { return jsonResp({ error: 'pairing credential verification failed' }, 500); }
  try { await _verifyHmac(payload, practiceSecret, 'widget'); }
  catch (e) { return jsonResp({ error: String((e as Error).message) }, 401); }
  const { data: row, error: rdErr } = await sb
    .from('radscheduler').select('data').eq('id', payload.practiceId).single();
  if (rdErr) return jsonResp({ error: 'practice data is temporarily unavailable' }, 500);
  if (!row) return jsonResp({ error: 'practice not found' }, 404);
  const practice = parsePracticeData((row as any).data);
  try { assertActiveWidgetPairing(practice, payload, body.code); }
  catch (e) { return jsonResp({ error: String((e as Error).message) }, 401); }
  if (!Array.isArray(practice.physicianCredits)) practice.physicianCredits = [];

  // ── READ ────────────────────────────────────────────────────────
  if (action === 'read') {
    return jsonResp({ data: sanitizeForWidget(practice) });
  }

  async function loadFreshPracticeForWrite(): Promise<{ practice: any; savedAt: string | null }> {
    const { data: freshRow, error: freshErr } = await sb
      .from('radscheduler').select('data,saved_at').eq('id', payload.practiceId).single();
    if (freshErr) throw new Error('practice refresh failed: ' + freshErr.message);
    if (!freshRow) throw new Error('practice not found');
    const fresh = parsePracticeData((freshRow as any).data);
    const freshSecret = await practiceSigningSecret(sb, payload.practiceId);
    await _verifyHmac(payload, freshSecret, 'widget');
    assertActiveWidgetPairing(fresh, payload, body.code);
    if (!Array.isArray(fresh.physicianCredits)) fresh.physicianCredits = [];
    return { practice: fresh, savedAt: (freshRow as any).saved_at || null };
  }

  async function writePracticeData(nextPractice: any, expectedSavedAt: string | null) {
    const { data, error } = await sb.rpc('rs_save_practice_cas', {
      p_practice: payload.practiceId,
      p_data: JSON.stringify(nextPractice),
      p_expected_saved_at: expectedSavedAt,
    });
    if (error) return { error, conflict: false };
    if (!data?.ok) return { error: new Error('practice changed during widget edit; refresh and retry'), conflict: true };
    return { error: null, conflict: false };
  }

  // Helper: allocate against the freshest practice row so a widget write
  // doesn't reuse a stale nextId after the main app has saved newer changes.
  function allocateId(target: any): number {
    const creditMax = (target.physicianCredits || []).reduce(
      (max: number, c: any) => Math.max(max, +c?.id || 0),
      0,
    );
    const next = Math.max(+target.nextId || 100, creditMax) + 1;
    target.nextId = next;
    return next;
  }

  // ── ADD CREDIT ──────────────────────────────────────────────────
  if (action === 'add-credit') {
    const c = body.credit || {};
    const hours = +c.hours;
    const reason = (c.reason || '').toString().trim().slice(0, 200);
    const ts = (c.ts || new Date().toISOString()).toString().slice(0, 40);
    if (!hours || hours <= 0 || hours > 24) return jsonResp({ error: 'hours must be in (0, 24]' }, 400);
    if (!reason) return jsonResp({ error: 'reason is required' }, 400);
    let snapshot: { practice: any; savedAt: string | null };
    try { snapshot = await loadFreshPracticeForWrite(); }
    catch (e) { return jsonResp({ error: String((e as Error).message) }, 409); }
    const latest = snapshot.practice;
    // Soft cap on credit history per physician — protects against
    // accidental flood (e.g. a buggy widget retry loop).
    const myCreditCount = latest.physicianCredits.filter((c: any) => c.physId === payload.physId).length;
    if (myCreditCount > 1000) return jsonResp({ error: 'credit history limit reached for this physician (1000)' }, 429);
    const credit = {
      id: allocateId(latest),
      physId: payload.physId,
      ts,
      hours,
      reason,
      createdBy: payload.physId,
      createdAt: new Date().toISOString(),
    };
    latest.physicianCredits.push(credit);
    const write = await writePracticeData(latest, snapshot.savedAt);
    if (write.error) return jsonResp({ error: 'write failed: ' + write.error.message }, write.conflict ? 409 : 500);
    return jsonResp({ ok: true, credit });
  }

  // ── EDIT CREDIT ─────────────────────────────────────────────────
  if (action === 'edit-credit') {
    const id = +body.creditId;
    const patch = body.patch || {};
    if (!id) return jsonResp({ error: 'creditId required' }, 400);
    let snapshot: { practice: any; savedAt: string | null };
    try { snapshot = await loadFreshPracticeForWrite(); }
    catch (e) { return jsonResp({ error: String((e as Error).message) }, 409); }
    const latest = snapshot.practice;
    const idx = latest.physicianCredits.findIndex((c: any) => c.id === id);
    if (idx < 0) return jsonResp({ error: 'credit not found' }, 404);
    const credit = latest.physicianCredits[idx];
    if (credit.physId !== payload.physId) return jsonResp({ error: 'cannot edit another physician\'s credit' }, 403);
    if (patch.hours != null) {
      const h = +patch.hours;
      if (!h || h <= 0 || h > 24) return jsonResp({ error: 'hours must be in (0, 24]' }, 400);
      credit.hours = h;
    }
    if (patch.reason != null) {
      const r = String(patch.reason).trim().slice(0, 200);
      if (!r) return jsonResp({ error: 'reason cannot be empty' }, 400);
      credit.reason = r;
    }
    if (patch.ts != null) credit.ts = String(patch.ts).slice(0, 40);
    credit.updatedAt = new Date().toISOString();
    latest.physicianCredits[idx] = credit;
    const write = await writePracticeData(latest, snapshot.savedAt);
    if (write.error) return jsonResp({ error: 'write failed: ' + write.error.message }, write.conflict ? 409 : 500);
    return jsonResp({ ok: true, credit });
  }

  // ── DELETE CREDIT ───────────────────────────────────────────────
  if (action === 'delete-credit') {
    const id = +body.creditId;
    if (!id) return jsonResp({ error: 'creditId required' }, 400);
    let snapshot: { practice: any; savedAt: string | null };
    try { snapshot = await loadFreshPracticeForWrite(); }
    catch (e) { return jsonResp({ error: String((e as Error).message) }, 409); }
    const latest = snapshot.practice;
    const idx = latest.physicianCredits.findIndex((c: any) => c.id === id);
    if (idx < 0) return jsonResp({ error: 'credit not found' }, 404);
    if (latest.physicianCredits[idx].physId !== payload.physId) {
      return jsonResp({ error: 'cannot delete another physician\'s credit' }, 403);
    }
    latest.physicianCredits.splice(idx, 1);
    const write = await writePracticeData(latest, snapshot.savedAt);
    if (write.error) return jsonResp({ error: 'write failed: ' + write.error.message }, write.conflict ? 409 : 500);
    return jsonResp({ ok: true });
  }

  // ── PEER-OPEN ───────────────────────────────────────────────────
  // Trigger a peer review of a PRIOR report on the patient the physician is
  // currently reading. Finds the most recent prior report by a DIFFERENT
  // radiologist and creates a pending rs_peer_reviews row assigned to the
  // reader, which then surfaces in the app's "Pending reviews" list to grade.
  if (action === 'peer-open') {
    const readerPhysId = payload.physId;
    if (readerPhysId == null) return jsonResp({ error: 'physId required' }, 400);
    // reviewer_uid is NOT NULL and this function runs as service role (no
    // auth.uid), so resolve the reader's account uid from the practice roster.
    const reviewerUser = Array.isArray(practice.users)
      ? practice.users.find((u: any) => u && Number(u.physId) === Number(readerPhysId)) : null;
    const reviewerUid = reviewerUser && reviewerUser.id;
    if (!reviewerUid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(reviewerUid)))
      return jsonResp({ error: 'reader has no linked account; cannot open a review' }, 409);
    const accIn = (body.accession || '').toString().trim();
    let mrn = (body.mrn || '').toString().trim();
    if (!mrn && accIn) {
      const { data: cur } = await sb.from('rs_reports').select('mrn')
        .eq('practice_id', payload.practiceId).eq('accession', accIn).limit(1).maybeSingle();
      mrn = (cur as any)?.mrn || '';
    }
    if (!mrn) return jsonResp({ error: 'mrn or accession required' }, 400);
    const { data: priors } = await sb.from('rs_reports')
      .select('report_uid, accession, phys_id, signed_at, exam')
      .eq('practice_id', payload.practiceId).eq('mrn', mrn)
      .order('signed_at', { ascending: false }).limit(25);
    const prior = (priors || []).find((r: any) =>
      r.phys_id != null && Number(r.phys_id) !== Number(readerPhysId) && r.accession !== accIn);
    if (!prior) return jsonResp({ error: 'no prior report by another radiologist for this patient' }, 404);
    const { data: existing } = await sb.from('rs_peer_reviews')
      .select('id, status').eq('practice_id', payload.practiceId)
      .eq('report_uid', prior.report_uid).eq('reviewer_uid', reviewerUid).limit(1).maybeSingle();
    if (existing) return jsonResp({ ok: true, existing: true,
      review: { id: (existing as any).id, report_uid: prior.report_uid, status: (existing as any).status, reviewed_phys_id: prior.phys_id, exam: prior.exam } });
    const now = new Date();
    const quarter = `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
    const { data: ins, error: insErr } = await sb.from('rs_peer_reviews').insert({
      practice_id: payload.practiceId, report_uid: prior.report_uid, accession: prior.accession,
      reviewed_phys_id: prior.phys_id, reviewer_phys_id: readerPhysId, reviewer_uid: reviewerUid,
      quarter, status: 'pending', origin: 'manual',   // on-demand widget review, not the once-per-shift auto slot
    }).select('id').maybeSingle();
    if (insErr) return jsonResp({ error: 'could not open review: ' + insErr.message }, 500);
    return jsonResp({ ok: true, review: { id: (ins as any)?.id, report_uid: prior.report_uid, reviewed_phys_id: prior.phys_id, exam: prior.exam, status: 'pending' } });
  }

  return jsonResp({ error: 'unknown action: ' + action }, 400);
});
