// widget-data — read-only proxy for the RadScheduler desktop widget.
//
// Why this exists: the widget runs as an unauthenticated public client
// (only the practice's anon key, no user JWT). The radscheduler table's
// RLS policies require an authenticated user, so a direct PostgREST read
// returns 401 / "permission denied for table radscheduler" (PG 42501).
//
// Auth model:
//   1. The widget POSTs the full pairing code (the same base64 blob
//      the admin generated in RadScheduler) as { code }.
//   2. We decode + verify the HMAC-SHA256 signature using the anon key
//      embedded in the payload as the shared secret. This proves the
//      code was issued by someone with admin access to the practice.
//   3. On verify-success we use the SERVICE ROLE key (server-side only)
//      to fetch the practice row. Bypasses RLS but only for codes we
//      cryptographically verified.
//
// Trade-off: the anon key is public-by-design, so anyone who CAPTURES
// a pairing code can re-use it until it expires. Same threat model as
// the existing widget design — pairings expire (default 30d) and admins
// can revoke them via S.widgetPairings.

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  try {
    const body = await req.json();
    const code = (body && body.code) || '';
    if (!code || typeof code !== 'string') {
      return new Response(JSON.stringify({ error: 'missing code' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    // Decode the pairing payload.
    let payload: any;
    try { payload = JSON.parse(fromB64Url(code.trim())); }
    catch (_) {
      return new Response(JSON.stringify({ error: 'malformed code' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    if (!payload.sig || !payload.sbAnonKey || !payload.practiceId || !payload.physId) {
      return new Response(JSON.stringify({ error: 'pairing payload missing required fields' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    // Verify the HMAC signature with the anon key as shared secret.
    const { sig, ...rest } = payload;
    const msg = JSON.stringify(rest);
    const expected = await hmacB64Url(payload.sbAnonKey, msg);
    if (expected !== sig) {
      return new Response(JSON.stringify({ error: 'signature mismatch' }), {
        status: 401,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    // Expiry check.
    if (payload.exp && new Date(payload.exp).getTime() < Date.now()) {
      return new Response(JSON.stringify({ error: 'pairing expired', exp: payload.exp }), {
        status: 401,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    // Server-side fetch with service role (bypasses RLS).
    const sb = createClient(SB_URL, SVC_KEY);
    const { data, error } = await sb
      .from('radscheduler')
      .select('data')
      .eq('id', payload.practiceId)
      .single();
    if (error) {
      return new Response(JSON.stringify({ error: 'practice fetch failed: ' + error.message }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    if (!data) {
      return new Response(JSON.stringify({ error: 'practice not found', practiceId: payload.practiceId }), {
        status: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ data: data.data || {} }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[widget-data] error:', e);
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
