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
 * (PACS integration in a future build will hook into a /pacs endpoint
 * to enrich studyCount + rvuEarned in real time.)
 */

const root = document.getElementById('root');

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
  try{
    const json = fromB64Url(code.trim());
    return JSON.parse(json);
  } catch(_){
    return null;
  }
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
// Query the practice's shared-state row by id. The schema is one big
// JSONB column named `data` so we read it whole. The anon key is
// public-by-design; RLS gates which row you can read.
async function fetchPracticeData(p){
  const url = `${p.sbUrl}/rest/v1/practices?id=eq.${encodeURIComponent(p.practiceId)}&select=data`;
  const resp = await fetch(url, {
    headers: {
      'apikey': p.sbAnonKey,
      'Authorization': 'Bearer ' + p.sbAnonKey,
      'Accept': 'application/json',
    },
  });
  if(!resp.ok) throw new Error('Supabase ' + resp.status + ': ' + await resp.text().catch(() => ''));
  const rows = await resp.json();
  if(!rows.length) throw new Error('No practice row found.');
  return rows[0].data || {};
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
  };
  const phys = (practice.physicians || []).find(p => p.id === physId);
  if(phys) out.physName = `${phys.first || ''} ${phys.last || ''}`.trim();

  // Vacations covering today
  const onVac = (practice.vacations || []).some(v => v.physId === physId && v.start <= dateISO && v.end >= dateISO);
  out.onVacation = onVac;

  // DR shifts on the day
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
      out.shifts.push({
        kind: 'DR',
        label: `${s.shift} · ${s.site || '—'}${s.sub ? ' · ' + s.sub : ''}`,
        goal,
        site: s.site,
      });
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

  // Study target: tie to wRVU goal at a 1:1 placeholder ratio. Real
  // value comes from PACS later; for now we present "n studies expected"
  // proportional to wRVU goal so the metric is visible.
  out.studyTarget = Math.max(0, Math.round(out.wRVUGoalTotal / 1.5));

  return out;
}

// ─── Renders ─────────────────────────────────────────────────────
function renderPairing(errMsg){
  root.innerHTML = `
    <div class="pair">
      <h2>Pair this widget</h2>
      <p>Paste the pairing code your RadScheduler admin gave you. The code links this widget to your physician profile.</p>
      <textarea id="pair-code" placeholder="ABC...123 (paste here)"></textarea>
      <button id="pair-submit">Pair widget</button>
      <div class="err" id="pair-err">${errMsg ? escHtml(errMsg) : ''}</div>
    </div>`;
  document.getElementById('pair-submit').onclick = onPairSubmit;
  document.getElementById('pair-code').focus();
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
  // Color based on progress: dim until 50%, accent through, green at 100+.
  const color = pct >= 1 ? 'var(--green)' : pct >= 0.5 ? 'var(--accent)' : 'var(--accent2)';
  return `<svg class="ring" viewBox="0 0 130 130">
    <circle cx="65" cy="65" r="${r}" fill="none" stroke="rgba(148,163,184,0.15)" stroke-width="10"></circle>
    <circle cx="65" cy="65" r="${r}" fill="none" stroke="${color}" stroke-width="10"
            stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"
            transform="rotate(-90 65 65)"></circle>
  </svg>`;
}

function renderDashboard(payload, digest){
  const initials = (digest.physName.split(/\s+/).map(s => s[0]).join('').slice(0,2)) || 'RS';
  const todayStr = new Date().toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
  const goal = digest.wRVUGoalTotal;
  const pct = goal > 0 ? digest.studyCount / Math.max(1, goal) : 0;
  // Status pill
  let statusLabel = 'Off';
  let statusColor = 'var(--ink2)';
  if(digest.onVacation){ statusLabel = 'Vacation'; statusColor = 'var(--amber)'; }
  else if(digest.onCall){ statusLabel = 'On call'; statusColor = 'var(--accent)'; }
  else if(digest.shifts.length){ statusLabel = digest.shifts[0].kind; statusColor = 'var(--green)'; }
  // Shifts list
  const shiftsHtml = digest.shifts.length
    ? digest.shifts.map(s => `<div class="row">
        <div class="left">${escHtml(s.label)}</div>
        <div class="right">${s.goal > 0 ? s.goal + ' wRVU' : '—'}</div>
      </div>`).join('')
    : '<div class="empty">No shifts scheduled today.</div>';
  root.innerHTML = `
    <div class="top">
      <div class="avatar">${escHtml(initials)}</div>
      <div style="flex:1;min-width:0">
        <div class="name" title="${escHtml(digest.physName)}">${escHtml(digest.physName || 'Unknown')}</div>
        <div class="date">${escHtml(todayStr)} · <span style="color:${statusColor}">${escHtml(statusLabel)}</span></div>
      </div>
    </div>

    <div class="ring-wrap">
      ${ringSvg(pct)}
      <div class="ring-label-wrap">
        <div class="ring-num">${digest.studyCount}<span style="color:var(--ink3);font-size:14px;font-weight:400"> / ${goal || '—'}</span></div>
        <div class="ring-sub">studies / wRVU goal</div>
      </div>
    </div>

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
      <span>Last refreshed <span id="refresh-time">just now</span></span>
      <span id="footer-err"></span>
    </div>`;
}

function renderError(msg, allowRepair){
  root.innerHTML = `
    <div class="pair">
      <h2>⚠ Could not load</h2>
      <p style="color:var(--ink2)">${escHtml(msg)}</p>
      ${allowRepair ? `<button id="re-pair">Re-pair widget</button>` : ''}
    </div>`;
  if(allowRepair){
    document.getElementById('re-pair').onclick = async () => {
      await window.rsWidget.clearPairing();
      renderPairing();
    };
  }
}

// ─── Refresh loop ────────────────────────────────────────────────
let _alwaysOnTop = true;
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
    renderDashboard(payload, digest);
    document.getElementById('refresh-time').textContent = new Date().toLocaleTimeString();
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
  // Tray "Re-pair" menu hook from main.
  if(window.rsWidget.onResetPairing) window.rsWidget.onResetPairing(() => renderPairing());
}

// Boot
bindHeader();
refresh();
_refreshTimer = setInterval(refresh, 5 * 60 * 1000);  // every 5 minutes
