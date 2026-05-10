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
  const fpid=fp?.value?+fp.value:null;
  const fsh=document.getElementById('drc-shift')?.value||'';
  const vm=vacMap();const cells=buildCal(ym);const today=fmtDate(new Date());
  const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  document.getElementById('drc-head').innerHTML=DAYS.map(d=>`<div class="cal-hd">${d}</div>`).join('');
  document.getElementById('drc-body').innerHTML=cells.map(c=>{
    if(!c.day) return '<div class="cal-day other"></div>';
    let evs='';
    _shiftsOnDate('dr', c.date).filter(s=>(!fpid||s.physId===fpid)&&(!fsh||s.shift===fsh)).forEach(s=>{
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
    if(!fsh||fsh==='Weekend') _shiftsOnDate('wkn', c.date).filter(w=>(!fpid||w.physId===fpid)).forEach(w=>{
      evs+=`<div class="ev ewk" title="${pnameHtml(w.physId)} — Weekend Call @ ${w.site}">
        <div style="font-weight:700;font-size:11px">${pshort(w.physId)}</div>
        <div style="font-size:9px;opacity:.85">Wknd Call</div>
        <div style="font-size:9px;opacity:.7">${(w.site||'').split(' ')[0]}</div>
      </div>`;
    });
    if(!fsh||fsh==='Holiday') S.holidays.filter(h=>h.date===c.date&&h.group==='DR').forEach(h=>{
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
