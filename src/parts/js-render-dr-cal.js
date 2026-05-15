/* ─── DR CALENDAR ─── */
function renderDRCal(){
  const ym=document.getElementById('drc-mo').value||new Date().toISOString().slice(0,7);
  const fp=document.getElementById('drc-phys');
  if(fp&&fp.options.length<2){
    // Include DR + MIXED + any IR physician who has at least one existing DR
    // shift, so admins can filter the DR calendar to view that IR physician's
    // DR coverage. (Keeps the dropdown uncluttered when IR physicians have
    // no DR shifts at all.)
    const irWithDR = new Set(S.drShifts.map(s => s.physId));
    const cands = S.physicians.filter(p => p.drFte > 0 || irWithDR.has(p.id));
    cands.sort((a,b) => (a.last||'').localeCompare(b.last||''));
    cands.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id;
      const tag = p.role === 'IR' ? ' [IR]' : p.role === 'MIXED' ? ' [MIX]' : '';
      o.text = p.last + ', ' + p.first + tag;
      fp.appendChild(o);
    });
  }
  // Populate hospital + subspecialty dropdowns lazily (first render only).
  // Site list = (S.sites that the practice configured) ∪ (any site that
  // actually appears in DR shifts). Sub list = (S.drSubs) ∪ (any sub
  // referenced by an existing DR shift).
  const fsiteSel = document.getElementById('drc-site');
  if(fsiteSel && fsiteSel.options.length < 2){
    const sites = new Set();
    (S.sites || []).forEach(s => { if(s && s.name) sites.add(s.name); });
    (S.drShifts || []).forEach(s => { if(s.site) sites.add(s.site); });
    [...sites].sort().forEach(name => {
      const o = document.createElement('option'); o.value = name; o.text = name; fsiteSel.appendChild(o);
    });
  }
  const fsubSel = document.getElementById('drc-sub');
  if(fsubSel && fsubSel.options.length < 2){
    const subs = new Set();
    (S.drSubs || []).forEach(s => { if(s) subs.add(s); });
    (S.drShifts || []).forEach(s => { if(s.sub) subs.add(s.sub); });
    [...subs].sort().forEach(name => {
      const o = document.createElement('option'); o.value = name; o.text = name; fsubSel.appendChild(o);
    });
  }
  // Persist filter selections per-page so they survive nav-away.
  // Without this admins lose their physician/site/sub filter every
  // time they bounce out to fix a shift and come back. Stored in
  // localStorage; restored once on first render after options are
  // populated; written on every change.
  if(typeof _rsHydrateFilter === 'function'){
    _rsHydrateFilter(fp,       'rs.drc.f.phys');
    _rsHydrateFilter(fsiteSel, 'rs.drc.f.site');
    _rsHydrateFilter(fsubSel,  'rs.drc.f.sub');
    _rsHydrateFilter(document.getElementById('drc-shift'), 'rs.drc.f.shift');
  }
  const fpid=fp?.value?+fp.value:null;
  const fsh=document.getElementById('drc-shift')?.value||'';
  const fsite=fsiteSel?.value||'';
  const fsub=fsubSel?.value||'';
  // Apply the new filters to the same predicate used by the month grid
  // below + the new Day/Week/List renders. Returning a single predicate
  // means future filters (e.g., slotLabel) only need one edit.
  function _matchDRShift(s){
    if(fpid && s.physId !== fpid) return false;
    if(fsh && s.shift !== fsh) return false;
    if(fsite && s.site !== fsite) return false;
    if(fsub && s.sub !== fsub) return false;
    return true;
  }
  // View routing — Day / Week / Month / List. View + focus date are
  // persisted in localStorage. Month is default to keep existing
  // muscle memory.
  const drcView = (function(){ try{ return localStorage.getItem('rs.drc.view') || 'month'; }catch(_){ return 'month'; } })();
  const drcFocus = (function(){
    let v = ''; try{ v = localStorage.getItem('rs.drc.focusDate') || ''; }catch(_){}
    return v || fmtDate(new Date());
  })();
  // Toggle button styles + section visibility.
  const _sectionIds = { day:'drc-day-section', week:'drc-week-section', month:'drc-month-section', list:'drc-list-section' };
  Object.entries(_sectionIds).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if(el) el.style.display = (k === drcView) ? '' : 'none';
  });
  document.querySelectorAll('button[data-drcview]').forEach(b => {
    const on = b.getAttribute('data-drcview') === drcView;
    b.style.fontWeight = on ? '700' : '500';
    b.style.background = on ? 'var(--blue-bg)' : 'var(--bg3)';
    b.style.color      = on ? 'var(--blue-t)'  : 'var(--txt2)';
    b.style.border     = '1px solid ' + (on ? 'var(--blue-t)' : 'var(--bdr)');
  });
  const focusEl = document.getElementById('drc-focus');
  if(focusEl && focusEl.value !== drcFocus) focusEl.value = drcFocus;
  // Render whichever view is active. Month + List always populate
  // their containers (month uses the existing cal-grid below; list
  // is built fresh into drc-list-section). Day + Week render into
  // their own sections.
  if(drcView === 'day'){
    _renderDRCalDayView(drcFocus, _matchDRShift);
  } else if(drcView === 'week'){
    _renderDRCalWeekView(drcFocus, _matchDRShift);
  } else if(drcView === 'list'){
    // List is scoped to the focus week (Sun–Sat) so it's never a
    // 200+ row dump. Step by week (handled in drcStepFocus).
    _renderDRCalListView(drcFocus, _matchDRShift);
  }
  // Month view always populates so switching to it is instant — the
  // existing rendering below runs unconditionally.
  const vm=vacMap();const cells=buildCal(ym);const today=fmtDate(new Date());
  const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  document.getElementById('drc-head').innerHTML=DAYS.map(d=>`<div class="cal-hd">${d}</div>`).join('');
  document.getElementById('drc-body').innerHTML=cells.map(c=>{
    if(!c.day) return '<div class="cal-day other"></div>';
    let evs='';
    _shiftsOnDate('dr', c.date).filter(_matchDRShift).forEach(s=>{
      const cls=s.shift==='1st'?'e1':s.shift==='2nd'?'e2':s.shift==='3rd'?'e3':s.autoHome?'e-home-auto':'ehome';
      const p=_physById(s.physId);  // memoized O(1) — was O(N) .find()
      const nonAnc=p?.anchorSite&&s.site!==p.anchorSite?' eanc':'';
      const siteSh=(s.site||'').split(' ')[0];
      const subLbl=s.sub?s.sub.slice(0,6):'';
      // Admin-configured slot label (e.g. "chn 1", "chn 2") disambiguates
      // multiple positions at the same site/shift. Previously the chip
      // showed just the site short name, so two shifts at CHN looked
      // identical. Falls back to empty string when no label is set.
      const slotLbl = s.slotLabel ? ` · ${s.slotLabel}` : '';
      if(s.shift==='Home'||s.autoHome){
        evs+=`<div class="ev ${cls}${nonAnc}" title="${pnameHtml(s.physId)} — ${s.autoHome?'Auto-':''}Home">
          <div style="font-weight:700;font-size:11px">🏠 ${pshort(s.physId)}</div>
          <div style="font-size:9px;opacity:.8">${s.autoHome?'Auto-Home':'Home'}</div>
        </div>`;
      } else if(s.shift==='2nd' || s.shift==='3rd'){
        // 2nd / 3rd shifts are home-only by practice convention. Show
        // them with a clear "evening/night" badge instead of the
        // truncated site label which always resolves to "At" (from
        // "At Home / Remote") and confuses admins into thinking the
        // record didn't import.
        const badge = s.shift==='2nd' ? 'Evening' : 'Overnight';
        const wrvuG = (typeof getShiftWRVUGoal === 'function') ? getShiftWRVUGoal(s, s.physId, 'dr') : 0;
        const wrvuTip = wrvuG > 0 ? ` · wRVU goal ${wrvuG}` : '';
        evs+=`<div class="ev ${cls}${nonAnc}" title="${pnameHtml(s.physId)} — ${s.shift} Shift (Home)${wrvuTip}${s.notes?' · '+s.notes:''}">
          <div style="font-weight:700;font-size:11px">🌙 ${pshort(s.physId)}</div>
          <div style="font-size:9px;opacity:.85">${s.shift} ${badge}${wrvuG > 0 ? ` · ${wrvuG}` : ''}</div>
        </div>`;
      } else {
        const wrvuG = (typeof getShiftWRVUGoal === 'function') ? getShiftWRVUGoal(s, s.physId, 'dr') : 0;
        const wrvuTip = wrvuG > 0 ? ` · wRVU goal ${wrvuG}` : '';
        evs+=`<div class="ev ${cls}${nonAnc}" title="${pnameHtml(s.physId)} — ${s.shift} Shift @ ${s.site}${s.slotLabel?' ['+s.slotLabel+']':''}${s.sub?' ('+s.sub+')':''}${wrvuTip}">
          <div style="font-weight:700;font-size:11px">${pshort(s.physId)}</div>
          <div style="font-size:9px;opacity:.85">${s.shift} Shift${wrvuG > 0 ? ` · ${wrvuG} wRVU` : ''}</div>
          <div style="font-size:9px;opacity:.7">${siteSh}${slotLbl}${subLbl?' · '+subLbl:''}${_driveTimeBadge(s.physId,s.site,s.shift,s.date,'DR')}</div>
        </div>`;
      }
    });
    if(!fsh||fsh==='Weekend') _shiftsOnDate('wkn', c.date).filter(w => (!fpid||w.physId===fpid) && (!fsite||w.site===fsite) && !fsub).forEach(w=>{
      evs+=`<div class="ev ewk" title="${pnameHtml(w.physId)} — Weekend Call @ ${w.site}">
        <div style="font-weight:700;font-size:11px">${pshort(w.physId)}</div>
        <div style="font-size:9px;opacity:.85">Wknd Call</div>
        <div style="font-size:9px;opacity:.7">${(w.site||'').split(' ')[0]}</div>
      </div>`;
    });
    if(!fsh||fsh==='Holiday') S.holidays.filter(h => h.date===c.date && h.group==='DR' && (!fpid||h.physId===fpid) && !fsite && !fsub).forEach(h=>{
      evs+=`<div class="ev ehol" title="${pnameHtml(h.physId)} — Holiday Call: ${h.name}">
        <div style="font-weight:700;font-size:11px">🏖 ${pshort(h.physId)}</div>
        <div style="font-size:9px;opacity:.85">Hol Call</div>
        <div style="font-size:9px;opacity:.7">${h.name.split(' ')[0]}</div>
      </div>`;
    });
    (vm[c.date]||[]).filter(pid=>{ const p=_physById(pid); return p && p.drFte>0; }).forEach(pid=>{
      evs+=`<div class="ev evac" title="${pnameHtml(pid)} — Vacation/Time Off">
        <div style="font-weight:700;font-size:11px">${pshort(pid)}</div>
        <div style="font-size:9px;opacity:.8">Time Off</div>
      </div>`;
    });
    S.openShifts.filter(o=>o.date===c.date&&!o.claimedBy&&o.group==='DR').forEach(()=>{evs+=`<div class="ev eopen">Open</div>`;});
    const _isSB=c.day&&!c.isWknd&&S.vacations.some(v=>v.type==='Vacation Sold Back'&&c.date>=v.start&&c.date<=v.end);
    return`<div class="cal-day${c.date===today?' today':''}${c.isWknd?' wknd':''}${_isSB?' sold-back':''}"><div class="cal-num">${c.day}${_isSB?'<span class="sold-back-banner"> SOLD BACK</span>':''}</div>${evs}</div>`;
  }).join('');
}

// ── DR calendar — Day / Week / List view renders ─────────────────
// All three use the same _matchDRShift predicate passed from
// renderDRCal so filters (physician / hospital / subspecialty /
// shift) apply uniformly across views.

function _renderDRCalDayView(focusISO, match){
  const el = document.getElementById('drc-day-section');
  if(!el) return;
  const d = parseDateLocal(focusISO);
  const today = fmtDate(new Date());
  const dayLabel = d.toLocaleString('default', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  const isToday = focusISO === today;
  const shifts = (S.drShifts || []).filter(s => s.date === focusISO && match(s));
  // Group rows by site → shift type for a readable single-day view.
  const groups = {};
  shifts.forEach(s => {
    const site = s.site || '—';
    if(!groups[site]) groups[site] = { '1st':[], '2nd':[], '3rd':[], 'Home':[], _other:[] };
    const bucket = groups[site][s.shift] ? s.shift : '_other';
    groups[site][bucket].push(s);
  });
  const siteKeys = Object.keys(groups).sort();
  let html = `<div class="card" style="margin-bottom:12px">
    <div class="card-title" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span>${escHtml(dayLabel)}</span>
      ${isToday ? '<span class="tag tb" style="font-size:10px">TODAY</span>' : ''}
      <span class="tag tg" style="font-size:10px">${shifts.length} DR assignment${shifts.length===1?'':'s'}</span>
    </div>`;
  if(!shifts.length){
    html += '<div class="note ni" style="font-size:12px">No DR assignments match the current filters for this day.</div>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:14px">';
    siteKeys.forEach(site => {
      const g = groups[site];
      const total = ['1st','2nd','3rd','Home','_other'].reduce((n,k)=>n+(g[k]?.length||0),0);
      html += `<div>
        <div style="font-weight:700;font-size:13px;margin-bottom:6px;color:var(--rs-ink-2);border-bottom:1px solid var(--bdr);padding-bottom:4px">🏥 ${escHtml(site)} <span style="font-weight:400;color:var(--rs-ink-3);font-size:11px">· ${total}</span></div>`;
      ['1st','2nd','3rd','Home','_other'].forEach(k => {
        if(!g[k] || !g[k].length) return;
        const label = k === '_other' ? 'Other' : (k === 'Home' ? 'Home / Remote' : `${k} shift`);
        const cls = k==='1st'?'tb':k==='2nd'?'tg':k==='3rd'?'ta':k==='Home'?'tpk':'tt';
        html += `<div style="margin-bottom:6px"><span class="tag ${cls}" style="font-size:10px;margin-right:6px">${escHtml(label)}</span><span style="font-size:12px">${g[k].map(s => {
          const p = _physById(s.physId);
          const pn = p ? `${p.last}, ${p.first}` : `Phys#${s.physId}`;
          const sub = s.sub ? ` <span style="color:var(--rs-ink-3);font-size:11px">· ${escHtml(s.sub)}</span>` : '';
          const slot = s.slotLabel ? ` <span style="color:var(--blue-t);font-size:10px;font-weight:700">🏷 ${escHtml(s.slotLabel)}</span>` : '';
          return `<span style="margin-right:10px">${escHtml(pn)}${sub}${slot}</span>`;
        }).join('')}</span></div>`;
      });
      html += `</div>`;
    });
    html += '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

function _renderDRCalWeekView(focusISO, match){
  const el = document.getElementById('drc-week-section');
  if(!el) return;
  const d = parseDateLocal(focusISO);
  const dow = d.getDay();
  const sunISO = addDays(focusISO, -dow);
  const today = fmtDate(new Date());
  const wkLabel = `${parseDateLocal(sunISO).toLocaleString('default',{month:'short',day:'numeric'})} – ${parseDateLocal(addDays(sunISO,6)).toLocaleString('default',{month:'short',day:'numeric',year:'numeric'})}`;
  let html = `<div class="card" style="margin-bottom:12px">
    <div class="card-title">Week of ${escHtml(wkLabel)}</div>
    <div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px">`;
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach((dn,i) => {
    const ds = addDays(sunISO, i);
    const dd = parseDateLocal(ds);
    const isToday = ds === today;
    const isWknd = i === 0 || i === 6;
    const shifts = (S.drShifts || []).filter(s => s.date === ds && match(s));
    // Compact item lines: up to 7 then "+N more".
    const items = shifts.slice(0, 7).map(s => {
      const p = _physById(s.physId);
      const pn = p ? p.last : '?';
      const sh = s.shift === 'Home' ? '🏠' : s.shift;
      return `<div class="ev e${s.shift==='1st'?'1':s.shift==='2nd'?'2':s.shift==='3rd'?'3':'home'}" style="font-size:9px;padding:2px 4px;font-weight:600">${escHtml(sh)} ${escHtml(pn)}</div>`;
    });
    html += `<div class="cal-day${isToday?' today':''}${isWknd?' wknd':''}" style="min-height:96px;padding:6px;cursor:pointer" onclick="drcSetFocus('${ds}'); drcSetView('day')">
      <div style="font-size:10px;color:var(--rs-ink-3);text-transform:uppercase;letter-spacing:.04em">${dn}</div>
      <div style="font-size:18px;font-weight:700;line-height:1">${dd.getDate()}</div>
      <div style="margin-top:4px;display:flex;flex-direction:column;gap:2px">
        ${items.join('') || '<div style="font-size:9px;color:var(--rs-ink-3);font-style:italic;margin-top:6px">—</div>'}
        ${shifts.length > 7 ? `<div style="font-size:9px;color:var(--rs-ink-3)">+${shifts.length-7} more</div>` : ''}
      </div>
    </div>`;
  });
  html += `</div>
    <div class="note ni" style="font-size:10.5px;margin-top:8px">Click any day to drill in to Day view.</div>
  </div>`;
  el.innerHTML = html;
}

function _renderDRCalListView(focusISO, match){
  const el = document.getElementById('drc-list-section');
  if(!el) return;
  // Scope to focus week (Sun → Sat). Step by week using ‹ › so the
  // list never balloons into a full-month dump.
  const d = parseDateLocal(focusISO);
  const dow = d.getDay();
  const sunISO = addDays(focusISO, -dow);
  const satISO = addDays(sunISO, 6);
  const wkLabel = `${parseDateLocal(sunISO).toLocaleString('default',{month:'short',day:'numeric'})} – ${parseDateLocal(satISO).toLocaleString('default',{month:'short',day:'numeric',year:'numeric'})}`;
  const rows = (S.drShifts || [])
    .filter(s => s.date && s.date >= sunISO && s.date <= satISO && match(s))
    .sort((a,b) => a.date.localeCompare(b.date) || (a.shift||'').localeCompare(b.shift||''));
  if(!rows.length){
    el.innerHTML = `<div class="card"><div class="card-title">DR Assignments — Week of ${escHtml(wkLabel)}</div><div class="note ni">No DR assignments match the current filters for this week. Step ‹ › to browse other weeks.</div></div>`;
    return;
  }
  let html = `<div class="card"><div class="card-title">DR Assignments — Week of ${escHtml(wkLabel)} <span style="font-weight:400;color:var(--rs-ink-3);font-size:11px">· ${rows.length} row${rows.length===1?'':'s'}</span></div><div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Day</th><th>Shift</th><th>Physician</th><th>Hospital</th><th>Subspecialty</th><th>Slot</th><th>Notes</th></tr></thead><tbody>`;
  rows.forEach(s => {
    const p = _physById(s.physId);
    const pn = p ? `${p.last}, ${p.first}` : `Phys#${s.physId}`;
    const dowName = parseDateLocal(s.date).toLocaleString('default', {weekday:'short'});
    const cls = s.shift==='1st'?'tb':s.shift==='2nd'?'tg':s.shift==='3rd'?'ta':'tpk';
    html += `<tr><td>${escHtml(s.date)}</td><td>${escHtml(dowName)}</td><td><span class="tag ${cls}">${escHtml(s.shift||'')}</span></td><td>${escHtml(pn)}</td><td>${escHtml(s.site||'')}</td><td>${escHtml(s.sub||'')}</td><td>${escHtml(s.slotLabel||'')}</td><td style="color:var(--txt2);font-size:11px">${escHtml(s.notes||'')}</td></tr>`;
  });
  html += '</tbody></table></div></div>';
  el.innerHTML = html;
}

// ── DR calendar — view + focus controls ──────────────────────────
function drcSetView(v){
  if(!['day','week','month','list'].includes(v)) v = 'month';
  try{ localStorage.setItem('rs.drc.view', v); }catch(_){}
  if(typeof renderDRCal === 'function') renderDRCal();
}
function drcSetFocus(iso){
  if(!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
  try{ localStorage.setItem('rs.drc.focusDate', iso); }catch(_){}
  const moEl = document.getElementById('drc-mo');
  if(moEl) moEl.value = iso.slice(0, 7);
  if(typeof renderDRCal === 'function') renderDRCal();
}
function drcStepFocus(step){
  const view = (function(){ try{ return localStorage.getItem('rs.drc.view') || 'month'; }catch(_){ return 'month'; } })();
  if(step === 0){ drcSetFocus(fmtDate(new Date())); return; }
  const cur = (function(){ let v=''; try{v=localStorage.getItem('rs.drc.focusDate')||''}catch(_){} return v || fmtDate(new Date()); })();
  let next = cur;
  if(view === 'day')        next = addDays(cur, step);
  else if(view === 'week')  next = addDays(cur, 7 * step);
  else if(view === 'list')  next = addDays(cur, 7 * step);   // list is week-scoped → step by week
  else { const d = parseDateLocal(cur); d.setMonth(d.getMonth() + step); next = fmtDate(d); }
  drcSetFocus(next);
}
