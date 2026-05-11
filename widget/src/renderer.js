/* RadScheduler Widget — renderer process.
 *
 * Boot flow:
 *   1. Try to load a stored pairing code via the preload bridge.
 *   2. If absent, show the pairing screen.
 *   3. Otherwise decode + verify the code, query Supabase for the
 *      practice's shared row (RLS-gated, anon-key read), filter to
 *      this physician's day, render dashboard.
 *
 * Refresh: every 5 minutes + manual button.
 *
 * The widget is read-only: it does not mutate any RadScheduler state.
 *
 * ── PACS integration roadmap ────────────────────────────────────────
 * The studyCount + debulking counters are stub-zero today. To wire up
 * real data, implement fetchPACSStats(physId, dateISO) below — it should
 * return:
 *   {
 *     studiesCompletedToday: number,
 *     wRVUEarnedToday:       number,
 *     debulkingToday:        number,
 *     debulkingThisWeek:     number,
 *     debulkingThisMonth:    number,
 *   }
 * Two recommended patterns:
 *   1) Per-physician local broker on http://localhost:7711
 *   2) Practice-wide PACS proxy with a shared bearer token
 * Either way, update the CSP `connect-src` in renderer.html before
 * shipping. The render path already consumes these fields — wire the
 * fetch and the UI lights up automatically.
 */

const root = document.getElementById('root');

// ─── State ───────────────────────────────────────────────────────
let _activeTab = 'today';          // 'today' | 'debulking' | 'credits'
let _lastPayload = null;
let _lastPractice = null;
let _lastDigest = null;
let _lastPairingCode = null;       // raw pairing code (for edge-fn POST)
let _alwaysOnTop = true;
// Last total of today's credit hours (for the auto-counter bump animation
// — when it changes, we briefly scale the number up + green-flash it).
let _lastCreditsToday = null;
// Local edit state for the credits tab — id of the credit currently
// being edited inline, or null.
let _creditEditingId = null;
// Whether we've already applied the per-physician accent tint to CSS
// variables. Set on first dashboard load + refreshed if phys.color
// changes between fetches.
let _appliedAccentColor = null;

// ─── Helpers ──────────────────────────────────────────────────────
function fromB64Url(s){
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while(s.length % 4) s += '=';
  return atob(s);
}

async function hmacB64Url(secret, msg){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  const bytes = new Uint8Array(mac);
  let s = ''; for(let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function decodePairingCode(code){
  try{ return JSON.parse(fromB64Url(code.trim())); }
  catch(_){ return null; }
}

async function verifyPairing(payload){
  if(!payload || !payload.sig || !payload.sbAnonKey) return false;
  const { sig, ...rest } = payload;
  const body = JSON.stringify(rest);
  const expected = await hmacB64Url(rest.sbAnonKey, body);
  return expected === sig;
}

function fmtDate(d){
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${dy}`;
}

function escHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ─── Per-physician accent color tinting ──────────────────────────
// If the paired physician has a custom color set in their RadScheduler
// profile (p.color = "#rrggbb"), tint the widget's accent CSS vars.
// Falls back to the default cyan when unset. Applied once after the
// practice loads + re-applied if the color changes between refreshes.
function _hexToHsl(hex){
  if(!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if(max !== min){
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch(max){
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
      case g: h = ((b - r) / d + 2) * 60; break;
      case b: h = ((r - g) / d + 4) * 60; break;
    }
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
function _applyPhysicianAccent(hexColor){
  if(_appliedAccentColor === hexColor) return;   // unchanged → no-op
  _appliedAccentColor = hexColor;
  const root = document.documentElement;
  if(!hexColor){
    // Reset to defaults defined in renderer.html.
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent2');
    return;
  }
  const hsl = _hexToHsl(hexColor);
  if(!hsl) return;
  // Use the phys color as the primary accent; derive a slightly darker
  // shade as the hover/secondary. Saturation clamped so very-pale colors
  // still produce a usable button/ring.
  const sat = Math.max(60, hsl.s);
  const lightAccent = `hsl(${hsl.h}, ${sat}%, ${Math.max(40, Math.min(70, hsl.l))}%)`;
  const darkAccent  = `hsl(${hsl.h}, ${sat}%, ${Math.max(30, Math.min(55, hsl.l - 10))}%)`;
  root.style.setProperty('--accent', lightAccent);
  root.style.setProperty('--accent2', darkAccent);
}

// ─── Practice-data fetch via 'widget-data' edge function ──────────
// As of v1.0.4 we proxy through a Supabase Edge Function (deployed
// at /functions/v1/widget-data). Background:
//
//   The radscheduler table's RLS policies require an authenticated
//   user — direct PostgREST reads from the widget (anon-key only,
//   no user JWT) returned 401 / "permission denied for table
//   radscheduler" (PG error 42501).
//
// The edge function:
//   1. Receives the full pairing code in the request body
//   2. Verifies the HMAC signature with the anon key as shared secret
//      (proves the code came from a RadScheduler admin)
//   3. Uses the SERVICE ROLE (server-side only) to fetch the row
//   4. Returns the practice JSON wrapped as { data: {...} }
//
// No RLS changes needed; service role key never leaves the server.
//
// We pass the FULL signed pairing code as the body and the public
// anon key as Authorization. The function is verify_jwt:false so
// PostgREST doesn't reject before our handler even runs.
async function fetchPracticeData(p){
  if(!_lastPairingCode){
    throw new Error('Internal: pairing code not in scope. Re-launch the widget.');
  }
  const url = `${p.sbUrl}/functions/v1/widget-data`;
  let resp;
  try{
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': p.sbAnonKey,
        'Authorization': 'Bearer ' + p.sbAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: _lastPairingCode }),
    });
  } catch(e){
    throw new Error('Network error contacting widget-data edge function:\n  ' + (e.message || String(e)) + '\n\nURL: ' + url);
  }
  const bodyText = await resp.text().catch(() => '');
  let parsed = null;
  try{ parsed = JSON.parse(bodyText); } catch(_){}
  if(!resp.ok){
    const errMsg = (parsed && parsed.error) || bodyText || '(no body)';
    const keyFp = (p.sbAnonKey || '').slice(0, 12) + '…';
    let hint = '';
    if(resp.status === 401){
      hint = '\n\nThe edge function rejected the pairing code. Likely:\n' +
             '  • Code expired — admin needs to issue a fresh one.\n' +
             '  • Code was tampered with or the anon key changed.';
    } else if(resp.status === 404){
      hint = '\n\n404 may mean the widget-data edge function is not deployed in this Supabase project, OR the practice id in the code is wrong.';
    } else if(resp.status === 500){
      hint = '\n\nServer-side error inside the edge function. Check the Supabase dashboard → Edge Functions → widget-data → Logs.';
    }
    throw new Error(
      'widget-data ' + resp.status + ' on ' + url + '\n' +
      'Anon-key fingerprint: ' + keyFp + '\n' +
      'Practice id: ' + p.practiceId + '\n' +
      'Response: ' + errMsg + hint
    );
  }
  if(!parsed || parsed.data == null){
    throw new Error('Edge function returned no data field. Body:\n' + bodyText.slice(0, 600));
  }
  // The edge function should return parsed.data as a real object, but
  // for ~2 weeks the deployed v4 was returning the raw text-column
  // value (a JSON STRING). Every .drShifts / .physicians access on a
  // string is undefined → empty schedule. Defensively parse here so
  // the widget works against both old and new edge function
  // deployments without requiring a synchronized rollout.
  let practiceData = parsed.data;
  if(typeof practiceData === 'string'){
    try{ practiceData = JSON.parse(practiceData); }
    catch(e){
      throw new Error('Practice data string failed to parse:\n  ' + (e.message || String(e)) + '\n\nFirst 200 chars: ' + practiceData.slice(0, 200));
    }
  }
  return practiceData;
}

// ─── PACS fetch (stub) ───────────────────────────────────────────
// Currently returns zeros + a `pacsConnected:false` flag. When you wire
// up your PACS broker (see top-of-file comment), replace this body with
// a real fetch and CORS will already be allowed for the new host (after
// you update the CSP in renderer.html).
async function fetchPACSStats(/* physId, dateISO */){
  return {
    pacsConnected: false,
    studiesCompletedToday: 0,
    wRVUEarnedToday: 0,
    // Auto-next percentage = how often the physician used PACS auto-
    // advance (versus manually picking the next study). High auto-next
    // = good worklist hygiene + fast turn-around. Used as a debulking
    // gate (must be ≥ 90% before backlog clearing is allowed).
    autoNextPct: 0,
    debulkingToday: 0,
    debulkingThisWeek: 0,
    debulkingThisMonth: 0,
  };
}

// ─── Day computation ─────────────────────────────────────────────
function computeDayDigest(practice, physId, dateISO){
  const out = {
    physName: '',
    shifts: [],
    wRVUGoalTotal: 0,
    studyCount: 0,        // PACS-integration placeholder
    studyTarget: 0,
    driveTimeCredit: 0,
    onCall: false,
    onVacation: false,
    debulkingEligibleByPolicy: false,
    debulkingReasons: [],
  };
  const phys = (practice.physicians || []).find(p => p.id === physId);
  if(phys) out.physName = `${phys.first || ''} ${phys.last || ''}`.trim();

  const onVac = (practice.vacations || []).some(v => v.physId === physId && v.start <= dateISO && v.end >= dateISO);
  out.onVacation = onVac;

  const cfg = practice.cfg || {};
  const wRVUDefaults = cfg.wRVUDefaults || {};
  const dtPerHour = +(cfg.driveTimeWRVUPerHour || 0);
  const wMult = phys && phys.wRVUMultiplier != null ? +phys.wRVUMultiplier : 1.0;
  function goalFor(shape, kind){
    if(shape && shape.wRVUGoal != null && +shape.wRVUGoal >= 0) return +shape.wRVUGoal;
    let key = 'Home';
    if(kind === 'wk') key = 'Weekend Call';
    else if(kind === 'hol') key = 'Holiday';
    else if(kind === 'irc') key = (shape.callType === 'weekend') ? 'IR weekend' : 'IR daily';
    else key = (shape && shape.shift) || '1st';
    const base = +wRVUDefaults[key] || 0;
    return Math.round(base * wMult);
  }
  function driveCredit(site){
    if(!site || site === 'At Home / Remote' || !dtPerHour) return 0;
    const dt = (practice.driveTimes && practice.driveTimes[physId] && practice.driveTimes[physId][site]) || 0;
    return dt ? +(dt / 60 * dtPerHour).toFixed(1) : 0;
  }

  // Shift time-window lookup. cfg.shiftTimes is keyed by the shift's
  // short label ('1st', '2nd', '3rd', 'Home', etc.) and holds:
  //   { dep: 'HH:MM' (start), ret: 'HH:MM' (end) }
  // Used downstream to compute time-of-day-proportional wRVU
  // expectations for the debulking check.
  const shiftTimes = (cfg && cfg.shiftTimes) || {};
  function _winFor(shiftLabel){
    const t = shiftTimes[shiftLabel];
    if(!t || !t.dep || !t.ret) return null;
    return { startHM: t.dep, endHM: t.ret };
  }

  (practice.drShifts || []).forEach(s => {
    if(s.physId === physId && s.date === dateISO){
      const goal = goalFor(s, 'dr');
      out.wRVUGoalTotal += goal;
      const dt = driveCredit(s.site);
      out.driveTimeCredit += dt;
      out.shifts.push({ kind: 'DR', code: s.shift, label: `${s.shift} · ${s.site || '—'}${s.sub ? ' · ' + s.sub : ''}`, goal, site: s.site, window: _winFor(s.shift) });
    }
  });
  (practice.irShifts || []).forEach(s => {
    if(s.physId === physId && s.date === dateISO){
      const goal = goalFor(s, 'ir');
      out.wRVUGoalTotal += goal;
      const dt = driveCredit(s.site);
      out.driveTimeCredit += dt;
      out.shifts.push({ kind: 'IR', code: 'IR ' + (s.shift || ''), label: `IR ${s.shift} · ${s.site || '—'}`, goal, site: s.site, window: _winFor(s.shift) });
    }
  });
  (practice.irCalls || []).forEach(c => {
    const matchDate = c.date === dateISO || (c.callType === 'weekend' && [0,1,2,3].some(o => {
      const d = new Date(c.date);
      d.setDate(d.getDate() + o);
      return fmtDate(d) === dateISO;
    }));
    if(c.physId === physId && matchDate){
      out.onCall = true;
      const goal = goalFor(c, 'irc');
      out.wRVUGoalTotal += goal;
      out.shifts.push({ kind: 'IR Call', label: `IR ${c.callType || 'daily'} call`, goal });
    }
  });
  (practice.weekendCalls || []).forEach(w => {
    if(w.physId === physId && (w.satDate === dateISO || w.sunDate === dateISO)){
      out.onCall = true;
      const goal = goalFor(w, 'wk');
      out.wRVUGoalTotal += goal;
      out.shifts.push({ kind: 'Weekend', label: 'Weekend Call', goal });
    }
  });
  (practice.holidays || []).forEach(h => {
    if(h.physId === physId && h.date === dateISO){
      out.onCall = true;
      const goal = goalFor(h, 'hol');
      out.wRVUGoalTotal += goal;
      out.shifts.push({ kind: 'Holiday', label: `Holiday: ${h.name || ''}`, goal });
    }
  });

  out.studyTarget = Math.max(0, Math.round(out.wRVUGoalTotal / 1.5));

  // Debulking is intentionally NOT blocked by off-day / vacation /
  // day-of-week status (per spec: "debulking shouldn't be disabled
  // for anybody who is off or on vacation"). The current gates are:
  //   1. Admin-flagged eligible (per-physician opt-out via profile)
  //   2. wRVU goal hit (added in renderDebulkingTab):
  //        • If goal=0 → automatic pass (no expectation set)
  //        • Else: pass if delivered ≥ 107.5% of full-day goal
  //          OR delivered ≥ proportional expectation by now (each
  //          shift contributes goal × elapsed-fraction × 1.075).
  //          Time-of-day correlation comes from cfg.shiftTimes.
  //   3. Auto-next ≥ 90% in the debulking window (or daily fallback
  //      when the PACS broker doesn't break it out separately).
  const phys2 = phys;
  const adminAllowed = !phys2 || phys2.debulkingEligible !== false;
  out.debulkingBaseChecks = [
    { name: 'Admin-flagged eligible', pass: adminAllowed, detail: adminAllowed ? 'Yes' : 'No (admin disabled in physician profile)' },
  ];

  return out;
}

// ─── Credits + delivered wRVU helpers ─────────────────────────────
// "Delivered wRVU" today =
//     pacs.wRVUEarnedToday                         (PACS-fed studies)
//   + sum(today's credit hours) × cfg.creditHoursToWRVU rate
// Drive-time credit is shown separately and NOT added — it's a
// reimbursement metric, not productivity.
function _creditWRVUToday(){
  if(!_lastPractice) return 0;
  const cfg = _lastPractice.cfg || {};
  const rate = +(cfg.creditHoursToWRVU != null ? cfg.creditHoursToWRVU : 28);  // default 28 wRVU per hour
  const hours = _hoursSum(_creditsToday());
  return Math.round(hours * rate * 10) / 10;
}
function _deliveredWRVUToday(){
  if(!_lastDigest) return 0;
  const pacsW = +(_lastDigest._pacs?.wRVUEarnedToday || 0);
  return pacsW + _creditWRVUToday();
}
// Convert 'HH:MM' to fractional hours-since-midnight. '06:30' → 6.5.
function _hmToHours(hm){
  if(!hm || typeof hm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if(!m) return null;
  return +m[1] + (+m[2]) / 60;
}
function _nowHours(){
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}
// What fraction of this shift's window has elapsed AS OF NOW?
//   • Shift hasn't started yet → 0
//   • Currently in shift       → (now - start) / (end - start)
//   • Shift has ended          → 1
//   • No window known          → 1 (treat as a "whole-day" shift)
// Handles shifts that cross midnight (3rd shift) by adding 24 to the
// end if it's earlier than the start.
function _shiftElapsedFraction(shift){
  if(!shift || !shift.window) return 1;
  const s = _hmToHours(shift.window.startHM);
  let   e = _hmToHours(shift.window.endHM);
  if(s == null || e == null) return 1;
  if(e <= s) e += 24;  // crosses midnight (e.g., 17:00 → 01:00)
  const now = _nowHours();
  if(now <= s) return 0;
  if(now >= e) return 1;
  return (now - s) / (e - s);
}

// Compute the "expected" wRVU by NOW, given shift time windows and
// the 107.5% target. Used so a physician who's only midway through
// their shift isn't blocked from debulking just because they haven't
// hit 107.5% of the WHOLE day's goal yet.
//
//   expected_by_now = Σ shift.goal × elapsed_fraction(shift) × 1.075
//
// On-call / weekend / holiday shifts have no time window — they
// count as whole-day shifts (elapsed_fraction = 1).
function _expectedWRVUByNow(){
  if(!_lastDigest) return 0;
  const shifts = _lastDigest.shifts || [];
  let expected = 0;
  for(const s of shifts){
    const goal = +s.goal || 0;
    const frac = _shiftElapsedFraction(s);
    expected += goal * frac;
  }
  return expected * 1.075;
}

function _debulkingChecks(){
  if(!_lastDigest) return [];
  const base = _lastDigest.debulkingBaseChecks || [];
  const pacs = _lastDigest._pacs || {};
  const dayGoal = _lastDigest.wRVUGoalTotal || 0;
  const delivered = _deliveredWRVUToday();
  const dayThreshold = dayGoal * 1.075;
  const proportional = _expectedWRVUByNow();
  const expectedNow = Math.max(0, proportional);

  // Rule 1: "if no goal set for debulking then debulking is eligible"
  // — when the day has no wRVU goal at all, the wRVU check
  // automatically passes.
  // Rule 2 + 3: "debulking correlates with times of the shifts" and
  // "allows shifts to be correlated with time if the radiologist
  // didn't hit 107.5%". Implementation: compute a time-weighted
  // expectation (each shift contributes goal × elapsed%) and check
  // against that. The full-day 107.5% check still passes — it's just
  // also OK to hit the proportional target before the day's done.
  let wrvuPass, wrvuDetail;
  if(dayGoal <= 0){
    wrvuPass = true;
    wrvuDetail = 'No goal set — eligible by default';
  } else if(delivered >= dayThreshold){
    wrvuPass = true;
    wrvuDetail = `${delivered.toFixed(1)} / ${dayGoal} (${((delivered/dayGoal)*100).toFixed(1)}% of day) · cleared 107.5%`;
  } else if(delivered >= expectedNow && expectedNow > 0){
    wrvuPass = true;
    wrvuDetail = `${delivered.toFixed(1)} delivered ≥ ${expectedNow.toFixed(1)} expected by this time (on-pace)`;
  } else {
    wrvuPass = false;
    const pct = (delivered/dayGoal)*100;
    if(expectedNow > 0){
      wrvuDetail = `${delivered.toFixed(1)} / ${expectedNow.toFixed(1)} expected by now (need ${(expectedNow-delivered).toFixed(1)} more) · ${pct.toFixed(1)}% of day`;
    } else {
      wrvuDetail = `${delivered.toFixed(1)} / ${dayGoal} (${pct.toFixed(1)}%) — shifts haven't started yet`;
    }
    if(!pacs.pacsConnected) wrvuDetail += ' · PACS not connected';
  }

  // Rule 4: "doesn't count if the autonext in the debulking is not
  // 90%". The PACS plugin should provide a `debulkingAutoNextPct`
  // measured during the debulking window specifically (distinct from
  // the day's overall auto-next). Fall back to the daily figure
  // until the broker exposes the more granular metric.
  const debAutoSrc = (pacs.debulkingAutoNextPct != null) ? 'debulking' : 'today';
  const autoNext = +(pacs.debulkingAutoNextPct != null ? pacs.debulkingAutoNextPct : (pacs.autoNextPct || 0));
  const anCheck = {
    name: 'Auto-next ≥ 90% in the debulking',
    pass: autoNext >= 90,
    detail: pacs.pacsConnected
      ? `${autoNext.toFixed(1)}% (${debAutoSrc})`
      : 'Awaiting PACS',
  };

  return [...base, { name:'wRVU goal hit', pass:wrvuPass, detail:wrvuDetail }, anCheck];
}

// ─── Renders ─────────────────────────────────────────────────────
async function renderPairing(errMsg){
  document.querySelector('.body').innerHTML = `
    <div class="pair">
      <h2>Pair this widget</h2>
      <p>Paste the pairing code your RadScheduler admin gave you. The code links this widget to your physician profile.</p>
      <textarea id="pair-code" placeholder="ABC...123 (paste here)"></textarea>
      <button id="pair-submit">Pair widget</button>
      <button id="pair-from-clip" style="background:transparent;color:var(--accent);border:1px solid var(--accent);margin-top:6px">📋 Paste from clipboard</button>
      <div class="err" id="pair-err">${errMsg ? escHtml(errMsg) : ''}</div>
    </div>`;
  const tabs = document.getElementById('tabs');
  if(tabs) tabs.style.display = 'none';
  document.getElementById('pair-submit').onclick = onPairSubmit;
  document.getElementById('pair-from-clip').onclick = onPairFromClipboard;
  document.getElementById('pair-code').focus();
  // ── Auto-pair: try the clipboard immediately on first show ──────
  // The admin's "Send install kit" flow asks the physician to copy
  // their pairing code BEFORE launching the widget. If we find a
  // valid code waiting in the clipboard, pair silently and skip the
  // textbox entirely. Falsy / wrong-shape clipboard contents fall
  // through to the manual paste UI.
  try{
    const clip = (await window.rsWidget.readClipboard()) || '';
    if(clip && clip.trim().length > 50){
      const payload = decodePairingCode(clip.trim());
      if(payload && await verifyPairing(payload) && (!payload.exp || new Date(payload.exp).getTime() >= Date.now())){
        // Show a brief "auto-pairing…" message so the user sees what happened.
        document.querySelector('.body').innerHTML = `<div class="pair"><h2>✓ Code detected on clipboard</h2><p>Pairing widget to ${escHtml((payload.physFirst||'') + ' ' + (payload.physLast||''))}…</p></div>`;
        await window.rsWidget.savePairing(clip.trim());
        await refresh();
        return;
      }
    }
  }catch(_){}
}

async function onPairFromClipboard(){
  try{
    const clip = await window.rsWidget.readClipboard();
    const ta = document.getElementById('pair-code');
    if(clip && ta){ ta.value = clip.trim(); }
    await onPairSubmit();
  }catch(e){
    const errEl = document.getElementById('pair-err');
    if(errEl) errEl.textContent = 'Could not read clipboard: ' + (e.message || e);
  }
}

async function onPairSubmit(){
  const errEl = document.getElementById('pair-err');
  const code = document.getElementById('pair-code').value.trim();
  if(!code){ errEl.textContent = 'Paste a pairing code first.'; return; }
  const payload = decodePairingCode(code);
  if(!payload){ errEl.textContent = 'Code is malformed (could not decode).'; return; }
  if(!await verifyPairing(payload)){ errEl.textContent = 'Code signature did not verify. Ask your admin to issue a fresh one.'; return; }
  if(payload.exp && new Date(payload.exp).getTime() < Date.now()){
    errEl.textContent = 'This code expired ' + payload.exp.slice(0,10) + '. Request a new one.';
    return;
  }
  await window.rsWidget.savePairing(code);
  await refresh();
}

function ringSvg(pct){
  const r = 50;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(1, pct)));
  const color = pct >= 1 ? 'var(--green)' : pct >= 0.5 ? 'var(--accent)' : 'var(--accent2)';
  return `<svg class="ring" viewBox="0 0 130 130">
    <circle cx="65" cy="65" r="${r}" fill="none" stroke="rgba(148,163,184,0.15)" stroke-width="10"></circle>
    <circle cx="65" cy="65" r="${r}" fill="none" stroke="${color}" stroke-width="10"
            stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"
            transform="rotate(-90 65 65)"></circle>
  </svg>`;
}

// Time-of-day "expected" pace: how many wRVU should be done by now
// assuming an 8a–6p workday. Returns 0 outside those hours.
function expectedPaceFraction(){
  const now = new Date();
  const h = now.getHours() + now.getMinutes() / 60;
  if(h < 8) return 0;
  if(h > 18) return 1;
  return (h - 8) / 10;
}

// Linear status bar — shows actual vs goal with a tick at the
// time-of-day expected pace position.
function statusBarHtml(actual, goal, pacsConnected){
  if(goal <= 0){
    return `<div class="statusbar-wrap">
      <div class="statusbar-rail"><div class="statusbar-fill onpace" style="width:0%"></div></div>
      <div class="statusbar-meta"><span class="label">No goal set today</span><span class="pct">—</span></div>
    </div>`;
  }
  const pct = actual / goal;
  const pctClamped = Math.max(0, Math.min(1.5, pct));
  const fillPct = Math.min(100, pctClamped * 100);
  const pace = expectedPaceFraction();
  let cls = 'behind', label = 'Behind pace';
  if(pct >= 1.0){ cls = (pct > 1.05) ? 'over' : 'met'; label = (pct > 1.05) ? `🎉 ${Math.round((pct - 1) * 100)}% over goal` : '✓ Goal reached'; }
  else if(pct >= 0.85){ cls = 'near'; label = 'Approaching goal'; }
  else if(pct >= pace * 0.85){ cls = 'onpace'; label = 'On pace'; }
  else { cls = 'behind'; label = 'Behind pace'; }
  // If PACS isn't wired up the actual is always 0; show a softer pill
  // so users know this is awaiting integration rather than alarming.
  const pacsHint = !pacsConnected
    ? `<div style="font-size:10px;color:var(--ink3);margin-top:6px;text-align:center"><span style="background:var(--bg3);padding:2px 7px;border-radius:8px">⚙ Waiting for PACS — counts will populate when connected</span></div>`
    : '';
  return `<div class="statusbar-wrap">
    <div class="statusbar-rail">
      <div class="statusbar-fill ${cls}" style="width:${fillPct}%"></div>
      ${pace > 0 && pace < 1 ? `<div class="statusbar-tick" style="left:${pace * 100}%" title="Expected pace by now"></div>` : ''}
    </div>
    <div class="statusbar-meta">
      <span class="label ${cls}">${label}</span>
      <span class="pct">${Math.round(pct * 100)}% · ${actual}/${goal}</span>
    </div>
    ${pacsHint}
  </div>`;
}

function renderTabs(){
  const tabs = document.getElementById('tabs');
  if(!tabs) return;
  tabs.style.display = 'flex';
  tabs.innerHTML = `
    <div class="tab ${_activeTab==='today'?'active':''}" data-tab="today">Today</div>
    <div class="tab ${_activeTab==='credits'?'active':''}" data-tab="credits">Credits</div>
    <div class="tab ${_activeTab==='debulking'?'active':''}" data-tab="debulking">Debulking</div>`;
  tabs.querySelectorAll('.tab').forEach(t => {
    t.onclick = () => {
      _activeTab = t.dataset.tab;
      renderTabs();
      renderActiveTab();
    };
  });
}

function renderActiveTab(){
  if(_activeTab === 'today') renderTodayTab();
  else if(_activeTab === 'credits') renderCreditsTab();
  else if(_activeTab === 'debulking') renderDebulkingTab();
}

// ─── Credits helpers ─────────────────────────────────────────────
// Filter the practice's credit log down to entries belonging to the
// current physician + within the requested time window.
function _myCredits(){
  const physId = _lastPayload?.physId;
  const all = (_lastPractice?.physicianCredits) || [];
  return all.filter(c => c.physId === physId);
}
function _creditsToday(){
  const today = fmtDate(new Date());
  return _myCredits().filter(c => (c.ts || '').slice(0, 10) === today);
}
function _hoursSum(arr){
  return arr.reduce((s, c) => s + (+c.hours || 0), 0);
}
function _fmtTs(iso){
  if(!iso) return '';
  try{
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }catch(_){ return String(iso).slice(0,16).replace('T',' '); }
}

// POST a write op to the widget-data edge function. Returns the parsed
// response on success, throws on error. Re-fetches practice data after
// the write so the UI always reflects server truth.
async function _creditsWrite(action, extra){
  if(!_lastPayload || !_lastPairingCode) throw new Error('not paired');
  const url = `${_lastPayload.sbUrl}/functions/v1/widget-data`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': _lastPayload.sbAnonKey,
      'Authorization': 'Bearer ' + _lastPayload.sbAnonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code: _lastPairingCode, action, ...extra }),
  });
  const txt = await resp.text();
  let parsed = null;
  try{ parsed = JSON.parse(txt); }catch(_){}
  if(!resp.ok){
    throw new Error((parsed && parsed.error) || ('HTTP ' + resp.status + ': ' + txt.slice(0, 200)));
  }
  // Re-fetch the practice so the local _lastPractice + counter stay current.
  try{
    _lastPractice = await fetchPracticeData(_lastPayload);
  }catch(e){
    console.warn('post-write refetch failed:', e);
  }
  return parsed;
}

// ─── Today tab ───────────────────────────────────────────────────
function renderTodayTab(){
  const body = document.querySelector('.body');
  if(!body || !_lastDigest) return;
  const digest = _lastDigest;
  const pacs = digest._pacs || { pacsConnected: false, studiesCompletedToday: 0, autoNextPct: 0 };
  const studyCount = pacs.studiesCompletedToday || 0;
  // Delivered wRVU = PACS-earned + credits (drive-time excluded).
  const creditWRVU = _creditWRVUToday();
  const deliveredWRVU = (pacs.wRVUEarnedToday || 0) + creditWRVU;
  const autoNext = +(pacs.autoNextPct || 0);
  const initials = (digest.physName.split(/\s+/).map(s => s[0]).join('').slice(0,2)) || 'RS';
  const todayStr = new Date().toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
  const goal = digest.wRVUGoalTotal;
  // Ring shows DELIVERED wRVU progress (studies + credit-derived), so
  // physicians see credits contributing immediately when they log them.
  const ringPct = goal > 0 ? deliveredWRVU / goal : 0;
  let statusLabel = 'Off';
  let statusColor = 'var(--ink2)';
  if(digest.onVacation){ statusLabel = 'Vacation'; statusColor = 'var(--amber)'; }
  else if(digest.onCall){ statusLabel = 'On call'; statusColor = 'var(--accent)'; }
  else if(digest.shifts.length){ statusLabel = digest.shifts[0].kind; statusColor = 'var(--green)'; }
  const shiftsHtml = digest.shifts.length
    ? digest.shifts.map(s => `<div class="row">
        <div class="left">${escHtml(s.label)}</div>
        <div class="right">${s.goal > 0 ? s.goal + ' wRVU' : '—'}</div>
      </div>`).join('')
    : '<div class="empty">No shifts scheduled today.</div>';
  // Live credits counter for today — auto-bumps with a flash animation
  // when the value changes between renders.
  const todayCredits = _creditsToday();
  const todayHours = _hoursSum(todayCredits);
  const bumped = (_lastCreditsToday !== null && _lastCreditsToday !== todayHours) ? 'bumped' : '';
  _lastCreditsToday = todayHours;
  body.innerHTML = `
    <div class="top">
      <div class="avatar">${escHtml(initials)}</div>
      <div style="flex:1;min-width:0">
        <div class="name" title="${escHtml(digest.physName)}">${escHtml(digest.physName || 'Unknown')}</div>
        <div class="date">${escHtml(todayStr)} · <span style="color:${statusColor}">${escHtml(statusLabel)}</span></div>
      </div>
    </div>

    <div class="auto-counter">
      <div class="label"><span class="live"></span>Credits today</div>
      <div class="val ${bumped}">${todayHours.toFixed(1)}<span class="unit">hrs · ${todayCredits.length} entr${todayCredits.length===1?'y':'ies'}</span></div>
    </div>

    <div class="ring-wrap">
      ${ringSvg(ringPct)}
      <div class="ring-label-wrap">
        <div class="ring-num">${deliveredWRVU.toFixed(1)}<span style="color:var(--ink3);font-size:14px;font-weight:400"> / ${goal || '—'}</span></div>
        <div class="ring-sub">delivered / wRVU goal</div>
        ${creditWRVU > 0 ? `<div style="font-size:9.5px;color:var(--ink2);margin-top:2px">${pacs.wRVUEarnedToday || 0} studies + ${creditWRVU.toFixed(1)} credits</div>` : ''}
      </div>
    </div>

    ${statusBarHtml(deliveredWRVU, goal, pacs.pacsConnected)}

    <div class="stat-row">
      <div class="stat">
        <div class="stat-lbl">Auto-next</div>
        <div class="stat-val" style="color:${autoNext >= 90 ? 'var(--green)' : autoNext >= 70 ? 'var(--amber)' : 'var(--ink2)'}">${autoNext.toFixed(1)}<span style="font-size:11px;font-weight:400;color:var(--ink3)">%</span></div>
      </div>
      <div class="stat">
        <div class="stat-lbl">wRVU goal</div>
        <div class="stat-val">${goal || 0}</div>
      </div>
      <div class="stat">
        <div class="stat-lbl">Drive credit</div>
        <div class="stat-val">${digest.driveTimeCredit || 0}<span style="font-size:10px;color:var(--ink3);margin-left:2px">(separate)</span></div>
      </div>
    </div>

    <div class="stat" style="margin-bottom:8px">
      <div class="stat-lbl">Today's shifts</div>
      <div class="shifts">${shiftsHtml}</div>
    </div>

    <div class="footer">
      <span>Last refreshed <span id="refresh-time">${new Date().toLocaleTimeString()}</span></span>
      <span></span>
    </div>`;
}

// ─── Credits tab ─────────────────────────────────────────────────
// Time-based credit log with a free-text reason. Read/write via the
// widget-data edge function; service role does the actual table write.
function renderCreditsTab(){
  const body = document.querySelector('.body');
  if(!body) return;
  const mine = _myCredits().slice().sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const todayHours  = _hoursSum(_creditsToday());
  // 7-day total
  const weekStart = (() => { const d = new Date(); d.setDate(d.getDate() - 6); return fmtDate(d); })();
  const weekHours = _hoursSum(mine.filter(c => (c.ts || '').slice(0,10) >= weekStart));
  // 30-day total
  const monthStart = (() => { const d = new Date(); d.setDate(d.getDate() - 29); return fmtDate(d); })();
  const monthHours = _hoursSum(mine.filter(c => (c.ts || '').slice(0,10) >= monthStart));
  // Targets from practice config (admin-set)
  const targets = (_lastPractice?.cfg?.creditTargets) || {};
  const wTarget = +targets.weekly || 0;
  const mTarget = +targets.monthly || 0;
  const wPct = wTarget > 0 ? Math.min(100, (weekHours / wTarget) * 100) : 0;
  const mPct = mTarget > 0 ? Math.min(100, (monthHours / mTarget) * 100) : 0;
  const targetColor = (pct) => pct >= 100 ? 'var(--green)' : pct >= 70 ? 'var(--accent)' : pct >= 40 ? 'var(--amber)' : 'var(--red)';
  const progressBar = (pct, target) => target > 0 ? `<div style="height:4px;background:rgba(148,163,184,0.15);border-radius:2px;margin-top:6px;overflow:hidden"><div style="height:100%;background:${targetColor(pct)};width:${pct}%;transition:width 0.4s"></div></div>` : '';
  // Default the new-credit datetime field to "now" rounded down to the
  // current minute (HTML datetime-local format).
  const nowLocal = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const dy = String(d.getDate()).padStart(2,'0');
    const h = String(d.getHours()).padStart(2,'0');
    const mi = String(d.getMinutes()).padStart(2,'0');
    return `${y}-${m}-${dy}T${h}:${mi}`;
  })();
  body.innerHTML = `
    <div class="credits-summary">
      <div class="stat">
        <div class="n">${weekHours.toFixed(1)}<span style="font-size:11px;color:var(--ink2);margin-left:4px">hrs${wTarget > 0 ? ' / ' + wTarget : ''}</span></div>
        <div class="lbl">Week ${wTarget > 0 ? '(' + Math.round(wPct) + '%)' : ''}</div>
        ${progressBar(wPct, wTarget)}
      </div>
      <div class="stat">
        <div class="n">${monthHours.toFixed(1)}<span style="font-size:11px;color:var(--ink2);margin-left:4px">hrs${mTarget > 0 ? ' / ' + mTarget : ''}</span></div>
        <div class="lbl">Month ${mTarget > 0 ? '(' + Math.round(mPct) + '%)' : ''}</div>
        ${progressBar(mPct, mTarget)}
      </div>
    </div>
    <div style="font-size:10.5px;color:var(--ink3);margin-bottom:10px;text-align:center">
      Today: <strong style="color:var(--ink)">${todayHours.toFixed(1)} hrs</strong>${(wTarget === 0 && mTarget === 0) ? ' · admin can set targets in Settings → Credit targets' : ''}
    </div>

    <div class="credit-form">
      <div class="row">
        <div>
          <label for="cf-ts">When</label>
          <input id="cf-ts" type="datetime-local" value="${nowLocal}">
        </div>
        <div>
          <label for="cf-hours">Hours</label>
          <input id="cf-hours" type="number" min="0.1" max="24" step="0.25" value="1.0">
        </div>
      </div>
      <label for="cf-reason">Reason</label>
      <textarea id="cf-reason" rows="2" placeholder="e.g. Covering for Dr. Smith, journal club, MQSA review"></textarea>
      <button id="cf-add">+ Add credit</button>
      <div class="err" id="cf-err"></div>
    </div>

    <div style="font-size:10px;font-weight:600;color:var(--ink3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">
      All credits (${mine.length})
    </div>
    <div class="credit-list" id="credit-list">
      ${mine.length ? mine.map(_renderCreditItem).join('') : '<div class="empty" style="padding:8px;text-align:center">No credits logged yet.</div>'}
    </div>

    <div class="footer">
      <span>Credits are private to you. Edit/delete anytime.</span>
    </div>`;

  document.getElementById('cf-add').onclick = _onAddCredit;
  // Hook in edit + delete buttons on each list item.
  body.querySelectorAll('[data-credit-edit]').forEach(b => {
    b.onclick = () => { _creditEditingId = +b.dataset.creditEdit; renderCreditsTab(); };
  });
  body.querySelectorAll('[data-credit-cancel]').forEach(b => {
    b.onclick = () => { _creditEditingId = null; renderCreditsTab(); };
  });
  body.querySelectorAll('[data-credit-save]').forEach(b => {
    b.onclick = () => _onSaveCreditEdit(+b.dataset.creditSave);
  });
  body.querySelectorAll('[data-credit-del]').forEach(b => {
    b.onclick = () => _onDeleteCredit(+b.dataset.creditDel);
  });
}

function _renderCreditItem(c){
  const isEditing = _creditEditingId === c.id;
  if(isEditing){
    // Convert ISO timestamp to datetime-local string for the input.
    const tsLocal = (() => {
      try{
        const d = new Date(c.ts);
        return d.toISOString().slice(0, 16);
      }catch(_){ return ''; }
    })();
    return `<div class="credit-item editing">
      <div class="row1">
        <input type="datetime-local" id="ce-ts-${c.id}" value="${escHtml(tsLocal)}" style="flex:1;font-size:11px">
        <input type="number" id="ce-hr-${c.id}" min="0.1" max="24" step="0.25" value="${c.hours}" style="width:70px;font-size:11px">
      </div>
      <textarea id="ce-rs-${c.id}" rows="2">${escHtml(c.reason || '')}</textarea>
      <div class="actions" style="justify-content:flex-end">
        <button data-credit-save="${c.id}">Save</button>
        <button data-credit-cancel="${c.id}">Cancel</button>
      </div>
    </div>`;
  }
  return `<div class="credit-item">
    <div class="row1">
      <span class="when">${escHtml(_fmtTs(c.ts))}</span>
      <span class="hrs">${(+c.hours).toFixed(1)}h</span>
    </div>
    <div class="reason">${escHtml(c.reason || '')}</div>
    <div class="actions" style="justify-content:flex-end">
      <button data-credit-edit="${c.id}">Edit</button>
      <button class="del" data-credit-del="${c.id}">Delete</button>
    </div>
  </div>`;
}

async function _onAddCredit(){
  const tsEl  = document.getElementById('cf-ts');
  const hrEl  = document.getElementById('cf-hours');
  const rsEl  = document.getElementById('cf-reason');
  const errEl = document.getElementById('cf-err');
  const btn   = document.getElementById('cf-add');
  errEl.textContent = '';
  const hours = +hrEl.value;
  const reason = (rsEl.value || '').trim();
  if(!hours || hours <= 0 || hours > 24){ errEl.textContent = 'Hours must be between 0 and 24.'; return; }
  if(!reason){ errEl.textContent = 'Reason is required.'; return; }
  // datetime-local input → ISO. Treat as local time.
  let ts = tsEl.value;
  if(ts){ ts = new Date(ts).toISOString(); }
  else { ts = new Date().toISOString(); }
  btn.disabled = true; btn.textContent = 'Saving…';
  try{
    await _creditsWrite('add-credit', { credit: { ts, hours, reason } });
    rsEl.value = '';                    // clear the reason for next entry
    renderCreditsTab();                 // re-render with fresh data
  }catch(e){
    errEl.textContent = e.message || String(e);
    btn.disabled = false;
    btn.textContent = '+ Add credit';
  }
}

async function _onSaveCreditEdit(creditId){
  const tsEl = document.getElementById('ce-ts-' + creditId);
  const hrEl = document.getElementById('ce-hr-' + creditId);
  const rsEl = document.getElementById('ce-rs-' + creditId);
  const hours = +hrEl.value;
  const reason = (rsEl.value || '').trim();
  if(!hours || hours <= 0 || hours > 24){ alert('Hours must be between 0 and 24.'); return; }
  if(!reason){ alert('Reason cannot be empty.'); return; }
  let ts = tsEl.value;
  if(ts){ ts = new Date(ts).toISOString(); }
  try{
    await _creditsWrite('edit-credit', { creditId, patch: { ts, hours, reason } });
    _creditEditingId = null;
    renderCreditsTab();
  }catch(e){
    alert('Edit failed: ' + (e.message || String(e)));
  }
}

async function _onDeleteCredit(creditId){
  if(!confirm('Delete this credit entry?')) return;
  try{
    await _creditsWrite('delete-credit', { creditId });
    renderCreditsTab();
  }catch(e){
    alert('Delete failed: ' + (e.message || String(e)));
  }
}

// ─── Debulking tab ───────────────────────────────────────────────
function renderDebulkingTab(){
  const body = document.querySelector('.body');
  if(!body || !_lastDigest) return;
  const digest = _lastDigest;
  const pacs = digest._pacs || { pacsConnected: false, debulkingToday: 0, debulkingThisWeek: 0, debulkingThisMonth: 0 };
  // Combined checks: base (admin/vacation/shift/dow) + PACS gates
  // (wRVU ≥107.5% goal, autoNext ≥90%). Eligibility is the AND of all.
  const checks = _debulkingChecks();
  const eligible = checks.length > 0 && checks.every(c => c.pass);
  body.innerHTML = `
    <div class="debulk-elig ${eligible ? 'yes' : 'no'}">
      ${eligible ? '✓ Eligible to debulk today' : '✗ Not eligible today'}
    </div>

    <div class="debulk-section-title">Debulking counts</div>
    <div class="debulk-counters">
      <div class="debulk-counter">
        <div class="n">${pacs.debulkingToday || 0}</div>
        <div class="lbl">Today</div>
      </div>
      <div class="debulk-counter">
        <div class="n">${pacs.debulkingThisWeek || 0}</div>
        <div class="lbl">Week</div>
      </div>
      <div class="debulk-counter">
        <div class="n">${pacs.debulkingThisMonth || 0}</div>
        <div class="lbl">Month</div>
      </div>
    </div>

    <div class="debulk-section-title">Eligibility checklist</div>
    <div class="debulk-criteria">
      ${checks.map(c => `<div class="row ${c.pass ? 'pass' : 'fail'}">
        <span class="check">${c.pass ? '✓' : '✗'}</span>
        <span>${escHtml(c.name)} — <span style="color:var(--ink3)">${escHtml(c.detail)}</span></span>
      </div>`).join('')}
    </div>

    <div class="debulk-notice">
      <span class="tag">PACS</span>
      Counts are <strong>0</strong> until the PACS plugin is wired up. The eligibility check above is computed from RadScheduler data and works today.
      <div style="font-size:10px;color:var(--ink3);margin-top:4px">See widget/README.md → "PACS integration" for the broker spec.</div>
    </div>

    <div class="footer">
      <span>Last refreshed <span id="refresh-time">${new Date().toLocaleTimeString()}</span></span>
      <span></span>
    </div>`;
}

function renderError(msg, allowRepair){
  document.querySelector('.body').innerHTML = `
    <div class="pair">
      <h2>⚠ Could not load</h2>
      <p style="color:var(--ink2)">${escHtml(msg)}</p>
      ${allowRepair ? `<button id="re-pair">Re-pair widget</button>` : ''}
    </div>`;
  const tabs = document.getElementById('tabs');
  if(tabs) tabs.style.display = 'none';
  if(allowRepair){
    document.getElementById('re-pair').onclick = async () => {
      await window.rsWidget.clearPairing();
      renderPairing();
    };
  }
}

// ─── Refresh loop ────────────────────────────────────────────────
let _refreshTimer = null;

async function refresh(){
  try{
    const code = await window.rsWidget.getPairing();
    if(!code){ renderPairing(); return; }
    const payload = decodePairingCode(code);
    if(!payload){ renderError('Stored pairing code is corrupt. Re-pair to fix.', true); return; }
    if(!await verifyPairing(payload)){ renderError('Signature mismatch — pairing was tampered with or revoked.', true); return; }
    if(payload.exp && new Date(payload.exp).getTime() < Date.now()){
      renderError('Pairing expired ' + payload.exp.slice(0,10) + '. Ask your admin for a new code.', true);
      return;
    }
    _lastPairingCode = code;
    const practice = await fetchPracticeData(payload);
    const today = fmtDate(new Date());
    const digest = computeDayDigest(practice, payload.physId, today);
    // Fan-out: PACS stats run in parallel. When the broker isn't wired
    // it returns zeros + pacsConnected:false. Both UIs handle this state.
    let pacsStats;
    try{ pacsStats = await fetchPACSStats(payload.physId, today); }
    catch(_){ pacsStats = { pacsConnected:false, studiesCompletedToday:0, debulkingToday:0, debulkingThisWeek:0, debulkingThisMonth:0 }; }
    digest._pacs = pacsStats;
    digest.studyCount = pacsStats.studiesCompletedToday || 0;
    _lastPayload = payload;
    _lastPractice = practice;
    _lastDigest = digest;
    // Per-physician accent tint — applies once per refresh based on
    // the paired physician's chosen color in RadScheduler.
    try{
      const phys = (practice.physicians || []).find(p => p.id === payload.physId);
      _applyPhysicianAccent(phys?.color || null);
    }catch(_){}
    renderTabs();
    renderActiveTab();
  } catch(e){
    console.error('refresh failed', e);
    renderError(e.message || String(e), true);
  }
}

// Header buttons.
//
// History note: an earlier version used window.prompt() for the
// Settings menu. Modern Electron (22+) disables/ignores window.prompt
// in renderers under the security-default webPreferences (sandbox +
// contextIsolation), so the Settings button was silently no-op'ing.
// Refresh worked but had no visible feedback, so it also looked
// broken. Pin worked but only changed opacity slightly.
//
// Current version: in-app dropdown menu for Settings, transient
// "↻ refreshing…" feedback for Refresh, clearer pinned/unpinned
// state on Pin.
function bindHeader(){
  const btnR = document.getElementById('btn-refresh');
  const btnP = document.getElementById('btn-pin');
  const btnS = document.getElementById('btn-settings');
  if(!btnR || !btnP || !btnS){
    console.warn('[widget] header buttons not in DOM at bindHeader()');
    return;
  }

  // Refresh — visible state so the user knows the click registered.
  btnR.onclick = async () => {
    if(btnR.dataset.busy === '1') return;
    btnR.dataset.busy = '1';
    const orig = btnR.textContent;
    btnR.textContent = '⌛';
    btnR.style.opacity = '0.7';
    try{ await refresh(); }
    catch(e){ console.warn('[widget] refresh failed:', e); }
    btnR.textContent = orig;
    btnR.style.opacity = '';
    btnR.dataset.busy = '';
  };

  // Pin — toggle always-on-top. Visual state via emoji + opacity.
  btnP.style.opacity = _alwaysOnTop ? '1' : '0.45';
  btnP.onclick = async () => {
    _alwaysOnTop = !_alwaysOnTop;
    try{
      if(window.rsWidget.setAlwaysOnTop) await window.rsWidget.setAlwaysOnTop(_alwaysOnTop);
    }catch(e){ console.warn('[widget] setAlwaysOnTop failed:', e); }
    btnP.style.opacity = _alwaysOnTop ? '1' : '0.45';
    btnP.title = _alwaysOnTop ? 'Pinned (always on top) — click to unpin' : 'Not pinned — click to pin';
  };

  // Settings — in-app dropdown menu. Replaces window.prompt() which
  // doesn't work reliably in modern Electron renderers.
  btnS.onclick = (e) => {
    e.stopPropagation();
    _toggleSettingsMenu(btnS);
  };

  if(window.rsWidget.onResetPairing) window.rsWidget.onResetPairing(() => renderPairing());
}

// Floating Settings menu. Appears below the Settings button. Click
// outside (or pick an item) to dismiss.
function _toggleSettingsMenu(anchor){
  const existing = document.getElementById('rs-settings-menu');
  if(existing){ existing.remove(); return; }
  const menu = document.createElement('div');
  menu.id = 'rs-settings-menu';
  // Styled inline so we don't have to ship a CSS update to install
  // this fix (older widget binaries can adopt the patch by replacing
  // just renderer.js).
  Object.assign(menu.style, {
    position: 'fixed',
    background: 'var(--bg2)',
    border: '1px solid var(--line)',
    borderRadius: '6px',
    padding: '4px',
    boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
    zIndex: '9999',
    minWidth: '180px',
    fontSize: '12px',
    color: 'var(--ink)',
    WebkitAppRegion: 'no-drag',  // belt-and-suspenders for older Electron
  });
  // Position relative to the anchor button.
  const r = anchor.getBoundingClientRect();
  menu.style.top  = (r.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - r.right) + 'px';

  const items = [
    { label: '↻ Refresh now',      run: () => refresh() },
    { label: '🔄 Check for updates', run: () => window.rsWidget.checkUpdates?.() },
    { label: '🌐 Open RadScheduler', run: () => window.rsWidget.openExternal?.('https://radsched.org') },
    { sep: true },
    { label: '🔑 Re-pair widget…',  run: async () => {
      if(!confirm('Clear this widget\'s pairing? You\'ll need a new code from your admin to re-pair.')) return;
      await window.rsWidget.clearPairing?.();
      renderPairing();
    }, danger: true },
    { sep: true },
    { label: '📋 Pairing status (copy)', run: async () => {
      // Surface storage info so users can self-diagnose pair issues.
      try{
        const v = await window.rsWidget.getVersion?.();
        const code = await window.rsWidget.getPairing?.();
        const status = code ? 'Paired (' + code.length + ' chars)' : 'Not paired';
        const msg = 'Widget v' + (v || '?') + ' · ' + status;
        try{ await navigator.clipboard.writeText(msg); }catch(_){}
        alert(msg);
      }catch(e){ alert('Could not read pairing: ' + (e?.message || e)); }
    } },
  ];
  for(const it of items){
    if(it.sep){
      const s = document.createElement('div');
      Object.assign(s.style, { height:'1px', background:'var(--line)', margin:'4px 2px' });
      menu.appendChild(s);
      continue;
    }
    const a = document.createElement('div');
    a.textContent = it.label;
    Object.assign(a.style, {
      padding:'7px 10px', cursor:'pointer', borderRadius:'4px',
      color: it.danger ? 'var(--red, #ef4444)' : 'var(--ink)',
    });
    a.onmouseenter = () => { a.style.background = 'var(--bg3)'; };
    a.onmouseleave = () => { a.style.background = ''; };
    a.onclick = () => { menu.remove(); try{ it.run(); }catch(e){ console.warn(e); } };
    menu.appendChild(a);
  }
  document.body.appendChild(menu);
  // Dismiss on outside click. Bind on next tick so the current click
  // (which opened the menu) doesn't immediately close it.
  setTimeout(() => {
    const off = (ev) => {
      if(!menu.contains(ev.target)){
        menu.remove();
        document.removeEventListener('mousedown', off, true);
      }
    };
    document.addEventListener('mousedown', off, true);
  }, 0);
}

// ─── Zero-click auto-update ─────────────────────────────────────
// Subscribed to three main-process events:
//   • rs:update-available           — a newer release exists
//   • rs:update-info                — interactive feedback
//   • rs:update-download-progress   — % progress while downloading
//
// As of v1.1.4: updates are FULLY automatic. The moment main detects
// a new release, we:
//   1. Show an unobtrusive banner ("📥 Updating to vX…")
//   2. Download silently in the background (with progress)
//   3. Quit + detached helper script swaps the .app / runs NSIS /S
//   4. Re-launch into the new version
//
// User sees the widget close + reopen with the new version, ~5-15s
// after the new release is detected. No clicks, no installer prompts.
//
// Failure handling: if the silent path fails twice in a row (write
// permission issue, disk full, network), we fall back to the
// previous "Update now" button so the user has an explicit path.
let _lastUpdatePayload = null;
let _silentUpdateStarted = false;
const _SILENT_FAIL_KEY = 'rs-widget-silent-fail-count';
function _silentFailCount(){
  try{ return +(localStorage.getItem(_SILENT_FAIL_KEY) || 0); }catch(_){ return 0; }
}
function _bumpSilentFail(){
  try{ localStorage.setItem(_SILENT_FAIL_KEY, String(_silentFailCount() + 1)); }catch(_){}
}
function _resetSilentFail(){
  try{ localStorage.removeItem(_SILENT_FAIL_KEY); }catch(_){}
}

function showUpdateBanner(payload){
  if(!payload || !payload.latestVersion || !payload.downloadUrl) return;
  // Avoid re-rendering the same banner twice on rapid re-checks.
  if(_lastUpdatePayload && _lastUpdatePayload.latestVersion === payload.latestVersion) return;
  _lastUpdatePayload = payload;
  // After 2 consecutive silent-install failures, fall back to the
  // manual download-and-open-installer banner.
  if(_silentFailCount() >= 2){
    _renderManualBanner(payload);
    return;
  }
  _renderSilentBanner(payload);
  // Kick off the silent update immediately. No user click required.
  _startSilentUpdate(payload);
}

function _renderSilentBanner(payload){
  const el = document.getElementById('update-banner');
  if(!el) return;
  el.innerHTML = `
    <div class="text">
      📥 Updating to <strong>v${escHtml(payload.latestVersion)}</strong>…
      <span style="color:var(--ink3)">(from v${escHtml(payload.currentVersion)})</span>
      <div id="upd-progress" style="margin-top:4px;font-size:11px;color:var(--ink3)">
        Downloading… <span id="upd-pct">0%</span>
        <div style="height:3px;background:rgba(255,255,255,0.15);border-radius:2px;margin-top:3px;overflow:hidden">
          <div id="upd-bar" style="width:0%;height:100%;background:#3b82f6;transition:width .15s"></div>
        </div>
      </div>
    </div>
    <div class="actions">
      <button class="btn ghost" id="upd-notes" title="View release notes">Notes</button>
    </div>`;
  el.style.display = 'flex';
  document.getElementById('upd-notes').onclick = () => {
    window.rsWidget.openExternal(payload.releaseUrl || payload.downloadUrl);
  };
}

function _renderManualBanner(payload){
  // Fallback after silent path failed — give the user a button so
  // they can take over manually.
  const el = document.getElementById('update-banner');
  if(!el) return;
  const sizeStr = payload.assetSizeMB ? ` (${payload.assetSizeMB} MB)` : '';
  el.innerHTML = `
    <div class="text">
      🚀 Update available: <strong>v${escHtml(payload.latestVersion)}</strong>
      <span style="color:var(--ink3)">(silent install failed — please update manually)</span>
    </div>
    <div class="actions">
      <button class="btn" id="upd-download" title="${escHtml(payload.assetName || '')}">⬇ Update now${escHtml(sizeStr)}</button>
      <button class="btn ghost" id="upd-notes" title="View release notes">Notes</button>
    </div>`;
  el.style.display = 'flex';
  document.getElementById('upd-download').onclick = async () => {
    const btn = document.getElementById('upd-download');
    if(btn){ btn.disabled = true; btn.textContent = '⏳ Downloading…'; }
    const res = await window.rsWidget.downloadAndInstall({
      url: payload.downloadUrl, name: payload.assetName,
    });
    if(res?.ok){
      if(btn) btn.textContent = '✓ Installer opened';
      _resetSilentFail();
    } else if(btn){
      btn.disabled = false;
      btn.textContent = '⚠ Failed — open in browser';
      btn.onclick = () => window.rsWidget.openExternal(payload.downloadUrl);
    }
  };
  document.getElementById('upd-notes').onclick = () => {
    window.rsWidget.openExternal(payload.releaseUrl || payload.downloadUrl);
  };
}

async function _startSilentUpdate(payload){
  if(_silentUpdateStarted) return;
  if(!window.rsWidget.silentUpdate) return;  // older preload — skip
  _silentUpdateStarted = true;
  try{
    const res = await window.rsWidget.silentUpdate({
      url: payload.downloadUrl, name: payload.assetName,
    });
    if(res?.ok){
      _resetSilentFail();
      // Banner shows "Restarting…" briefly before main fires app.quit().
      const el = document.getElementById('update-banner');
      if(el){
        el.innerHTML = `<div class="text">✓ Update downloaded — restarting now…</div><div class="actions"></div>`;
      }
    } else {
      _bumpSilentFail();
      console.warn('[update] silent install failed:', res?.error);
      _silentUpdateStarted = false;
      // Fall back to manual banner so the user can still take action.
      _renderManualBanner(payload);
    }
  }catch(e){
    _bumpSilentFail();
    console.warn('[update] silent install threw:', e);
    _silentUpdateStarted = false;
    _renderManualBanner(payload);
  }
}

function showUpdateProgress(p){
  if(!p) return;
  const pct = document.getElementById('upd-pct');
  const bar = document.getElementById('upd-bar');
  if(pct) pct.textContent = (p.pct || 0) + '%';
  if(bar) bar.style.width = (p.pct || 0) + '%';
}

function showUpdateInfo(info){
  if(!info) return;
  const el = document.getElementById('update-banner');
  if(!el) return;
  // Interactive responses (from the Settings menu "update" action).
  // These auto-dismiss after a few seconds.
  let msg = '';
  if(info.kind === 'uptodate') msg = `✓ You're on the latest version (v${escHtml(info.currentVersion)}).`;
  else if(info.kind === 'no-release') msg = `ⓘ No published release yet. Ask your admin to run publish-release.sh.`;
  else if(info.kind === 'no-asset') msg = `⚠ Latest release v${escHtml(info.latestVersion)} doesn't include a build for this OS.`;
  else if(info.kind === 'error') msg = `⚠ Update check failed: ${escHtml(info.detail || '')}`;
  if(!msg) return;
  el.innerHTML = `<div class="text">${msg}</div><div class="actions"><button class="btn ghost" id="upd-close">✕</button></div>`;
  el.style.display = 'flex';
  document.getElementById('upd-close').onclick = () => { el.style.display = 'none'; };
  setTimeout(() => { el.style.display = 'none'; }, 6000);
}

if(window.rsWidget.onUpdateAvailable) window.rsWidget.onUpdateAvailable(showUpdateBanner);
if(window.rsWidget.onUpdateInfo) window.rsWidget.onUpdateInfo(showUpdateInfo);
if(window.rsWidget.onUpdateProgress) window.rsWidget.onUpdateProgress(showUpdateProgress);

// Boot
bindHeader();
refresh();
_refreshTimer = setInterval(refresh, 5 * 60 * 1000);
