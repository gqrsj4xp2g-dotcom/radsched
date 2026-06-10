// SendFx — RETIRED (rs-v102 security remediation).
//
// This function was an early email sender superseded by
// `send-notification`, which enforces caller authentication, practice-
// scoped recipient validation, and rate limiting. SendFx had NO auth
// check of its own, and the platform-level verify_jwt gate does not
// help because the public anon key is itself a valid JWT — making
// this an open email relay for anyone who read the anon key out of
// the page source. Nothing in the RadScheduler client calls SendFx
// (zero references), so it is tombstoned rather than hardened.
//
// If you ever need it again, copy the auth + recipient-validation +
// rate-limit blocks from send-notification/index.ts first.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  return new Response(
    JSON.stringify({ ok: false, error: "SendFx is retired. Use send-notification instead." }),
    { status: 410, headers: { ...CORS, "Content-Type": "application/json" } },
  );
});
