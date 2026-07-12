// pacs-ingest — production ingest endpoint for signed radiology reports.
//
// Your PACS / RIS / dictation system (Fluency, PowerScribe, Epic) points its
// outbound signed-report feed here with:
//   Authorization: Bearer <per-practice ingest token>   (issue one in PACS Connections)
//   Content-Type: application/json
//   body: { format: 'hl7'|'fhir'|'json', ...payload }
//
// The token identifies the practice (never trust a body-supplied practice_id).
// We parse the report, extract the principal interpreting radiologist, map them
// to a physician on the practice roster (by configured PACS alias / last name),
// and upsert into public.rs_reports. Idempotent on (practice_id, accession|hash).
//
// verify_jwt = false — auth is the ingest bearer token, not a Supabase JWT.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ── HL7 v2 ORU^R01 parse (mirrors the in-app parser + OBR-32 interpreter) ──
function parseHL7(raw: string) {
  const text = (raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text.startsWith("MSH|")) return { error: "Not an HL7 message — must start with MSH|" };
  const segs = text.split("\n").filter(Boolean);
  const m: Record<string, string> = {
    accession: "", mrn: "", patient_name: "", exam: "", interpreter: "", signed_at: "", modality: "",
  };
  const obx: string[] = [];
  for (const seg of segs) {
    const p = seg.split("|");
    if (p[0] === "PID") {
      m.mrn = (p[3] || "").split("^")[0];
      m.patient_name = (p[5] || "").replace(/\^/g, " ").trim();
    } else if (p[0] === "OBR") {
      m.accession = m.accession || (p[2] || "").split("^")[0] || (p[3] || "").split("^")[0];
      m.exam = m.exam || (p[4] || "").split("^")[1] || (p[4] || "").split("^")[0];
      // OBR-32 principal result interpreter: NDL composite ...^LAST^FIRST^MID
      const obr32 = p[32] || "";
      if (obr32 && !m.interpreter) m.interpreter = obr32.replace(/\^/g, " ").replace(/\s+/g, " ").trim();
      // signed/report time: OBR-22 (status change) else OBR-7 (observation)
      m.signed_at = m.signed_at || hl7Date(p[22]) || hl7Date(p[7]);
    } else if (p[0] === "OBX") {
      const vt = p[2] || "";
      if (vt === "TX" || vt === "FT" || vt === "ST") {
        obx.push((p[5] || "").replace(/\\\.br\\/g, "\n").replace(/\\F\\/g, "|").replace(/\\R\\/g, "~").replace(/\\S\\/g, "^"));
      }
    }
  }
  return { meta: m, body: obx.join("\n") };
}
function hl7Date(s?: string): string {
  if (!s) return "";
  const d = String(s).replace(/[^0-9]/g, "");
  if (d.length < 8) return "";
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10) || "00"}:${d.slice(10, 12) || "00"}:${d.slice(12, 14) || "00"}Z`;
  const t = Date.parse(iso);
  return isNaN(t) ? "" : new Date(t).toISOString();
}

// ── FHIR DiagnosticReport parse ──
function parseFHIR(res: any) {
  if (!res || typeof res !== "object") return { error: "FHIR resource missing" };
  const meta: Record<string, string> = { accession: "", mrn: "", patient_name: "", exam: "", interpreter: "", signed_at: "", modality: "" };
  meta.accession = firstIdentifier(res.identifier) || res.id || "";
  meta.exam = res.code?.text || res.code?.coding?.[0]?.display || "";
  meta.signed_at = res.issued || res.effectiveDateTime || "";
  const perf = (res.performer || res.resultsInterpreter || [])[0];
  meta.interpreter = perf?.display || perf?.reference || "";
  let body = res.conclusion || "";
  const pf = (res.presentedForm || [])[0];
  if (!body && pf?.data) { try { body = atob(pf.data.replace(/\s+/g, "")); } catch (_) {} }
  return { meta, body: String(body || "").replace(/<[^>]+>/g, " ").trim() };
}
function firstIdentifier(ids: any): string {
  if (Array.isArray(ids)) return ids[0]?.value || "";
  return ids?.value || "";
}

// Coarse body-part taxonomy for like-for-like peer-review matching. Derived
// from the exam description when present (most precise), else the report head.
// Order matters: combined abdomen+pelvis first, spine before chest (a thoracic
// spine study must not read as CHEST), specific regions before broad ones.
function deriveBodyPart(exam: string, text: string): string {
  const src = (exam && exam.trim()) ? exam : String(text || "").slice(0, 300);
  const s = src.toLowerCase();
  if (/abdom/.test(s) && /pelvi/.test(s)) return "ABDOMEN_PELVIS";
  if (/\b[ctl][- ]?spine\b|cervical spine|thoracic spine|lumbar spine|\bspine\b|vertebr|sacrum|coccyx/.test(s)) return "SPINE";
  if (/\b(head|brain|skull|cranial|sella|orbits?)\b|\biac\b/.test(s)) return "HEAD";
  if (/carotid|\bneck\b|thyroid|parotid/.test(s)) return "NECK";
  if (/mammogra|breast/.test(s)) return "BREAST";
  if (/cardiac|coronary|\bheart\b/.test(s)) return "CARDIAC";
  if (/chest|thorax|lung|pulmonary|\brib\b|pneumo|pe protocol/.test(s)) return "CHEST";
  if (/shoulder|humer|elbow|forearm|wrist|\bhand\b|finger|clavicle|scapula/.test(s)) return "UPPER_EXT";
  if (/\bhip\b|femur|femoral|knee|tibia|fibula|ankle|\bfoot\b|\btoe\b|runoff/.test(s)) return "LOWER_EXT";
  if (/pelvi|bladder|prostate|uter|ovar|scrot|testic|transvaginal/.test(s)) return "PELVIS";
  if (/abdom|liver|hepat|pancrea|spleen|kidney|renal|urogram|bowel|appendi|gallbladder|biliary/.test(s)) return "ABDOMEN";
  if (/whole body/.test(s)) return "WHOLE_BODY";
  return "";
}

function deriveModality(exam: string, text: string): string {
  const s = (exam + " " + text).toLowerCase();
  if (/\bct angiog|\bcta\b/.test(s)) return "CTA";
  if (/\bmr angiog|\bmra\b/.test(s)) return "MRA";
  if (/\bct\b|computed tomograph/.test(s)) return "CT";
  if (/\bmri?\b|magnetic resonance/.test(s)) return "MR";
  if (/ultrasound|sonograph|\bus\b|duplex/.test(s)) return "US";
  if (/mammogra/.test(s)) return "MAMMO";
  if (/x-?ray|radiograph|\bcxr\b/.test(s)) return "XR";
  if (/\bpet\b/.test(s)) return "PET";
  if (/nuclear|scintigra/.test(s)) return "NM";
  return "";
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Map an interpreter string to a physId on the practice roster. Matches against
// each physician's configured PACS aliases (p.pacsNames[]) and, as a fallback,
// their last name — case-insensitive, whole-token or substring.
function mapInterpreter(interpreter: string, physicians: any[]): number | null {
  const raw = (interpreter || "").toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  if (!raw || !Array.isArray(physicians)) return null;
  const tokens = new Set(raw.split(" ").filter((t) => t.length > 1));
  let best: number | null = null;
  for (const p of physicians) {
    const aliases: string[] = ([] as string[])
      .concat(Array.isArray(p.pacsNames) ? p.pacsNames : [])
      .concat(p.last ? [p.last] : [])
      .map((a) => String(a).toLowerCase().trim())
      .filter(Boolean);
    for (const a of aliases) {
      if (!a) continue;
      if (raw.includes(a) || a.split(" ").every((w) => tokens.has(w))) { best = p.id; break; }
    }
    if (best != null) break;
  }
  return best;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "missing ingest token" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Resolve practice from the ingest token (never trust a body practice_id).
  const { data: tok } = await sb.from("rs_ingest_tokens").select("practice_id").eq("token", token).maybeSingle();
  if (!tok?.practice_id) return json({ error: "invalid ingest token" }, 401);
  const practice_id = tok.practice_id as string;

  let payload: any;
  try { payload = await req.json(); } catch (_) { return json({ error: "body must be JSON" }, 400); }

  const fmt = (payload.format || "").toLowerCase();
  let parsed: any;
  if (fmt === "hl7") parsed = parseHL7(payload.message || payload.hl7 || "");
  else if (fmt === "fhir") parsed = parseFHIR(payload.resource || payload.report || payload);
  else {
    // structured JSON passthrough
    parsed = {
      meta: {
        accession: payload.accession || "", mrn: payload.mrn || "", patient_name: payload.patient_name || "",
        exam: payload.exam || "", interpreter: payload.interpreter || payload.reading_physician || "",
        signed_at: payload.signed_at || "", modality: payload.modality || "",
        body_part: payload.body_part || "",
      },
      body: payload.report_text || payload.text || "",
    };
  }
  if (parsed.error) return json({ error: parsed.error }, 422);

  const meta = parsed.meta || {};
  const report_text = String(parsed.body || "");
  if (!report_text && !meta.accession) return json({ error: "no report content or accession" }, 422);

  // Load the practice roster for interpreter → physId mapping. `deid` strips MRN.
  const { data: row } = await sb.from("radscheduler").select("data").eq("id", practice_id).maybeSingle();
  let physicians: any[] = [];
  try { physicians = JSON.parse(row?.data || "{}").physicians || []; } catch (_) {}
  const phys_id = mapInterpreter(meta.interpreter || "", physicians);

  const report_uid = (meta.accession && String(meta.accession).trim()) || (await sha256Hex(practice_id + "|" + report_text)).slice(0, 32);
  const modality = meta.modality || deriveModality(meta.exam || "", report_text);
  const body_part = meta.body_part || deriveBodyPart(meta.exam || "", report_text);
  const strip = payload.deid === true || payload.strip_mrn === true;

  const { error: upErr } = await sb.from("rs_reports").upsert({
    practice_id,
    report_uid,
    accession: meta.accession || null,
    mrn: strip ? null : (meta.mrn || null),
    patient_name: strip ? null : (meta.patient_name || null),
    exam: meta.exam || null,
    report_text,
    modality: modality || null,
    body_part: body_part || null,
    interpreter_raw: meta.interpreter || null,
    phys_id,
    signed_at: meta.signed_at || new Date().toISOString(),
    source: fmt || "json",
  }, { onConflict: "practice_id,report_uid" });

  if (upErr) return json({ error: "store failed: " + upErr.message }, 500);
  sb.from("rs_ingest_tokens").update({ last_used_at: new Date().toISOString() }).eq("token", token).then(() => {});

  // Auto peer review — a signed report triggers one pending review per rad per
  // shift, LIKE-FOR-LIKE: the review targets a prior of the same modality +
  // body part as the study just read (server-side cascade; if nothing matches,
  // nothing is created and the rad's next study that shift tries again).
  // Idempotent server-side (partial unique per shift day, deduped against the
  // roster sweep). Fire-and-forget: never blocks or fails the ingest.
  if (phys_id != null) {
    let signedMs = Date.parse(meta.signed_at || "");
    if (!Number.isFinite(signedMs)) signedMs = Date.now();
    // Freshness guard: a historical backfill (vendor replaying months of old
    // reports) must not create auto reviews for long-past shifts.
    if (Math.abs(Date.now() - signedMs) <= 48 * 3600 * 1000) {
      // Shift day boundary at 08:00 UTC (3am ET / midnight PT): one US
      // work/evening shift = one shift day. Must match the roster sweep's
      // [p_date+8h, p_date+32h) window.
      const shiftDate = new Date(signedMs - 8 * 3600 * 1000).toISOString().slice(0, 10);
      sb.rpc("rs_peer_review_autotrigger", {
        p_practice: practice_id, p_phys_id: phys_id, p_shift_date: shiftDate,
        p_modality: modality || null, p_body_part: body_part || null,
      }).then(() => {}, () => {});
    }
  }

  return json({ ok: true, report_uid, phys_id, matched: phys_id != null, interpreter: meta.interpreter || null });
});
