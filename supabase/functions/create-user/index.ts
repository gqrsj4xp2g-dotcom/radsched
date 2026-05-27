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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
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

async function findUserByEmail(admin: any, email: string): Promise<any | null> {
  const target = email.toLowerCase();
  let page = 1;
  const perPage = 1000;
  while (page <= 10) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) return null;
    const users = data?.users || [];
    const hit = users.find((u: any) => (u.email || "").toLowerCase() === target);
    if (hit) return hit;
    if (users.length < perPage) break;
    page++;
  }
  return null;
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
    const userMeta = caller.user_metadata || {};
    const appMeta = caller.app_metadata || {};

    // SECURITY: callerRole comes from app_metadata ONLY.
    // user_metadata is user-mutable via sb.auth.updateUser({data:{role:'admin'}}),
    // so trusting it for the admin gate allows any logged-in user to
    // self-promote and then mint admin accounts / change their own
    // practiceId (defeating multi-tenant RLS). app_metadata is
    // server-side-only and powers the RLS policies — use it strictly.
    let callerRole = appMeta.role;

    // Need an admin client for bootstrap detection + privileged ops.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // BOOTSTRAP fallback: if NO admin exists yet system-wide AND the
    // caller claims user_metadata.role==="admin", give them a one-time
    // pass AND promote their app_metadata.role to admin so the next
    // call uses the strict path. This is the only path that lets a
    // brand-new project bootstrap its first admin without manual SQL.
    if (callerRole !== "admin" && userMeta.role === "admin") {
      try {
        const list = await admin.auth.admin.listUsers({ page: 1, perPage: 50 });
        const adminCount = (list.data?.users || []).filter(
          (u: any) => (u.app_metadata?.role) === "admin"
        ).length;
        if (adminCount === 0) {
          await admin.auth.admin.updateUserById(caller.id, {
            app_metadata: {
              ...appMeta,
              role: "admin",
              practiceId: appMeta.practiceId || userMeta.practiceId || "main",
            },
          });
          callerRole = "admin";
        }
      } catch (e) {
        console.warn("[create-user] bootstrap check failed:", e);
      }
    }

    if (callerRole !== "admin" && callerRole !== "superuser") {
      return json({
        error: "Caller is not an admin (app_metadata.role: " + (appMeta.role || "none") + "). Set app_metadata.role=admin via the Supabase dashboard for the first admin; subsequent admins are promoted through this function by an existing admin.",
        caller_email: caller.email,
      }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || "create";

    if (action === "delete") {
      if (!body.userId) return json({ error: "userId required for delete" }, 400);
      const delRes = await admin.auth.admin.deleteUser(body.userId);
      if (delRes.error) return json({ error: "Delete failed: " + delRes.error.message }, 500);
      return json({ ok: true, deleted: body.userId });
    }

    if (action === "update") {
      if (!body.userId) return json({ error: "userId required for update" }, 400);
      const { data: existing, error: fetchErr } = await admin.auth.admin.getUserById(body.userId);
      if (fetchErr) return json({ error: "Update fetch failed: " + fetchErr.message }, 500);
      const existingMeta = (existing?.user?.user_metadata as Record<string, unknown>) || {};
      const existingApp  = (existing?.user?.app_metadata  as Record<string, unknown>) || {};
      const patch: Record<string, unknown> = { ...existingMeta };
      if (body.role !== undefined) patch.role = body.role;
      if (body.physId !== undefined) patch.physId = body.physId == null ? null : body.physId;
      if (body.first !== undefined) patch.first = body.first;
      if (body.last !== undefined) patch.last = body.last;
      if (body.practiceId !== undefined) patch.practiceId = body.practiceId;
      if (body.notifyEmail !== undefined) patch.notifyEmail = body.notifyEmail;
      // app_metadata is server-side-only and powers RLS policies. Mirror role +
      // practiceId changes here so the security gating stays in sync with the
      // user-facing fields.
      const appPatch: Record<string, unknown> = { ...existingApp };
      let appChanged = false;
      if (body.role !== undefined)       { appPatch.role       = body.role;       appChanged = true; }
      if (body.practiceId !== undefined) { appPatch.practiceId = body.practiceId; appChanged = true; }
      const upPayload: Record<string, unknown> = { user_metadata: patch };
      if (appChanged) upPayload.app_metadata = appPatch;
      const upRes = await admin.auth.admin.updateUserById(body.userId, upPayload);
      if (upRes.error) return json({ error: "Update failed: " + upRes.error.message }, 500);
      return json({
        ok: true,
        updated: body.userId,
        user_metadata: upRes.data?.user?.user_metadata || patch,
        app_metadata:  upRes.data?.user?.app_metadata  || appPatch,
      });
    }

    if (action === "lookup") {
      const email = (body.email || "").trim().toLowerCase();
      if (!email) return json({ error: "email required for lookup" }, 400);
      const existing = await findUserByEmail(admin, email);
      if (!existing) return json({ ok: true, found: false });
      return json({
        ok: true,
        found: true,
        id: existing.id,
        email: existing.email,
        user_metadata: existing.user_metadata || {},
        app_metadata:  existing.app_metadata  || {},
        created_at: existing.created_at,
      });
    }

    // Default: create a new auth user. Writes role + practiceId into BOTH
    // app_metadata (for RLS gating; server-side-only, users can't modify) and
    // user_metadata (for app-level conveniences like display name and physId).
    const { email, password, first, last, role, physId, practiceId } = body;
    if (!email || !password) return json({ error: "email and password required" }, 400);
    if (password.length < 8) return json({ error: "password must be at least 8 characters" }, 400);

    const createRes = await admin.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      app_metadata: {
        role: role || "user",
        practiceId: practiceId || "main",
      },
      user_metadata: {
        role: role || "user",
        first: first || "",
        last: last || "",
        physId: physId == null ? null : physId,
        practiceId: practiceId || "main",
        joined: new Date().toISOString().slice(0, 10),
      },
    });

    if (createRes.error) {
      const errMsg = createRes.error.message || "";
      const errStatus = createRes.error.status || 400;
      if (errStatus === 422 || /already.*registered|email.*exists/i.test(errMsg)) {
        const existing = await findUserByEmail(admin, email);
        if (existing) {
          return json({
            error: errMsg,
            email_exists: true,
            existing_id: existing.id,
            existing_email: existing.email,
            existing_metadata: existing.user_metadata || {},
            existing_app_metadata: existing.app_metadata || {},
            existing_created_at: existing.created_at,
          }, 422);
        }
      }
      return json(
        { error: errMsg, status: errStatus },
        errStatus
      );
    }
    if (!createRes.data || !createRes.data.user) {
      return json({ error: "createUser returned no user object" }, 500);
    }

    return json({
      ok: true,
      id: createRes.data.user.id,
      email: createRes.data.user.email,
    });
  } catch (e) {
    console.error("[create-user] unhandled error:", e);
    return json({ error: "Unhandled error: " + ((e as any) && (e as any).message ? (e as any).message : String(e)) }, 500);
  }
});
