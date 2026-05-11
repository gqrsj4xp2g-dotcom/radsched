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
//   2. We decode + verify the HMAC-SHA256 signature using the anon key
//      embedded in the payload as the shared secret. This proves the
//      code was issued by someone with admin access to the practice.
//   3. On verify-success we use the SERVICE ROLE key (server-side only)
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
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

async function verifyAndDecode(code: string): Promise<any> {
  if (!code || typeof code !== 'string') throw new Error('missing code');
  let payload: any;
  try { payload = JSON.parse(fromB64Url(code.trim())); }
  catch (_) { throw new Error('malformed code'); }
  if (!payload.sig || !payload.sbAnonKey || !payload.practiceId || !payload.physId) {
    throw new Error('pairing payload missing required fields');
  }
  const { sig, ...rest } = payload;
  const expected = await hmacB64Url(payload.sbAnonKey, JSON.stringify(rest));
  if (expected !== sig) throw new Error('signature mismatch');
  if (payload.exp && new Date(payload.exp).getTime() < Date.now()) {
    throw new Error('pairing expired');
  }
  return payload;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return jsonResp({ error: 'POST only' }, 405);
  let body: any;
  try { body = await req.json(); }
  catch (_) { return jsonResp({ error: 'invalid JSON body' }, 400); }
  let payload: any;
  try { payload = await verifyAndDecode(body.code); }
  catch (e) { return jsonResp({ error: String((e as Error).message) }, 401); }
  const sb = createClient(SB_URL, SVC_KEY);
  const action = body.action || 'read';

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

  // ── READ ────────────────────────────────────────────────────────
  if (action === 'read') {
    const { data, error } = await sb
      .from('radscheduler').select('data').eq('id', payload.practiceId).single();
    if (error) return jsonResp({ error: 'practice fetch failed: ' + error.message }, 500);
    if (!data) return jsonResp({ error: 'practice not found', practiceId: payload.practiceId }, 404);
    return jsonResp({ data: parsePracticeData((data as any).data) });
  }

  // For all WRITE actions: read → mutate → write back. No retry on
  // concurrent-modification — race window is small (a single physician
  // tapping in the widget) and the practice JSON is bursty-write
  // dominated by the main app, not the widget.
  const { data: row, error: rdErr } = await sb
    .from('radscheduler').select('data').eq('id', payload.practiceId).single();
  if (rdErr) return jsonResp({ error: 'practice fetch failed: ' + rdErr.message }, 500);
  if (!row) return jsonResp({ error: 'practice not found' }, 404);
  const practice = parsePracticeData((row as any).data);
  if (!Array.isArray(practice.physicianCredits)) practice.physicianCredits = [];

  // Stringify before writing back — the column is text. supabase-js
  // would happily UPDATE with an object value (it auto-serializes),
  // but explicit is safer + cheaper to reason about.
  function writeBack() {
    return sb.from('radscheduler')
      .update({ data: JSON.stringify(practice) })
      .eq('id', payload.practiceId);
  }

  // Helper: bump nextId once per write so add-credit gets a fresh ID
  // even if the main app is between saves. nextId is the same field
  // the main app uses for client-side ID allocation.
  function allocateId(): number {
    const next = (+practice.nextId || 100) + 1;
    practice.nextId = next;
    return next;
  }

  // ── ADD CREDIT ──────────────────────────────────────────────────
  if (action === 'add-credit') {
    const c = body.credit || {};
    const hours = +c.hours;
    const reason = (c.reason || '').toString().trim();
    const ts = (c.ts || new Date().toISOString()).toString();
    if (!hours || hours <= 0 || hours > 24) return jsonResp({ error: 'hours must be in (0, 24]' }, 400);
    if (!reason) return jsonResp({ error: 'reason is required' }, 400);
    const credit = {
      id: allocateId(),
      physId: payload.physId,
      ts,
      hours,
      reason,
      createdBy: payload.physId,
      createdAt: new Date().toISOString(),
    };
    practice.physicianCredits.push(credit);
    const { error: wrErr } = await writeBack();
    if (wrErr) return jsonResp({ error: 'write failed: ' + wrErr.message }, 500);
    return jsonResp({ ok: true, credit });
  }

  // ── EDIT CREDIT ─────────────────────────────────────────────────
  if (action === 'edit-credit') {
    const id = +body.creditId;
    const patch = body.patch || {};
    if (!id) return jsonResp({ error: 'creditId required' }, 400);
    const idx = practice.physicianCredits.findIndex((c: any) => c.id === id);
    if (idx < 0) return jsonResp({ error: 'credit not found' }, 404);
    const credit = practice.physicianCredits[idx];
    if (credit.physId !== payload.physId) return jsonResp({ error: 'cannot edit another physician\'s credit' }, 403);
    if (patch.hours != null) {
      const h = +patch.hours;
      if (!h || h <= 0 || h > 24) return jsonResp({ error: 'hours must be in (0, 24]' }, 400);
      credit.hours = h;
    }
    if (patch.reason != null) {
      const r = String(patch.reason).trim();
      if (!r) return jsonResp({ error: 'reason cannot be empty' }, 400);
      credit.reason = r;
    }
    if (patch.ts != null) credit.ts = String(patch.ts);
    credit.updatedAt = new Date().toISOString();
    practice.physicianCredits[idx] = credit;
    const { error: wrErr } = await writeBack();
    if (wrErr) return jsonResp({ error: 'write failed: ' + wrErr.message }, 500);
    return jsonResp({ ok: true, credit });
  }

  // ── DELETE CREDIT ───────────────────────────────────────────────
  if (action === 'delete-credit') {
    const id = +body.creditId;
    if (!id) return jsonResp({ error: 'creditId required' }, 400);
    const idx = practice.physicianCredits.findIndex((c: any) => c.id === id);
    if (idx < 0) return jsonResp({ error: 'credit not found' }, 404);
    if (practice.physicianCredits[idx].physId !== payload.physId) {
      return jsonResp({ error: 'cannot delete another physician\'s credit' }, 403);
    }
    practice.physicianCredits.splice(idx, 1);
    const { error: wrErr } = await writeBack();
    if (wrErr) return jsonResp({ error: 'write failed: ' + wrErr.message }, 500);
    return jsonResp({ ok: true });
  }

  return jsonResp({ error: 'unknown action: ' + action }, 400);
});
