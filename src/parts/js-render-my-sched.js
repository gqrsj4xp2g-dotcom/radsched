/* ─── MY SCHEDULE ─── */
function renderMySched(){
  if(!CU) return;
  const moEl=document.getElementById('my-mo');
  if(!moEl) return;
  if(!moEl.value){const now=new Date();moEl.value=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');}
  const ym=moEl.value;
  const [y,m]=ym.split('-').map(Number);
  const p=S.physicians.find(x=>x.id===CU.physId);
  if(!p){document.getElementById('my-content').innerHTML='<div class="note ni">No physician profile linked to your account. Contact an administrator.</div>';return;}
  const shifts=S.drShifts.filter(s=>s.physId===p.id&&s.date.startsWith(ym)&&!s.autoHome);
  const wk=S.weekendCalls.filter(s=>s.physId===p.id&&(s.satDate||s.date||'').startsWith(ym));
  const ir=S.irCalls.filter(s=>s.physId===p.id&&s.date.startsWith(ym)&&!_isHolidaySyncedCall(s));
  const irSh=(S.irShifts||[]).filter(s=>s.physId===p.id&&s.date.startsWith(ym));
  const hols=S.holidays.filter(h=>h.physId===p.id&&h.date.startsWith(ym));
  const vacs=S.vacations.filter(v=>v.physId===p.id&&v.start.slice(0,7)<=ym&&v.end.slice(0,7)>=ym);
  const c=ancComp(p.id,ym);
  const monthLabel=new Date(y,m-1,1).toLocaleString('default',{month:'long',year:'numeric'});

  let html=`<div class="g4" style="margin-bottom:12px">
    <div class="met"><div class="met-lbl">DR Shifts</div><div class="met-val">${shifts.filter(s=>s.shift!=='Home').length}/${maxDR(p,'wd')}</div><div class="met-sub">this month</div></div>
    <div class="met"><div class="met-lbl">Weekend Calls</div><div class="met-val">${wk.length}/${maxDR(p,'wk')}</div></div>
    ${p.irFte>0?`<div class="met"><div class="met-lbl">IR Calls</div><div class="met-val">${ir.length}/${maxDR(p,'ir')}</div></div>
    <div class="met"><div class="met-lbl">IR Shifts</div><div class="met-val">${irSh.length}</div><div class="met-sub">this month</div></div>`:''}
    ${c&&!c.noData?`<div class="met"><div class="met-lbl">⚓ Anchor</div><div class="met-val" style="color:${c.ok?'var(--green)':'var(--red)'}">${c.pct}%</div><div class="met-sub">≥${S.cfg.anchorPct}% target</div></div>`:''}
  </div>`;
  // Leave-type balance chips (Vacation / Sick / CME / Personal etc.).
  // Renders nothing if the physician has no allocations and no used days.
  try{
    if(typeof _renderMyLeaveBalances === 'function') html += _renderMyLeaveBalances();
  }catch(_){}
  if(c&&c.ok===false) html+=`<div class="note nw" style="margin-bottom:10px">⚓ Anchor alert: ${c.pct}% at ${c.anchor} — need ≥${S.cfg.anchorPct}%.</div>`;

  // ── Next 7 days (mobile-first) ────────────────────────────────────────
  // The single most-asked question of this app is "what am I doing the
  // next few days?" — so we surface that as a calm list above the full
  // calendar grid. Renders as a vertical stack of day cards on phone via
  // the rs-day media query; on desktop it's a horizontal flex.
  const today2 = fmtDate(new Date());
  const dayLabel = (ds) => {
    if(ds === today2) return 'Today';
    if(ds === addDays(today2, 1)) return 'Tomorrow';
    return parseDateLocal(ds).toLocaleString('default',{weekday:'long', month:'short', day:'numeric'});
  };
  const next7 = [];
  for(let i = 0; i < 7; i++){
    const ds = addDays(today2, i);
    const dShifts = (S.drShifts||[]).filter(s => s.physId === p.id && s.date === ds);
    const dIRSh   = (S.irShifts||[]).filter(s => s.physId === p.id && s.date === ds);
    const dIRC    = (S.irCalls||[]).filter(c => c.physId === p.id && (
      (c.callType==='daily' && c.date === ds) ||
      (c.callType==='weekend' && (ds === c.date || ds === addDays(c.date,1) || ds === addDays(c.date,2) || ds === addDays(c.date,3)))
    ));
    const dWk = (S.weekendCalls||[]).filter(w => w.physId === p.id && (w.satDate === ds || w.sunDate === ds));
    const dHol = (S.holidays||[]).filter(h => h.physId === p.id && h.date === ds);
    const dVac = vacSetHas(ds);
    next7.push({ds, dShifts, dIRSh, dIRC, dWk, dHol, dVac});
  }
  function vacSetHas(ds){
    return (S.vacations||[]).some(v => v.physId === p.id && v.start <= ds && v.end >= ds);
  }
  const next7Html = `
    <div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-size:11px;font-weight:600;color:var(--rs-ink-3);text-transform:uppercase;letter-spacing:.06em">Next 7 days</div>
        <button class="bsm" onclick="openSwapSuggestModal()" title="See who could take any of your upcoming shifts">🔄 Find swap partner</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${next7.map(d => {
          const isToday = d.ds === today2;
          const items = [];
          d.dShifts.forEach(s => items.push(`${escHtml(s.shift)} · ${escHtml(s.site||'—')}${s.sub?' · '+escHtml(s.sub):''}`));
          d.dIRSh.forEach(s => items.push(`IR ${escHtml(s.shift)} · ${escHtml(s.site||'—')}`));
          d.dIRC.forEach(c => items.push(`IR ${c.callType==='weekend'?'Weekend':'Daily'} call`));
          d.dWk.forEach(_ => items.push('DR Weekend call'));
          d.dHol.forEach(h => items.push(`Holiday: ${escHtml(h.name||'')}`));
          if(d.dVac) items.push('Vacation / Time off');
          if(!items.length) items.push('Off');
          return `<div class="ms-day ${isToday?'today':''}">
            <div class="day-label">${escHtml(dayLabel(d.ds))}</div>
            <div class="day-num">${parseDateLocal(d.ds).getDate()}</div>
            ${items.map(it => `<div class="ms-shift">${it}</div>`).join('')}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  html += next7Html;

  const cells=buildCal(ym);
  const today=fmtDate(new Date());
  const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const shiftsByDate={};
  shifts.forEach(s=>{if(!shiftsByDate[s.date])shiftsByDate[s.date]=[];shiftsByDate[s.date].push(s);});
  const vacSet=new Set();
  vacs.forEach(v=>{let d=parseDateLocal(v.start),e=parseDateLocal(v.end);while(d<=e){vacSet.add(fmtDate(d));d.setDate(d.getDate()+1);}});

  html+=`<div class="card" style="margin-bottom:12px">
    <div class="card-title">${monthLabel}</div>
    <div class="cal-grid" style="margin-bottom:4px">${DAYS.map(d=>`<div class="cal-hd">${d}</div>`).join('')}</div>
    <div class="cal-grid">`;
  cells.forEach(c=>{
    if(!c.day){html+='<div class="cal-day other"></div>';return;}
    let evs='';
    (shiftsByDate[c.date]||[]).forEach(s=>{
      const cls=s.shift==='1st'?'e1':s.shift==='2nd'?'e2':s.shift==='3rd'?'e3':'ehome';
      const anc=p.anchorSite&&s.site!==p.anchorSite?' eanc':'';
      const siteSh=(s.site||'').split(' ')[0];
      // Slot label badge — shows the named position when admin set one.
      // Lets physicians know "you're at Reading-Room-A" not just "you're at Main".
      const slotBadge = s.slotLabel
        ? `<div style="font-size:9px;font-weight:700;color:var(--blue-t);background:rgba(96,165,250,0.15);padding:0 4px;border-radius:3px;display:inline-block;margin-top:1px">🏷 ${(s.slotLabel||'').replace(/</g,'&lt;')}</div>`
        : '';
      if(s.shift==='Home'){
        evs+=`<div class="ev ${cls}${anc}" title="Home @ ${s.site}${s.slotLabel?' · '+s.slotLabel:''}">
          <div style="font-weight:700;font-size:11px">🏠 Home</div>
          <div style="font-size:9px;opacity:.7">${siteSh}</div>
          ${slotBadge}
        </div>`;
      } else {
        evs+=`<div class="ev ${cls}${anc}" title="${s.shift} Shift @ ${s.site}${s.slotLabel?' · '+s.slotLabel:''}">
          <div style="font-weight:700;font-size:11px">${s.shift} Shift</div>
          <div style="font-size:9px;opacity:.7">${siteSh}${s.sub?' · '+s.sub.slice(0,6):''}</div>
          ${slotBadge}
        </div>`;
      }
    });
    wk.forEach(w=>{
      const sat=w.satDate||w.date;const sun=w.sunDate||addDays(sat,1);
      if(c.date===sat||c.date===sun){
        evs+=`<div class="ev ewk" title="Weekend Call @ ${w.site}">
          <div style="font-weight:700;font-size:11px">📞 Wknd Call</div>
          <div style="font-size:9px;opacity:.7">${(w.site||'').split(' ')[0]}</div>
        </div>`;
      }
    });
    ir.forEach(ic=>{
      let show=false;
      if(ic.callType==='daily'&&ic.date===c.date) show=true;
      if(ic.callType==='weekend'){const wEnd=addDays(ic.date,3);if(c.date>=ic.date&&c.date<=wEnd)show=true;}
      if(!show) return;
      if(ic.callType==='weekend'){
        const isStart=ic.date===c.date;
        evs+=`<div class="ev ewk" title="Weekend Call (${ic.irGroup}) @ ${ic.site}">
          <div style="font-weight:700;font-size:11px">📞 ${isStart?'▶ ':''}Wknd Call</div>
          <div style="font-size:9px;opacity:.85">${ic.irGroup}</div>
          <div style="font-size:9px;opacity:.7">${(ic.site||'').split(' ')[0]}</div>
        </div>`;
      } else {
        // Daily (weekday) IR call covers the entire group — it is NOT
        // per-hospital. Previously the chip showed a hospital short name
        // on the third line, which was misleading: a physician on daily
        // call is the group's call coverage regardless of where they happen
        // to be physically doing procedure shifts that day. The chip now
        // represents the GROUP as the call owner, with the physician
        // prominent. Hospital info (if any) stays on the adjacent IR shift
        // chip where it belongs.
        evs+=`<div class="ev eir" title="Daily Call (${ic.irGroup})">
          <div style="font-weight:700;font-size:11px">📟 Daily Call</div>
          <div style="font-size:9px;opacity:.85">${ic.irGroup}</div>
        </div>`;
      }
    });
    irSh.filter(s=>s.date===c.date).forEach(s=>{
      const shCls=s.shift==='Home'?'ehome':s.shift==='1st'?'eir':s.shift==='2nd'?'e2':'e3';
      const siteSh=(s.site||'').split(' ')[0];
      const _irSlotBadge = s.slotLabel
        ? `<div style="font-size:9px;font-weight:700;color:var(--purple-t,#a78bfa);background:rgba(167,139,250,0.15);padding:0 4px;border-radius:3px;display:inline-block;margin-top:1px">🏷 ${(s.slotLabel||'').replace(/</g,'&lt;')}</div>`
        : '';
      if(s.shift==='Home'){
        evs+=`<div class="ev ${shCls}" title="IR Home @ ${s.site}${s.slotLabel?' · '+s.slotLabel:''}">
          <div style="font-weight:700;font-size:11px">🏠 Home</div>
          <div style="font-size:9px;opacity:.7">IR · ${siteSh}</div>
          ${_irSlotBadge}
        </div>`;
      } else {
        const irShLbl=s.shift==='1st'?'Day Shift':s.shift+' Shift';
        evs+=`<div class="ev ${shCls}" title="IR ${irShLbl} @ ${s.site}${s.sub?' ('+s.sub+')':''}${s.slotLabel?' · '+s.slotLabel:''}">
          <div style="font-weight:700;font-size:11px">${irShLbl}</div>
          <div style="font-size:9px;opacity:.85">IR · ${siteSh}</div>
          <div style="font-size:9px;opacity:.7">${s.sub?s.sub.slice(0,6):''}</div>
          ${_irSlotBadge}
        </div>`;
      }
    });
    hols.filter(h=>h.date===c.date).forEach(h=>evs+=`<div class="ev ehol" title="${h.name}">🏖</div>`);
    if(vacSet.has(c.date)) evs+=`<div class="ev evac" title="Off">Off</div>`;
    const isSB=S.vacations.some(v=>v.physId===p.id&&v.type==='Vacation Sold Back'&&c.date>=v.start&&c.date<=v.end);
    html+=`<div class="cal-day${c.date===today?' today':''}${c.isWknd?' wknd':''}${isSB?' sold-back':''}" style="min-height:58px"><div class="cal-num">${c.day}</div>${evs}</div>`;
  });
  html+=`</div></div>`;

  const allEvts=[
    ...shifts.filter(s=>s.shift!=='Home').map(s=>({date:s.date,type:s.shift+' Shift',site:s.site,detail:[s.sub||'—',s.slotLabel?'🏷 '+s.slotLabel:''].filter(Boolean).join(' · '),col:'tb'})),
    ...wk.map(w=>({date:w.satDate||w.date,type:'Weekend Call',site:w.site,detail:w.sub||'—',col:'tg'})),
    ...ir.map(i=>({date:i.date,type:'IR '+i.callType+(i.callType==='weekend'?' (Fri→Mon)':''),site:i.site,detail:i.irGroup||'—',col:'tt'})),
    ...irSh.map(s=>({date:s.date,type:'IR '+(s.shift==='1st'?'Day':s.shift)+' Shift',site:s.site,detail:[s.sub||s.irGroup||'—',s.slotLabel?'🏷 '+s.slotLabel:''].filter(Boolean).join(' · '),col:'tt'})),
    ...hols.map(h=>({date:h.date,type:'Holiday: '+h.name,site:'—',detail:h.group,col:'tp'})),
  ].sort((a,b)=>a.date>b.date?1:-1);
  if(allEvts.length){
    html+='<div class="card"><div class="card-title">All Assignments</div><div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Type</th><th>Site</th><th>Detail</th></tr></thead><tbody>';
    html+=allEvts.map(a=>`<tr><td>${a.date}</td><td><span class="tag ${a.col}">${a.type}</span></td><td>${a.site}</td><td>${a.detail}</td></tr>`).join('');
    html+='</tbody></table></div></div>';
  } else html+='<div class="note ni">No shifts assigned for '+monthLabel+'.</div>';
  document.getElementById('my-content').innerHTML=html;
}
