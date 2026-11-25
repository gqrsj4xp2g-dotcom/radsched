import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PRIVILEGED_ROLES = new Set(["admin", "superuser"]);
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch (_e) {
    return {};
  }
}

function hasAal2(token: string): boolean {
  const payload = decodeJwtPayload(token);
  return String(payload.aal || "").toLowerCase() === "aal2";
}

function cleanId(value: unknown): string {
  return String(value || "").trim();
}

function normalizeRole(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

const RATE_BUCKETS = new Map<string, { n: number; t: number }>();
function rateLimit(key: string, capPerMinute: number): boolean {
  const now = Date.now();
  const current = RATE_BUCKETS.get(key);
  if (!current || now - current.t > 60_000) {
    RATE_BUCKETS.set(key, { n: 1, t: now });
    return true;
  }
  if (current.n >= capPerMinute) return false;
  current.n++;
  return true;
}

async function resolveCaller(token: string): Promise<{
  ok: boolean;
  user?: Record<string, unknown>;
  error?: string;
  status?: number;
}> {
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + token,
        "apikey": ANON_KEY,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        error: (body && (body.msg || body.message || body.error_description || body.error)) || `HTTP ${resp.status}`,
      };
    }
    return { ok: true, user: body };
  } catch (e) {
    return { ok: false, error: "Network error resolving caller: " + String((e as any)?.message || e) };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
      return json({
        error: "Missing required env vars. SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must all be set.",
      }, 500);
    }

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Missing Authorization bearer token" }, 401);

    const callerRes = await resolveCaller(token);
    if (!callerRes.ok || !callerRes.user) {
      return json({
        error: "Invalid or expired session token",
        detail: callerRes.error,
        upstream_status: callerRes.status,
      }, 401);
    }

    const caller = callerRes.user as any;
    const appMeta = caller.app_metadata || {};
    const callerRole = normalizeRole(appMeta.role);
    if (!PRIVILEGED_ROLES.has(callerRole)) {
      return json({ error: "Caller is not an admin or superuser.", caller_email: caller.email }, 403);
    }
    if (!rateLimit(String(caller.id || caller.email || "unknown"), 10)) {
      return json({ error: "Too many admin operation requests; slow down." }, 429);
    }
    if (!hasAal2(token)) {
      return json({
        error: "Admin MFA verification is required before destructive admin operations. Verify this session to aal2, then retry.",
        mfa_required: true,
      }, 403);
    }

    const declaredLength = +(req.headers.get("content-length") || 0);
    if (declaredLength > 65_536) return json({ error: "Request body too large" }, 413);
    const rawBody = await req.text().catch(() => "");
    if (new TextEncoder().encode(rawBody).length > 65_536) return json({ error: "Request body too large" }, 413);
    let body: any;
    try { body = JSON.parse(rawBody); }
    catch (_e) { return json({ error: "Invalid JSON body" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid JSON body" }, 400);
    const action = String(body.action || "").trim();
    if (action !== "restore-backup") {
      return json({ error: "Unsupported admin operation.", allowed_actions: ["restore-backup"] }, 400);
    }

    const backupId = cleanId(body.backupId);
    const requestedPracticeId = cleanId(body.practiceId || appMeta.practiceId);
    const callerPracticeId = cleanId(appMeta.practiceId);
    if (!backupId) return json({ error: "backupId is required." }, 400);
    if (!requestedPracticeId) return json({ error: "practiceId is required." }, 400);
    if (callerRole === "admin" && !callerPracticeId) {
      return json({ error: "Admin account is missing app_metadata.practiceId." }, 403);
    }
    if (callerRole !== "superuser" && requestedPracticeId !== callerPracticeId) {
      return json({ error: "Admins can restore only their own practice backups." }, 403);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const requestId = cleanId(body.requestId);
    const expectedSavedAt = cleanId(body.expectedSavedAt);
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId) ||
        !expectedSavedAt || !Number.isFinite(Date.parse(expectedSavedAt))) {
      return json({ error: "Reload the backup picker to confirm the current version before restoring." }, 400);
    }
    const { data, error } = await admin.rpc("rs_restore_practice_backup", {
      p_practice: requestedPracticeId,
      p_backup: backupId,
      p_expected_saved_at: expectedSavedAt,
      p_request: requestId,
      p_actor: caller.id,
      p_email: caller.email || "",
      p_role: callerRole,
    });
    if (error) {
      if (error.code === "40001") return json({ error: error.message }, 409);
      if (error.code === "P0002") return json({ error: "Practice backup or schedule not found." }, 404);
      if (error.code?.startsWith("22")) return json({ error: "The backup or current schedule failed validation. A valid safety snapshot is required before restoring." }, 400);
      console.error("[admin-ops] restore transaction failed", { code: error.code, requestId });
      return json({ error: "Restore transaction failed. Retry with the same restore request." }, 500);
    }
    return json({ ...data, action, practiceId: requestedPracticeId, backupId });
  } catch (e) {
    console.error("[admin-ops] unhandled error:", e);
    return json({ error: "Unhandled error: " + String((e as any)?.message || e) }, 500);
  }
});
