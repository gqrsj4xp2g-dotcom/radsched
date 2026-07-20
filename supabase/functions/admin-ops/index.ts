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
const RESTORE_ARRAY_FIELDS = [
  "physicians",
  "sites",
  "drShifts",
  "irShifts",
  "irCalls",
  "weekendCalls",
  "holidays",
  "vacations",
];
const MAX_BACKUP_BYTES = 12 * 1024 * 1024;

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

function parseBackupPayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).length > MAX_BACKUP_BYTES) {
      throw new Error("Backup is too large to restore through admin-ops.");
    }
    return JSON.parse(value);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).length > MAX_BACKUP_BYTES) {
      throw new Error("Backup is too large to restore through admin-ops.");
    }
    return JSON.parse(encoded);
  }
  throw new Error("Backup payload is not a JSON object.");
}

function validateRestorePayload(payload: Record<string, unknown>) {
  const problems: string[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    problems.push("Backup root must be an object.");
  }
  const presentArrays = RESTORE_ARRAY_FIELDS.filter((field) => field in payload);
  for (const field of presentArrays) {
    if (!Array.isArray(payload[field])) problems.push(`${field} must be an array.`);
  }
  if (!presentArrays.length) {
    problems.push("Backup does not contain any schedule arrays.");
  }
  return {
    ok: problems.length === 0,
    problems,
  };
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

    const { data: backup, error: backupErr } = await admin
      .from("radscheduler_backups")
      .select("id, practice_id, data, created_at")
      .eq("id", backupId)
      .eq("practice_id", requestedPracticeId)
      .maybeSingle();
    if (backupErr) return json({ error: "Backup lookup failed: " + backupErr.message }, 500);
    if (!backup) return json({ error: "Backup not found for this practice." }, 404);

    let parsed: Record<string, unknown>;
    try {
      parsed = parseBackupPayload((backup as any).data);
    } catch (e) {
      return json({ error: "Backup is not valid restore JSON: " + String((e as any)?.message || e) }, 400);
    }
    const validation = validateRestorePayload(parsed);
    if (!validation.ok) {
      return json({ error: "Backup payload failed validation.", problems: validation.problems.slice(0, 10) }, 400);
    }

    const savedAt = new Date().toISOString();
    const restored = {
      ...parsed,
      savedAt,
      _restoredFromBackup: backupId,
      _restoredAt: savedAt,
    };
    // Canonical side-table data is intentionally outside a blob-backup
    // restore. Never resurrect stale copies or a legacy browser-visible
    // widget signing key from an older backup.
    delete (restored as any).swapRequests;
    delete (restored as any).onCallAcks;
    if ((restored as any).cfg && typeof (restored as any).cfg === "object") {
      delete (restored as any).cfg._widgetSecret;
      delete (restored as any).cfg.mapsKey;
      delete (restored as any).cfg.gmapsKey;
    }

    const { data: currentRow, error: currentErr } = await admin
      .from("radscheduler").select("saved_at").eq("id", requestedPracticeId).maybeSingle();
    if (currentErr) return json({ error: "Restore version check failed: " + currentErr.message }, 500);
    const { data: writeResult, error: writeErr } = await admin.rpc("rs_save_practice_cas", {
      p_practice: requestedPracticeId,
      p_data: JSON.stringify(restored),
      p_expected_saved_at: (currentRow as any)?.saved_at || null,
    });
    if (writeErr) return json({ error: "Restore write failed: " + writeErr.message }, 500);
    if (!(writeResult as any)?.ok) {
      return json({ error: "Practice changed while the restore was being prepared. No data was overwritten; retry after reviewing the latest save." }, 409);
    }
    const committedAt = String((writeResult as any)?.saved_at || savedAt);
    (restored as any)._dbSavedAt = committedAt;

    const warnings: string[] = [];
    const auditRow = {
      practice_id: requestedPracticeId,
      ts: savedAt,
      who: caller.email || "",
      who_id: caller.id || "",
      role: callerRole,
      action: "admin.restoreBackup",
      detail: {
        backupId,
        backupCreatedAt: (backup as any).created_at || null,
        restoredAt: savedAt,
        via: "admin-ops",
      },
    };
    const { error: auditErr } = await admin.from("radscheduler_audit").insert(auditRow);
    if (auditErr) warnings.push("Audit insert failed: " + auditErr.message);

    const { error: telemetryErr } = await admin.from("radscheduler_telemetry").insert({
      id: crypto.randomUUID(),
      practice_id: requestedPracticeId,
      user_id: caller.id || null,
      user_email: caller.email || null,
      level: "warn",
      event: "admin.restore_backup",
      detail: {
        backupId,
        backupCreatedAt: (backup as any).created_at || null,
        via: "admin-ops",
      },
      created_at: savedAt,
    });
    if (telemetryErr) warnings.push("Telemetry insert failed: " + telemetryErr.message);

    return json({
      ok: true,
      action,
      backupId,
      practiceId: requestedPracticeId,
      savedAt: committedAt,
      payload: restored,
      warnings,
    });
  } catch (e) {
    console.error("[admin-ops] unhandled error:", e);
    return json({ error: "Unhandled error: " + String((e as any)?.message || e) }, 500);
  }
});
