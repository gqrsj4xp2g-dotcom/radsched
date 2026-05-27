import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
    status,
  })
}

async function requireAdmin(req: Request): Promise<Response | null> {
  const auth = req.headers.get('Authorization') || ''
  const jwt = auth.replace(/^Bearer\s+/i, '')
  if (!jwt) return json({ error: 'Missing JWT' }, 401)

  const sbUrl = Deno.env.get('SUPABASE_URL')
  const sbAnon = Deno.env.get('SUPABASE_ANON_KEY')
  if (!sbUrl || !sbAnon) return json({ error: 'Supabase auth env vars are not configured.' }, 500)

  const sb = createClient(sbUrl, sbAnon)
  const { data, error } = await sb.auth.getUser(jwt)
  if (error || !data?.user) return json({ error: 'Invalid JWT' }, 401)

  const role = String(data.user.app_metadata?.role || '')
  if (role !== 'admin' && role !== 'superuser') return json({ error: 'Admin role required.' }, 403)
  return null
}

function nextDeparture(timeStr: string): number {
  const now = new Date()
  const [hh, mm] = timeStr.split(':').map(Number)
  const candidate = new Date(now)
  candidate.setHours(hh, mm, 0, 0)
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1)
  return Math.floor(candidate.getTime() / 1000)
}

function normalizeDepartureTime(timeStr: string): string {
  if (timeStr === 'now') return 'now'
  if (/^\d+$/.test(timeStr)) return timeStr
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) return String(nextDeparture(timeStr))
  throw new Error('departureTime must be "now", a Unix timestamp, or HH:MM')
}

async function distMatrix(
  origins: string[], destinations: string[],
  key: string, depTime?: string, model = 'best_guess'
): Promise<any> {
  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json')
  url.searchParams.set('origins',      origins.join('|'))
  url.searchParams.set('destinations', destinations.join('|'))
  url.searchParams.set('mode',         'driving')
  url.searchParams.set('units',        'imperial')
  url.searchParams.set('key',          key)
  if (depTime) {
    url.searchParams.set('departure_time', normalizeDepartureTime(depTime))
    url.searchParams.set('traffic_model',  model)
  }
  const resp = await fetch(url.toString())
  if (!resp.ok) throw new Error(`Maps API HTTP ${resp.status}`)
  const data = await resp.json()
  if (data.status !== 'OK' && data.status !== 'PARTIAL_SUCCESS')
    throw new Error(`Maps API: ${data.status} — ${data.error_message || ''}`)
  return data
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS, status: 200 })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const authError = await requireAdmin(req)
  if (authError) return authError

  try {
    const body = await req.json()
    const { origins, destinations, mapsKey, departureTime, returnTime, trafficModel } = body

    if (!origins?.length || !destinations?.length)
      throw new Error('origins and destinations are required')
    if (!Array.isArray(origins) || !Array.isArray(destinations))
      throw new Error('origins and destinations must be arrays')
    if (origins.length > 25 || destinations.length > 25 || origins.length * destinations.length > 100)
      throw new Error('Maps request too large')

    const key = mapsKey || Deno.env.get('GOOGLE_MAPS_KEY') || ''
    if (!key) throw new Error('No Google Maps API key configured.')

    if (returnTime) {
      // Round-trip mode: calculate outbound AND return in one request
      // Outbound: origins -> destinations at departureTime
      // Return:   destinations -> origins at returnTime  (swapped)
      const [outbound, returning] = await Promise.all([
        distMatrix(origins, destinations, key, departureTime, trafficModel),
        distMatrix(destinations, origins, key, returnTime,    trafficModel),
      ])
      return json({ outbound, returning })
    }

    // Single-direction mode (base times or legacy traffic)
    const data = await distMatrix(origins, destinations, key, departureTime, trafficModel)
    return json(data)

  } catch (err: any) {
    return json({ error: err.message }, 400)
  }
})
