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

    const body = await req.json();
    if (!Array.isArray(body?.messages)) return json({ error: 'messages[] is required.' }, 400);
    const maxTokens = Math.max(1, Math.min(Number(body.max_tokens) || 4096, 4096));
    const upstreamBody = {
      model: String(body.model || 'claude-sonnet-4-6'),
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
    });

    const data = await anthropicResp.json();

    return json(data, anthropicResp.status);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});
