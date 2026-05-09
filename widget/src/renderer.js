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
let _activeTab = 'today';          // 'today' | 'debulking'
let _lastPayload = null;
let _lastPractice = null;
let _lastDigest = null;
let _alwaysOnTop = true;

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

// ─── Supabase fetch ──────────────────────────────────────────────
// The RadScheduler practice state lives in `public.radscheduler`
// (one row per practice, JSONB column `data`). The table name is
// historic — kept stable for back-compat. RLS policies gate which
// row each anon-key holder can read, so this query is safe to fire
// straight from a public client.
async function fetchPracticeData(p){
  const url = `${p.sbUrl}/rest/v1/radscheduler?id=eq.${encodeURIComponent(p.practiceId)}&select=data`;
  const resp = await fetch(url, {
    headers: {
      'apikey': p.sbAnonKey,
      'Authorization': 'Bearer ' + p.sbAnonKey,
      'Accept': 'application/json',
    },
  });
  if(!resp.ok) throw new Error('Supabase ' + resp.status + ': ' + await resp.text().catch(() => ''));
  const rows = await resp.json();
  if(!rows.length) throw new Error('No practice row found (id=' + p.practiceId + ' on table radscheduler).');
  return rows[0].data || {};
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

  (practice.drShifts || []).forEach(s => {
    if(s.physId === physId && s.date === dateISO){
      const goal = goalFor(s, 'dr');
      out.wRVUGoalTotal += goal;
      const dt = driveCredit(s.site);
      out.driveTimeCredit += dt;
      out.shifts.push({ kind: 'DR', label: `${s.shift} · ${s.site || '—'}${s.sub ? ' · ' + s.sub : ''}`, goal, site: s.site });
    }
  });
  (practice.irShifts || []).forEach(s => {
    if(s.physId === physId && s.date === dateISO){
      const goal = goalFor(s, 'ir');
      out.wRVUGoalTotal += goal;
      const dt = driveCredit(s.site);
      out.driveTimeCredit += dt;
      out.shifts.push({ kind: 'IR', label: `IR ${s.shift} · ${s.site || '—'}`, goal, site: s.site });
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

  // ── Debulking eligibility computed client-side ──────────────────
  // A physician is eligible to "debulk" (clear backlog studies) if:
  //   • Admin flagged them eligible (p.debulkingEligible !== false)
  //   • Not on vacation
  //   • Not on call (call duties take priority)
  //   • Has a regular DR/IR shift today (so they're "at work")
  //   • Practice's debulking policy allows for today's day-of-week
  // Each criterion is reported individually so the widget can show a
  // checklist explaining the eligibility decision.
  const policy = (practice.cfg && practice.cfg.debulkingPolicy) || {};
  const adminAllowed = !phys || phys.debulkingEligible !== false;
  const hasShiftToday = out.shifts.length > 0;
  const dow = new Date(dateISO + 'T12:00:00').getDay();
  const dowAllowed = policy.disabledDows ? !policy.disabledDows.includes(dow) : true;
  const checks = [
    { name: 'Admin-flagged eligible', pass: adminAllowed, detail: adminAllowed ? 'Yes' : 'No (admin disabled)' },
    { name: 'Not on vacation', pass: !out.onVacation, detail: out.onVacation ? 'On vacation today' : 'Available' },
    { name: 'Not exclusively on call', pass: !(out.onCall && out.shifts.length === 1), detail: out.onCall ? 'On call (lower priority for debulking)' : 'Not on call' },
    { name: 'Working today', pass: hasShiftToday, detail: hasShiftToday ? `${out.shifts.length} shift${out.shifts.length===1?'':'s'} today` : 'No shift today' },
    { name: 'Day-of-week allowed', pass: dowAllowed, detail: dowAllowed ? 'OK' : 'Practice excludes this DOW' },
  ];
  out.debulkingChecks = checks;
  out.debulkingEligibleByPolicy = checks.every(c => c.pass);

  return out;
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
  else if(_activeTab === 'debulking') renderDebulkingTab();
}

// ─── Today tab ───────────────────────────────────────────────────
function renderTodayTab(){
  const body = document.querySelector('.body');
  if(!body || !_lastDigest) return;
  const digest = _lastDigest;
  const pacs = digest._pacs || { pacsConnected: false, studiesCompletedToday: 0 };
  const studyCount = pacs.studiesCompletedToday || 0;
  const initials = (digest.physName.split(/\s+/).map(s => s[0]).join('').slice(0,2)) || 'RS';
  const todayStr = new Date().toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
  const goal = digest.wRVUGoalTotal;
  const ringPct = goal > 0 ? studyCount / goal : 0;
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
  body.innerHTML = `
    <div class="top">
      <div class="avatar">${escHtml(initials)}</div>
      <div style="flex:1;min-width:0">
        <div class="name" title="${escHtml(digest.physName)}">${escHtml(digest.physName || 'Unknown')}</div>
        <div class="date">${escHtml(todayStr)} · <span style="color:${statusColor}">${escHtml(statusLabel)}</span></div>
      </div>
    </div>

    <div class="ring-wrap">
      ${ringSvg(ringPct)}
      <div class="ring-label-wrap">
        <div class="ring-num">${studyCount}<span style="color:var(--ink3);font-size:14px;font-weight:400"> / ${goal || '—'}</span></div>
        <div class="ring-sub">studies / wRVU goal</div>
      </div>
    </div>

    ${statusBarHtml(studyCount, goal, pacs.pacsConnected)}

    <div class="stat-row">
      <div class="stat">
        <div class="stat-lbl">wRVU goal</div>
        <div class="stat-val">${goal || 0}</div>
      </div>
      <div class="stat">
        <div class="stat-lbl">Drive credit</div>
        <div class="stat-val">${digest.driveTimeCredit || 0}</div>
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

// ─── Debulking tab ───────────────────────────────────────────────
function renderDebulkingTab(){
  const body = document.querySelector('.body');
  if(!body || !_lastDigest) return;
  const digest = _lastDigest;
  const pacs = digest._pacs || { pacsConnected: false, debulkingToday: 0, debulkingThisWeek: 0, debulkingThisMonth: 0 };
  const eligible = !!digest.debulkingEligibleByPolicy;
  const checks = digest.debulkingChecks || [];
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
    renderTabs();
    renderActiveTab();
  } catch(e){
    console.error('refresh failed', e);
    renderError(e.message || String(e), true);
  }
}

// Header buttons
function bindHeader(){
  document.getElementById('btn-refresh').onclick = () => refresh();
  document.getElementById('btn-settings').onclick = async () => {
    const choice = prompt('Type "repair" to re-pair, "url" to open RadScheduler in your browser, or close to cancel.');
    if(choice === 'repair'){ await window.rsWidget.clearPairing(); renderPairing(); }
    else if(choice === 'url'){ await window.rsWidget.openExternal('https://radsched.org'); }
  };
  document.getElementById('btn-pin').onclick = async () => {
    _alwaysOnTop = !_alwaysOnTop;
    await window.rsWidget.setAlwaysOnTop(_alwaysOnTop);
    document.getElementById('btn-pin').style.opacity = _alwaysOnTop ? '1' : '0.4';
  };
  if(window.rsWidget.onResetPairing) window.rsWidget.onResetPairing(() => renderPairing());
}

// Boot
bindHeader();
refresh();
_refreshTimer = setInterval(refresh, 5 * 60 * 1000);
