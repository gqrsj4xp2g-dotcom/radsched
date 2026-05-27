import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "onboarding@resend.dev";
const FROM_NAME  = Deno.env.get("FROM_NAME")  || "RadScheduler";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!RESEND_KEY) throw new Error("RESEND_API_KEY not configured in function secrets");
    const payload = await req.json();
    const { subject, body, recipients, kind } = payload;
    if (!subject || !body || !Array.isArray(recipients) || !recipients.length) {
      throw new Error("subject, body, and recipients[] required");
    }

    // Simple markdown-to-HTML transform for line breaks, bold, italic.
    // Body is escaped first, then markers are reintroduced as real HTML tags.
    let html = escapeHtml(body)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\n/g, "<br>");

    const unsubNote = (kind === "broadcast" || kind === "broadcast-test")
      ? '<hr style="margin-top:24px;border:none;border-top:1px solid #eee"><p style="font-size:11px;color:#999">You received this because broadcast notifications are enabled on your account. Manage preferences in RadScheduler → Notifications.</p>'
      : "";

    const htmlWrapped = '<div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;line-height:1.6">' + html + unsubNote + '</div>';

    const results = [];
    for (const r of recipients) {
      if (!r || !r.email) { results.push({ ok:false, error:"missing email" }); continue; }
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + RESEND_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_NAME + " <" + FROM_EMAIL + ">",
          to: [r.email],
          subject: subject,
          html: htmlWrapped,
        }),
      });
      const respBody = await resp.json().catch(() => ({}));
      results.push({ email: r.email, ok: resp.ok, status: resp.status, id: respBody.id, error: respBody.message });
    }
    return new Response(JSON.stringify({ ok: true, sent: results.length, results }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[send-notification] error:", e);
    return new Response(JSON.stringify({ error: String(e && e.message ? e.message : e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});