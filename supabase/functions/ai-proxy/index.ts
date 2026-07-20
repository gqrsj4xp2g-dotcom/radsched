import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const RATE_BUCKETS = new Map<string, { n: number; t: number }>();
function rateLimit(key: string, cap: number): boolean {
  const now = Date.now();
  const bucket = RATE_BUCKETS.get(key);
  if (!bucket || now - bucket.t > 60_000) { RATE_BUCKETS.set(key, { n: 1, t: now }); return true; }
  if (bucket.n >= cap) return false;
  bucket.n++;
  return true;
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1] || '';
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch { return {}; }
}

async function requireAdmin(req: Request): Promise<Response | null> {
  const auth = req.headers.get('Authorization') || '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Missing JWT' }, 401);

  const sbUrl = Deno.env.get('SUPABASE_URL');
  const sbAnon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!sbUrl || !sbAnon) return json({ error: 'Supabase auth env vars are not configured.' }, 500);

  const sb = createClient(sbUrl, sbAnon);
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data?.user) return json({ error: 'Invalid JWT' }, 401);

  const role = String(data.user.app_metadata?.role || '');
  if (role !== 'admin' && role !== 'superuser') {
    return json({ error: 'Admin role required.' }, 403);
  }
  const claims = decodeJwt(jwt);
  if (String(claims.aal || '').toLowerCase() !== 'aal2') {
    return json({ error: 'Admin MFA verification required.' }, 403);
  }
  if (!rateLimit(String(data.user.id || claims.sub || 'unknown'), 20)) {
    return json({ error: 'Too many AI requests; slow down.' }, 429);
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const authError = await requireAdmin(req);
  if (authError) return authError;

  try {
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) {
      return json({ error: 'ANTHROPIC_API_KEY not configured in Supabase Edge Function secrets.' }, 500);
    }

    const declaredLength = +(req.headers.get('content-length') || 0);
    if (declaredLength > 750_000) return json({ error: 'AI request body is too large.' }, 413);
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).length > 750_000) return json({ error: 'AI request body is too large.' }, 413);
    let body: any;
    try { body = JSON.parse(rawBody); }
    catch { return json({ error: 'Invalid JSON body.' }, 400); }
    if (!Array.isArray(body?.messages)) return json({ error: 'messages[] is required.' }, 400);
    if (body.messages.length > 100 || JSON.stringify(body.messages).length > 500_000) {
      return json({ error: 'AI conversation payload is too large.' }, 413);
    }
    if (body.system != null && String(body.system).length > 50_000) return json({ error: 'system prompt is too large.' }, 413);
    if (Array.isArray(body.tools) && body.tools.length > 100) return json({ error: 'too many tools.' }, 413);
    const maxTokens = Math.max(1, Math.min(Number(body.max_tokens) || 4096, 4096));
    const requestedModel = String(body.model || 'claude-sonnet-4-6');
    const allowedModels = new Set(['claude-sonnet-4-6', 'claude-haiku-4-5']);
    if (!allowedModels.has(requestedModel)) return json({ error: 'Requested AI model is not allowed.' }, 400);
    const upstreamBody = {
      model: requestedModel,
      max_tokens: maxTokens,
      system: body.system,
      tools: Array.isArray(body.tools) ? body.tools : undefined,
      messages: body.messages,
    };

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(60_000),
    });

    const data = await anthropicResp.json();

    return json(data, anthropicResp.status);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});
