// widget-data — read/write proxy for the RadScheduler desktop widget.
//
// Why this exists: the widget runs as an unauthenticated public client
// (only the practice's anon key, no user JWT). The radscheduler table's
// RLS policies require authenticated access, so direct PostgREST access
// returns 401/permission denied for table radscheduler.
//
// Auth model:
//   1. The widget POSTs the full pairing code (the same base64 blob
//      the admin generated in RadScheduler) as { code }.
//   2. We decode + verify the HMAC-SHA256 signature. Legacy v1 codes use
//      the anon key as the shared secret; v2+ codes use the server-side
//      per-practice widget secret stored in the practice row.
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

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
  let payload: any;
  try { payload = JSON.parse(fromB64Url(code.trim())); }
  catch (_) { throw new Error('malformed code'); }
  if (!payload.sig || !payload.practiceId || !payload.physId) {
    throw new Error('pairing payload missing required fields');
  }
  // exp is now REQUIRED. Tokens without an expiry are forever-valid
  // and outlive any reasonable threat-model assumption.
  if (!payload.exp) throw new Error('pairing has no expiry — re-issue required');
  if (new Date(payload.exp).getTime() < Date.now()) {
    throw new Error('pairing expired');
  }
  // Hard ceiling: reject tokens with absurd expiry (e.g. 100 years
  // out) — a misissued token shouldn't live longer than the company.
  const maxExp = Date.now() + 366 * 86400_000 * 2; // ~2 years
  if (new Date(payload.exp).getTime() > maxExp) {
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
  // v2+ tokens are signed with the practice's server-side secret.
  // v1 (legacy) tokens are signed with the public anon key — we
  // accept those ONLY if the practice has NOT yet rotated to a
  // server-side secret (i.e. legacy practice, never re-issued). Once
  // the practice has a server-side secret, v1 tokens are rejected
  // even if the HMAC against the anon key matches. This forces a
  // one-time re-issue per pairing on the next launch but eliminates
  // forgeability.
  const tokenVersion = +(payload.v || 1);
  let matched = false;
  if (practiceSecret) {
    const expected = await hmacB64Url(practiceSecret, JSON.stringify(rest));
    matched = expected === sig;
  }
  // Legacy v1 fallback — only when practice has no server secret yet.
  if (!matched && tokenVersion < 2 && !practiceSecret && payload.sbAnonKey) {
    const legacy = await hmacB64Url(payload.sbAnonKey, JSON.stringify(rest));
    matched = legacy === sig;
  }
  if (!matched) throw new Error('signature mismatch — pairing must be re-issued');
  const actual = payloadPurpose(payload);
  if (requiredPurpose !== 'any' && actual !== requiredPurpose) {
    throw new Error(`token purpose mismatch (got '${actual}', need '${requiredPurpose}')`);
  }
}

function assertActiveWidgetPairing(practice: any, payload: any, code: string): void {
  const pairings = Array.isArray(practice?.widgetPairings) ? practice.widgetPairings : [];
  if (!pairings.length) return; // legacy practices before active-pairing tracking.
  const tokenVersion = +(payload?.v || 1);
  if (tokenVersion < 2 && payload?.pairingId == null) return; // legacy anon-key tokens were not revocable.
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

// Legacy wrapper kept for the GET ICS path which fetches the practice
// inside the handler. Returns the decoded payload after envelope
// checks; HMAC verification is done by the caller after fetching the
// practice's secret.
async function verifyAndDecode(_code: string, _requiredPurpose: 'widget' | 'cal-feed' | 'any'): Promise<any> {
  throw new Error('verifyAndDecode is deprecated — use _decodeEnvelope + _verifyHmac');
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
    const action = url.searchParams.get('action') || 'ics';
    if (action !== 'ics') {
      return new Response('Use POST for read/write actions; GET only supports action=ics.', { status: 405, headers: CORS });
    }
    let payload: any;
    try { payload = _decodeEnvelope(code); }
    catch (e) { return new Response('Invalid or expired calendar feed URL: ' + (e as Error).message, { status: 401, headers: CORS }); }
    const sb = createClient(SB_URL, SVC_KEY);
    const { data, error } = await sb
      .from('radscheduler').select('data').eq('id', payload.practiceId).single();
    if (error) return new Response('Practice fetch failed: ' + error.message, { status: 500, headers: CORS });
    if (!data) return new Response('Practice not found', { status: 404, headers: CORS });
    const practice = (function parse(raw: any){
      if (raw == null) return {};
      if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
      return raw;
    })((data as any).data);
    // Verify HMAC against the practice's server-side secret. The
    // ICS GET path only accepts cal-feed tokens (so a leaked widget
    // pairing can't be reused to subscribe to a physician's calendar).
    const practiceSecret = (practice && practice.cfg && typeof practice.cfg._widgetSecret === 'string')
      ? practice.cfg._widgetSecret : null;
    try { await _verifyHmac(payload, practiceSecret, 'cal-feed'); }
    catch (e) { return new Response('Invalid or expired calendar feed URL: ' + (e as Error).message, { status: 401, headers: CORS }); }
    const physName = `${payload.physFirst || ''} ${payload.physLast || ''}`.trim() || `Physician ${payload.physId}`;
    const ics = buildICSForPhysician(practice, payload.physId, physName);
    return new Response(ics, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `inline; filename="radscheduler-${payload.physId}.ics"`,
        'Cache-Control': 'public, max-age=600',  // calendar clients can cache 10 min
      },
    });
  }

  if (req.method !== 'POST') return jsonResp({ error: 'POST or GET only' }, 405);
  let body: any;
  try { body = await req.json(); }
  catch (_) { return jsonResp({ error: 'invalid JSON body' }, 400); }
  if (typeof body !== 'object' || body == null) return jsonResp({ error: 'invalid body' }, 400);
  let payload: any;
  // POST path: widget operations (read practice / add+edit+delete
  // credit). Stage-1 decode (no HMAC verify yet — need the practice's
  // server-side secret first).
  try { payload = _decodeEnvelope(body.code); }
  catch (e) { return jsonResp({ error: String((e as Error).message) }, 401); }
  const sb = createClient(SB_URL, SVC_KEY);
  const action = body.action || 'read';

  // Action allowlist — reject anything we don't explicitly support
  // before we waste a DB read on it.
  const ALLOWED_ACTIONS = new Set(['read', 'add-credit', 'edit-credit', 'delete-credit']);
  if (!ALLOWED_ACTIONS.has(action)) return jsonResp({ error: `unknown action: ${action}` }, 400);

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

  // Single fetch up-front so we can verify HMAC against the practice's
  // server-side secret BEFORE dispatching to any action. This costs
  // one extra DB round-trip on read-only calls vs. the legacy code
  // path, but: (a) the legacy path also did one fetch for read, (b)
  // verifying HMAC is the only way to prove the caller is authorized.
  const { data: row, error: rdErr } = await sb
    .from('radscheduler').select('data').eq('id', payload.practiceId).single();
  if (rdErr) return jsonResp({ error: 'practice fetch failed: ' + rdErr.message }, 500);
  if (!row) return jsonResp({ error: 'practice not found' }, 404);
  const practice = parsePracticeData((row as any).data);
  const practiceSecret = (practice && practice.cfg && typeof practice.cfg._widgetSecret === 'string')
    ? practice.cfg._widgetSecret : null;
  try { await _verifyHmac(payload, practiceSecret, 'widget'); }
  catch (e) { return jsonResp({ error: String((e as Error).message) }, 401); }
  try { assertActiveWidgetPairing(practice, payload, body.code); }
  catch (e) { return jsonResp({ error: String((e as Error).message) }, 401); }
  if (!Array.isArray(practice.physicianCredits)) practice.physicianCredits = [];

  // ── READ ────────────────────────────────────────────────────────
  if (action === 'read') {
    return jsonResp({ data: practice });
  }

  async function loadFreshPracticeForWrite(): Promise<any> {
    const { data: freshRow, error: freshErr } = await sb
      .from('radscheduler').select('data').eq('id', payload.practiceId).single();
    if (freshErr) throw new Error('practice refresh failed: ' + freshErr.message);
    if (!freshRow) throw new Error('practice not found');
    const fresh = parsePracticeData((freshRow as any).data);
    const freshSecret = (fresh && fresh.cfg && typeof fresh.cfg._widgetSecret === 'string')
      ? fresh.cfg._widgetSecret : null;
    await _verifyHmac(payload, freshSecret, 'widget');
    assertActiveWidgetPairing(fresh, payload, body.code);
    if (!Array.isArray(fresh.physicianCredits)) fresh.physicianCredits = [];
    return fresh;
  }

  async function writePracticeData(nextPractice: any) {
    return sb.from('radscheduler')
      .update({ data: JSON.stringify(nextPractice) })
      .eq('id', payload.practiceId);
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
    let latest: any;
    try { latest = await loadFreshPracticeForWrite(); }
    catch (e) { return jsonResp({ error: String((e as Error).message) }, 409); }
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
    const { error: wrErr } = await writePracticeData(latest);
    if (wrErr) return jsonResp({ error: 'write failed: ' + wrErr.message }, 500);
    return jsonResp({ ok: true, credit });
  }

  // ── EDIT CREDIT ─────────────────────────────────────────────────
  if (action === 'edit-credit') {
    const id = +body.creditId;
    const patch = body.patch || {};
    if (!id) return jsonResp({ error: 'creditId required' }, 400);
    let latest: any;
    try { latest = await loadFreshPracticeForWrite(); }
    catch (e) { return jsonResp({ error: String((e as Error).message) }, 409); }
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
    const { error: wrErr } = await writePracticeData(latest);
    if (wrErr) return jsonResp({ error: 'write failed: ' + wrErr.message }, 500);
    return jsonResp({ ok: true, credit });
  }

  // ── DELETE CREDIT ───────────────────────────────────────────────
  if (action === 'delete-credit') {
    const id = +body.creditId;
    if (!id) return jsonResp({ error: 'creditId required' }, 400);
    let latest: any;
    try { latest = await loadFreshPracticeForWrite(); }
    catch (e) { return jsonResp({ error: String((e as Error).message) }, 409); }
    const idx = latest.physicianCredits.findIndex((c: any) => c.id === id);
    if (idx < 0) return jsonResp({ error: 'credit not found' }, 404);
    if (latest.physicianCredits[idx].physId !== payload.physId) {
      return jsonResp({ error: 'cannot delete another physician\'s credit' }, 403);
    }
    latest.physicianCredits.splice(idx, 1);
    const { error: wrErr } = await writePracticeData(latest);
    if (wrErr) return jsonResp({ error: 'write failed: ' + wrErr.message }, 500);
    return jsonResp({ ok: true });
  }

  return jsonResp({ error: 'unknown action: ' + action }, 400);
});
