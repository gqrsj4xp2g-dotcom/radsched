// pacs-ingest — production ingest endpoint for signed radiology reports.
//
// Your PACS / RIS / dictation system (Fluency, PowerScribe, Epic) points its
// outbound signed-report feed here with:
//   Authorization: Bearer <per-practice ingest token>   (issue one in PACS Connections)
//   Content-Type: application/json
//   body: { format: 'hl7'|'fhir'|'json', ...payload }
//
// The token identifies the practice (never trust a body-supplied practice_id).
// We parse the report(s), extract the principal interpreting radiologist, map
// them to a physician on the roster, and upsert into public.rs_reports.
// A single HL7 message may carry multiple OBR groups → multiple report rows.
//
// verify_jwt = false — auth is the ingest bearer token, not a Supabase JWT.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_BODY = 3_000_000;      // reject bodies larger than ~3MB
const MAX_TEXT = 100_000;        // cap stored report_text

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Report = { meta: Record<string, string>; body: string };
type ParseResult = { reports?: Report[]; error?: string };

// Normalize an HL7/FHIR person name: subcomponents are '^'-separated and
// '&'-separated (NDL: ID&FAMILY&GIVEN) — flatten both to spaces.
function hl7Name(s?: string): string {
  return String(s || "").replace(/[\^&]/g, " ").replace(/\s+/g, " ").trim();
}

// HL7 DTM → ISO. Honors an explicit ±HHMM timezone offset when present so the
// signed time (and thus the peer-review shift day) is correct; otherwise UTC.
function hl7Date(s?: string): string {
  if (!s) return "";
  const m = String(s).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:\.\d+)?(?:([+-]\d{2})(\d{2}))?/);
  if (!m || !m[1]) return "";
  const off = m[7] ? `${m[7]}:${m[8] || "00"}` : "Z";
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}${off}`);
  return isNaN(t) ? "" : new Date(t).toISOString();
}

// ── HL7 v2 ORU^R01 parse — one Report per OBR group (multi-procedure safe) ──
function parseHL7(raw: string): ParseResult {
  const text = (raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text.startsWith("MSH|")) return { error: "Not an HL7 message — must start with MSH|" };
  const segs = text.split("\n").filter(Boolean);
  let mrn = "", patient_name = "";
  const groups: Array<{ meta: Record<string, string>; obx: string[] }> = [];
  let cur: { meta: Record<string, string>; obx: string[] } | null = null;
  for (const seg of segs) {
    const p = seg.split("|");
    if (p[0] === "PID") {
      mrn = ((p[3] || "").split("^")[0] || "").split("&")[0];
      patient_name = hl7Name(p[5]);
    } else if (p[0] === "OBR") {
      cur = { meta: { accession: "", exam: "", interpreter: "", signed_at: "", modality: "" }, obx: [] };
      // Prefer OBR-3 Filler Order Number (imaging accession per IHE SWF), then
      // OBR-2 placer, then OBR-18/19 vendor fields.
      cur.meta.accession = (p[3] || "").split("^")[0] || (p[2] || "").split("^")[0]
        || (p[18] || "").split("^")[0] || (p[19] || "").split("^")[0];
      cur.meta.exam = (p[4] || "").split("^")[1] || (p[4] || "").split("^")[0];
      const obr32 = p[32] || "";
      if (obr32) cur.meta.interpreter = hl7Name(obr32);
      cur.meta.signed_at = hl7Date(p[22]) || hl7Date(p[7]);
      groups.push(cur);
    } else if (p[0] === "OBX" && cur) {
      const vt = p[2] || "";
      if (vt === "TX" || vt === "FT" || vt === "ST") {
        cur.obx.push((p[5] || "")
          .replace(/\\\.br\\/g, "\n").replace(/\\F\\/g, "|").replace(/\\R\\/g, "~")
          .replace(/\\S\\/g, "^").replace(/\\T\\/g, "&"));
      }
    }
  }
  if (!groups.length) return { error: "no OBR segment in message" };
  return { reports: groups.map((g) => ({ meta: { ...g.meta, mrn, patient_name }, body: g.obx.join("\n") })) };
}

// ── FHIR DiagnosticReport parse ──
function parseFHIR(res: any): ParseResult {
  if (!res || typeof res !== "object") return { error: "FHIR resource missing" };
  const meta: Record<string, string> = { accession: "", mrn: "", patient_name: "", exam: "", interpreter: "", signed_at: "", modality: "" };
  meta.accession = acsnIdentifier(res.identifier) || res.id || "";
  meta.exam = res.code?.text || res.code?.coding?.[0]?.display || "";
  meta.signed_at = res.issued || res.effectiveDateTime || "";
  // Prefer the interpreting radiologist (resultsInterpreter) over performer
  // (frequently the issuing organization); skip Organization references.
  meta.interpreter = pickInterpreter(res.resultsInterpreter) || pickInterpreter(res.performer) || "";
  let body = res.conclusion || "";
  const pf = (res.presentedForm || [])[0];
  if (!body && pf?.data) body = decodePresentedForm(pf);
  return { reports: [{ meta, body: String(body || "").replace(/<[^>]+>/g, " ").trim() }] };
}
function acsnIdentifier(ids: any): string {
  const arr = Array.isArray(ids) ? ids : (ids ? [ids] : []);
  const acsn = arr.find((x: any) =>
    ((x?.type?.coding || []).some((c: any) => c?.code === "ACSN")) || /accession/i.test(x?.type?.text || ""));
  return (acsn?.value) || (arr[0]?.value) || "";
}
function pickInterpreter(arr: any): string {
  if (!Array.isArray(arr) || !arr.length) return "";
  for (const a of arr) {
    const ref = typeof a?.reference === "string" ? a.reference : "";
    if (ref.startsWith("Organization/")) continue;   // an org, not the reader
    const name = hl7Name(a?.display || ref);
    if (name) return name;
  }
  return "";
}
function decodePresentedForm(pf: any): string {
  const cleaned = String(pf?.data || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!cleaned) return "";
  try {
    const bytes = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
    const csm = /charset=([^;]+)/i.exec(pf?.contentType || "");
    const cs = (csm ? csm[1] : "utf-8").toLowerCase().replace("utf8", "utf-8");
    try { return new TextDecoder(cs).decode(bytes); }
    catch (_) { return new TextDecoder("utf-8").decode(bytes); }
  } catch (_) { return ""; }
}

// Body-part taxonomy for like-for-like matching — exam string when present,
// else the report head. Order: A+P combo first, spine before chest, etc.
function deriveBodyPart(exam: string, text: string): string {
  const s = ((exam && exam.trim()) ? exam : String(text || "").slice(0, 300)).toLowerCase();
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

// Modality — exam string when present (so a report BODY mentioning "compared to
// prior CT" can't flip an MRI to CT). Decide PET/NM and MR before plain CT.
function deriveModality(exam: string, text: string): string {
  const s = ((exam && exam.trim()) ? exam : String(text || "").slice(0, 200)).toLowerCase();
  if (/\bpet\b|positron/.test(s)) return "PET";                 // PET/CT is nuclear
  if (/nuclear|scintigra|\bspect\b|\bnm\b/.test(s)) return "NM";
  if (/\bct angiog|\bcta\b/.test(s)) return "CTA";
  if (/\bmr angiog|\bmra\b/.test(s)) return "MRA";
  if (/\bmri?\b|magnetic resonance/.test(s)) return "MR";       // MR before CT
  if (/\bct\b|computed tomograph/.test(s)) return "CT";
  if (/mammogra|tomosynthesis/.test(s)) return "MAMMO";
  if (/ultrasound|sonograph|\bus\b|duplex|echocardiog/.test(s)) return "US";
  if (/\bxr\b|\bx-?ray\b|radiograph|\bcxr\b|plain film/.test(s)) return "XR";
  if (/fluoroscop|\bfluoro\b/.test(s)) return "FLUORO";
  return "";
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Map an interpreter string to a physId. An alias matches only when ALL of its
// words appear as WHOLE tokens in the interpreter (no loose substring — "smith"
// must not match "smithson"). If 0 or >1 physicians match, we DON'T guess.
function mapInterpreter(interpreter: string, physicians: any[]): number | null {
  const raw = (interpreter || "").toLowerCase().replace(/[.,&^]/g, " ").replace(/\s+/g, " ").trim();
  if (!raw || !Array.isArray(physicians)) return null;
  const tokens = new Set(raw.split(" ").filter((t) => t.length > 1));
  if (!tokens.size) return null;
  const matches: number[] = [];
  for (const p of physicians) {
    const aliases: string[] = ([] as string[])
      .concat(Array.isArray(p.pacsNames) ? p.pacsNames : [])
      .concat(p.last ? [p.last] : [])
      .map((a) => String(a).toLowerCase().replace(/[.,&^]/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const hit = aliases.some((a) => { const w = a.split(" ").filter(Boolean); return w.length > 0 && w.every((x) => tokens.has(x)); });
    if (hit) matches.push(p.id);
  }
  return matches.length === 1 ? matches[0] : null;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "missing ingest token" }, 401);

  const cl = +(req.headers.get("content-length") || 0);
  if (cl && cl > MAX_BODY) return json({ error: "payload too large" }, 413);
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) return json({ error: "payload too large" }, 413);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: tok } = await sb.from("rs_ingest_tokens").select("practice_id").eq("token", token).maybeSingle();
  if (!tok?.practice_id) return json({ error: "invalid ingest token" }, 401);
  const practice_id = tok.practice_id as string;

  let payload: any;
  try { payload = JSON.parse(rawBody); } catch (_) { return json({ error: "body must be JSON" }, 400); }

  const fmt = (payload.format || "").toLowerCase();
  let parsed: ParseResult;
  if (fmt === "hl7") parsed = parseHL7(payload.message || payload.hl7 || "");
  else if (fmt === "fhir") parsed = parseFHIR(payload.resource || payload.report || payload);
  else parsed = { reports: [{
    meta: {
      accession: payload.accession || "", mrn: payload.mrn || "", patient_name: payload.patient_name || "",
      exam: payload.exam || "", interpreter: payload.interpreter || payload.reading_physician || "",
      signed_at: payload.signed_at || "", modality: payload.modality || "", body_part: payload.body_part || "",
    },
    body: payload.report_text || payload.text || "",
  }] };
  if (parsed.error) return json({ error: parsed.error }, 422);
  const reports = parsed.reports || [];
  if (!reports.length) return json({ error: "no reports parsed" }, 422);

  const { data: row } = await sb.from("radscheduler").select("data").eq("id", practice_id).maybeSingle();
  let physicians: any[] = [];
  try { physicians = JSON.parse(row?.data || "{}").physicians || []; } catch (_) {}
  const strip = payload.deid === true || payload.strip_mrn === true;
  const cap = (s: any, n: number) => (s ? String(s).slice(0, n) : null);

  const results: any[] = [];
  for (const rep of reports) {
    const meta = rep.meta || {};
    const report_text = String(rep.body || "").slice(0, MAX_TEXT);
    if (!report_text && !meta.accession) { results.push({ skipped: "empty" }); continue; }

    const phys_id = mapInterpreter(meta.interpreter || "", physicians);
    // Normalize signed_at so a malformed date can't 500 the whole ingest.
    const sm = Date.parse(meta.signed_at || "");
    const signedAt = Number.isFinite(sm) ? new Date(sm).toISOString() : new Date().toISOString();

    // Idempotency key: accession (the study id) when present; else a stable
    // study key from mrn+exam+day (so prelim→final→addendum collapse to one
    // row); else a content hash. Distinct studies get distinct keys.
    let report_uid: string;
    if (meta.accession && String(meta.accession).trim()) {
      report_uid = String(meta.accession).trim().slice(0, 128);
    } else if (meta.mrn && meta.exam) {
      report_uid = "k" + (await sha256Hex([practice_id, meta.mrn, meta.exam, signedAt.slice(0, 10)].join("|"))).slice(0, 31);
    } else {
      report_uid = "h" + (await sha256Hex(practice_id + "|" + report_text)).slice(0, 31);
    }

    // Store modality/body_part uppercase+trimmed so the like-for-like query
    // (which compares raw columns against an uppercased param) is sargable.
    const modality = ((meta.modality || deriveModality(meta.exam || "", report_text)) || "").toUpperCase().trim();
    const body_part = ((meta.body_part || deriveBodyPart(meta.exam || "", report_text)) || "").toUpperCase().trim();

    const { error: upErr } = await sb.from("rs_reports").upsert({
      practice_id, report_uid,
      accession: cap(meta.accession, 128),
      mrn: strip ? null : cap(meta.mrn, 64),
      patient_name: strip ? null : cap(meta.patient_name, 200),
      exam: cap(meta.exam, 300),
      report_text,
      modality: modality || null,
      body_part: body_part || null,
      interpreter_raw: cap(meta.interpreter, 200),
      phys_id,
      signed_at: signedAt,
      source: fmt || "json",
    }, { onConflict: "practice_id,report_uid" });
    if (upErr) { results.push({ error: upErr.message }); continue; }

    if (phys_id != null) {
      const signedMs = Date.parse(signedAt);
      if (Number.isFinite(signedMs) && Math.abs(Date.now() - signedMs) <= 48 * 3600 * 1000) {
        const shiftDate = new Date(signedMs - 8 * 3600 * 1000).toISOString().slice(0, 10);
        sb.rpc("rs_peer_review_autotrigger", {
          p_practice: practice_id, p_phys_id: phys_id, p_shift_date: shiftDate,
          p_modality: modality || null, p_body_part: body_part || null,
        }).then(() => {}, () => {});
      }
    }
    results.push({ report_uid, phys_id, matched: phys_id != null });
  }
  sb.from("rs_ingest_tokens").update({ last_used_at: new Date().toISOString() }).eq("token", token).then(() => {});

  // Backward-compatible response: top-level fields reflect the first stored
  // report (the common single-report case), plus a full per-report array.
  const first = results.find((r) => r.report_uid) || {};
  return json({ ok: true, count: results.length, results, report_uid: first.report_uid, phys_id: first.phys_id, matched: first.matched });
});
