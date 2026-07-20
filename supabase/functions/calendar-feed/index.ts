// calendar-feed — retired legacy endpoint.
//
// Older releases searched every practice blob for a long-lived bearer token.
// Calendar subscriptions now use signed, scoped v2 URLs served by widget-data.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Cache-Control': 'private, no-store',
};

Deno.serve((req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }
  return new Response(
    'Legacy calendar feed retired. Generate a new calendar URL in RadScheduler.',
    { status: 410, headers: CORS },
  );
});
