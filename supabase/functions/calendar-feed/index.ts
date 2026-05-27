// calendar-feed — serve per-user iCal (.ics) feeds so calendar apps can subscribe to
// RadScheduler shifts/holidays/vacations. Authentication is via a per-user token
// stored in the users[] array of the practice row. No JWT required — the token in
// the URL IS the credential (like a private ICS feed URL from Google Calendar).
//
// URL format: https://<project>.supabase.co/functions/v1/calendar-feed?token=<hex>
//   or:      webcal://<project>.supabase.co/functions/v1/calendar-feed?token=<hex>
//
// Response: text/calendar RFC 5545 body.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Helpers ─────────────────────────────────────────────────────────────

function pad(n: number | string): string {
  return String(n).padStart(2, "0");
}

function fmtDateOnly(iso: string): string {
  return iso.replace(/-/g, "");
}

function fmtDateTime(date: string, time: string): string {
  const [h, m] = time.split(":");
  return `${fmtDateOnly(date)}T${pad(h)}${pad(m)}00`;
}

function escapeText(s: unknown): string {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function nextDateISO(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Default shift windows — should mirror the client logic in /_myEventsInRange
function timesFor(shiftLabel: string): { start: string; end: string; allDay: boolean } {
  const defs: Record<string, { start: string; end: string }> = {
    "1st":      { start: "07:00", end: "15:00" },
    "2nd":      { start: "15:00", end: "23:00" },
    "3rd":      { start: "23:00", end: "07:00" },
    "Home":     { start: "07:00", end: "17:00" },
    "IR Call":  { start: "17:00", end: "07:00" },
    "Holiday Call": { start: "07:00", end: "07:00" },
  };
  if (defs[shiftLabel]) return { ...defs[shiftLabel], allDay: false };
  return { start: "00:00", end: "23:59", allDay: true };
}

type Event = {
  uid: string;
  date: string;
  endDate?: string;
  summary: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
};

function buildEvents(data: any, physId: number, startISO: string, endISO: string): Event[] {
  const inRange = (d: string | undefined): boolean => !!d && d >= startISO && d <= endISO;
  const events: Event[] = [];

  for (const s of data.drShifts || []) {
    if (s.physId === physId && inRange(s.date)) {
      const t = timesFor(s.shift);
      events.push({
        uid: `dr-${s.id}@radscheduler`,
        date: s.date,
        summary: `DR ${s.shift || ""}${s.site ? " @ " + s.site : ""}`,
        description: `RadScheduler · DR shift${s.sub ? " · " + s.sub : ""}${s.notes ? "\n" + s.notes : ""}`,
        location: s.site || "",
        ...t,
      });
    }
  }
  for (const s of data.irShifts || []) {
    if (s.physId === physId && inRange(s.date)) {
      const t = timesFor(s.shift || "1st");
      events.push({
        uid: `ir-${s.id}@radscheduler`,
        date: s.date,
        summary: `IR ${s.shift || "1st"}${s.site ? " @ " + s.site : ""}`,
        description: `RadScheduler · IR shift${s.sub ? " · " + s.sub : ""}${s.notes ? "\n" + s.notes : ""}`,
        location: s.site || "",
        ...t,
      });
    }
  }
  for (const c of data.irCalls || []) {
    if (c.physId === physId && inRange(c.date)) {
      const t = timesFor("IR Call");
      events.push({
        uid: `irc-${c.id}@radscheduler`,
        date: c.date,
        summary: `IR Call (${c.callType || "daily"})${c.site ? " @ " + c.site : ""}`,
        description: `RadScheduler · IR call · ${c.irGroup || ""}${c.notes ? "\n" + c.notes : ""}`,
        location: c.site || "",
        ...t,
      });
    }
  }
  for (const w of data.weekendCalls || []) {
    if (w.physId !== physId) continue;
    const dates = [w.satDate, w.sunDate, w.date].filter(Boolean);
    const seen = new Set<string>();
    for (const d of dates) {
      if (seen.has(d)) continue;
      seen.add(d);
      if (!inRange(d)) continue;
      events.push({
        uid: `wk-${w.id}-${d}@radscheduler`,
        date: d,
        summary: `Weekend Call${w.sub ? " · " + w.sub : ""}`,
        description: `RadScheduler · Weekend call${w.notes ? "\n" + w.notes : ""}`,
        location: w.site || "",
        start: "07:00", end: "07:00", allDay: false,
      });
    }
  }
  for (const h of data.holidays || []) {
    if (h.physId === physId && inRange(h.date)) {
      events.push({
        uid: `hol-${h.id}@radscheduler`,
        date: h.date,
        summary: `\uD83C\uDFD6 Holiday Call: ${h.name}`,
        description: `RadScheduler · ${h.group || "Holiday"}${h.notes ? "\n" + h.notes : ""}`,
        location: "",
        start: "00:00", end: "23:59", allDay: true,
      });
    }
  }
  for (const v of data.vacations || []) {
    if (v.physId !== physId) continue;
    if (!inRange(v.start) && !inRange(v.end)) continue;
    events.push({
      uid: `vac-${v.id}@radscheduler`,
      date: v.start,
      endDate: v.end,
      summary: `\uD83C\uDF34 ${v.type || "Vacation"}${v.notes ? ": " + v.notes : ""}`,
      description: `RadScheduler · ${v.type || "Vacation"}`,
      location: "",
      allDay: true, start: "00:00", end: "23:59",
    });
  }

  events.sort((a, b) => (a.date + (a.start || "")).localeCompare(b.date + (b.start || "")));
  return events;
}

function eventsToICS(events: Event[], calName: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RadScheduler//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calName)}`,
    "X-WR-TIMEZONE:UTC",
    "REFRESH-INTERVAL;VALUE=DURATION:PT3H",
    "X-PUBLISHED-TTL:PT3H",
  ];
  for (const ev of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (ev.allDay && ev.endDate) {
      lines.push(`DTSTART;VALUE=DATE:${fmtDateOnly(ev.date)}`);
      lines.push(`DTEND;VALUE=DATE:${fmtDateOnly(addDaysISO(ev.endDate, 1))}`);
    } else if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${fmtDateOnly(ev.date)}`);
      lines.push(`DTEND;VALUE=DATE:${fmtDateOnly(nextDateISO(ev.date))}`);
    } else {
      const startDT = fmtDateTime(ev.date, ev.start!);
      let endDate = ev.date;
      if (ev.end! < ev.start! || (ev.end === ev.start && ev.start !== "00:00")) {
        endDate = nextDateISO(ev.date);
      }
      const endDT = fmtDateTime(endDate, ev.end!);
      lines.push(`DTSTART:${startDT}`);
      lines.push(`DTEND:${endDT}`);
    }
    lines.push(`SUMMARY:${escapeText(ev.summary)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
    if (ev.location)    lines.push(`LOCATION:${escapeText(ev.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// ── Handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: CORS });
  }

  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return new Response("Server not configured: SUPABASE_SERVICE_ROLE_KEY missing", { status: 500, headers: CORS });
    }

    const url = new URL(req.url);
    const token = url.searchParams.get("token") || "";
    if (!token || token.length < 16) {
      return new Response("Missing or invalid token", { status: 401, headers: CORS });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Scan every practice row, find the user with this token
    const { data: rows, error } = await admin.from("radscheduler").select("id, data");
    if (error) {
      console.error("[calendar-feed] DB error:", error);
      return new Response("Database error", { status: 500, headers: CORS });
    }

    let matchedUser: any = null;
    let practiceData: any = null;
    for (const row of rows || []) {
      let parsed: any;
      try {
        parsed = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
      } catch {
        continue;
      }
      const u = (parsed.users || []).find((x: any) => x.calFeedToken === token);
      if (u) {
        matchedUser = u;
        practiceData = parsed;
        break;
      }
    }

    if (!matchedUser || !practiceData) {
      return new Response("Token not found or revoked", { status: 404, headers: CORS });
    }
    if (matchedUser.physId == null) {
      return new Response("Account has no linked physician profile", { status: 400, headers: CORS });
    }

    // Date range: past 30 days through next 365 days (rolling window)
    const startISO = addDaysISO(todayISO(), -30);
    const endISO   = addDaysISO(todayISO(),  365);

    const events = buildEvents(practiceData, matchedUser.physId, startISO, endISO);
    const calName = `${matchedUser.first || ""} ${matchedUser.last || ""} - RadScheduler`.trim();
    const ics = eventsToICS(events, calName);

    return new Response(ics, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `inline; filename="radscheduler.ics"`,
        "Cache-Control": "public, max-age=900", // 15 min cache
      },
    });
  } catch (e: any) {
    console.error("[calendar-feed] unhandled error:", e);
    return new Response("Internal error: " + (e?.message || String(e)), { status: 500, headers: CORS });
  }
});
