/* ─── DASHBOARD ─── */
function renderDash(){
  if(!CU)return;
  if(!_dashYm){const now=new Date();_dashYm=fmtDate(new Date(now.getFullYear(),now.getMonth(),1)).slice(0,7);}
  const ym=_dashYm;
  const[y,m]=ym.split('-').map(Number);
  const monthName=new Date(y,m-1,1).toLocaleString('default',{month:'long',year:'numeric'});
  const ml=document.getElementById('dash-month-label');if(ml)ml.textContent=monthName;
  document.getElementById('dash-greet').textContent=`Welcome back, ${CU.first}. ${CU.role==='admin'?'Admin view.':''}`;
  const isAdm=CU.role==='admin';
  // The "More analytics" details wrapper is what gets toggled now —
  // dash-admin-section lives INSIDE it. Setting block on the inner
  // section would override <details> open/closed behavior.
  ['dash-more-details'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display=isAdm?'':'none';});
  // Practice-wide announcements (banners). Each user can dismiss them
  // independently — dismissals stored in localStorage so they persist
  // across reloads but don't bloat the shared S state.
  try{ _renderAnnouncements(); }catch(e){ if(typeof _logError === 'function') _logError('_renderAnnouncements', e.message, e); }
  // Today's-coverage widget (rendered before per-month metrics).
  try{ _renderTodayCoverage(isAdm); }catch(e){ if(typeof _logError === 'function') _logError('_renderTodayCoverage', e.message, e); }
  // Proactive coverage-gap banner: scans next 30 days for unfilled
  // critical slots (1st-shift weekday DR coverage, weekend call,
  // holiday coverage). Hidden when zero gaps.
  try{ _renderCoverageGapBanner(isAdm); }catch(e){ if(typeof _logError === 'function') _logError('_renderCoverageGapBanner', e.message, e); }
  // Workload Fairness Scoreboard (transparency: each physician's call /
  // shift / weekend load vs FTE-adjusted expected). Rendered below the
  // dashboard's main grid so it doesn't crowd the top.
  try{ _renderFairnessScoreboard(isAdm); }catch(e){ if(typeof _logError === 'function') _logError('_renderFairnessScoreboard', e.message, e); }
  // On-Call Confirmation widget — admins see who is on tonight + whether
  // they've acknowledged the reminder push. Physicians see their own card
  // only (with a self-acknowledge button). Hidden when no one is on call.
  try{ _renderOnCallConfirmation(isAdm); }catch(e){ if(typeof _logError === 'function') _logError('_renderOnCallConfirmation', e.message, e); }
  // Equity Heatmap — forward-looking 90-day view of FTE-adjusted balance.
  // Surfaces imbalances forming BEFORE they're disputes. Admin-only.
  try{ if(isAdm) _renderEquityHeatmap(); }catch(e){ if(typeof _logError === 'function') _logError('_renderEquityHeatmap', e.message, e); }

  // First-run wizard — refined design. Persistent until every required
  // setup step is complete; disappears the moment the last check turns
  // green. Now also tracks sub-specialties and basic shift caps so a
  // brand-new practice doesn't try to auto-assign with caps of 0.
  const setupBanner = document.getElementById('dash-setup-banner');
  if(setupBanner){
    const realSites = (S.sites||[]).filter(s => s.name !== 'At Home / Remote');
    const hasPhys = (S.physicians||[]).length > 0;
    const hasSubs = (S.drSubs||[]).length > 0 || (S.irSubs||[]).length > 0;
    const cfg = S.cfg || {};
    const hasCaps = (cfg.wdMax > 0 || cfg.irDailyMax > 0);
    const allDone = realSites.length && hasPhys && hasSubs && hasCaps;
    if(isAdm && !allDone){
      const steps = [
        {done: realSites.length>0,        label:'Add your hospital sites',       target:'site-slots'},
        {done: (S.irGroups||[]).length>0, label:'Configure IR groups',           target:'ir-slots'},
        {done: hasSubs,                   label:'Define your sub-specialties',   target:'settings'},
        {done: hasPhys,                   label:'Add your physicians',           target:'physicians'},
        {done: hasCaps,                   label:'Set monthly shift caps',        target:'settings'},
      ];
      const completedCount = steps.filter(s => s.done).length;
      setupBanner.style.display = '';
      setupBanner.innerHTML = `
        <div class="rs-quickstart">
          <div class="rs-quickstart-title">Set up your practice</div>
          <div class="rs-quickstart-sub">${completedCount} of ${steps.length} complete · <span style="color:var(--rs-accent);font-weight:500">Each step takes about a minute</span></div>
          ${steps.map((s,i) => `
            <div class="rs-quickstart-step ${s.done?'done':''}" onclick="${s.done?'':`nav('${s.target}',document.querySelector('.snav-item[data-pg=&quot;${s.target}&quot;]'))`}">
              <div class="rs-quickstart-check">${s.done ? '✓' : ''}</div>
              <div class="rs-quickstart-name">${escHtml(s.label)}</div>
              <div class="rs-quickstart-arrow">${s.done ? '' : '→'}</div>
            </div>`).join('')}
        </div>`;
    } else {
      setupBanner.style.display = 'none';
      setupBanner.innerHTML = '';
    }
  }
  const drPs=S.physicians.filter(p=>p.role!=='IR');
  const irPs=S.physicians.filter(p=>p.irFte>0);
  const open=S.openShifts.filter(o=>!o.claimedBy).length;
  const anchPhys=S.physicians.filter(p=>p.anchorSite);
  const anchOk=anchPhys.filter(p=>{const c=ancComp(p.id,ym);return c&&c.ok;}).length;
  const _adminPages=new Set(['physicians','anchor-report','fte','auto-assign','ir-auto','ir-rebalance','ir-shift-auto','user-mgmt','settings','practices','site-slots','ir-slots','ir-shift-slots','dr-builder','dr-weekends','ir-shifts','ir-builder','ai-agent','import','vac-pick','vacations']);
  document.getElementById('dash-metrics').innerHTML=[
    {l:'DR Physicians',v:drPs.length,s:'incl. mixed',pg:'physicians'},
    {l:'IR Physicians',v:irPs.length,s:'incl. mixed',pg:'ir-cal'},
    {l:'Open Shifts',v:open,s:'unclaimed',pg:'open-shifts'},
    {l:'Anchor Compliant',v:`${anchOk}/${anchPhys.length}`,s:monthName,pg:'anchor-report'},
  ].filter(m=>isAdm||!_adminPages.has(m.pg))
   .map(m=>`<div class="met" style="cursor:pointer" onclick="nav('${m.pg}',document.querySelector('[onclick*=${JSON.stringify(m.pg).slice(1,-1)}]'))" title="Go to ${m.pg}">
    <div class="met-lbl">${m.l}</div><div class="met-val">${m.v}</div><div class="met-sub">${m.s}</div></div>`).join('');
  const ancHtml=anchPhys.map(p=>{const c=ancComp(p.id,ym);const pct=c?c.pct:0;
    return`<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px">
      <span style="color:var(--txt2)">${p.last} <span style="color:var(--txt3);font-size:10px">(${(p.anchorSite||'').split(' ')[0]})</span></span>
      <span style="font-weight:700;color:${pct>=S.cfg.anchorPct?'var(--green)':pct>=40?'var(--amber)':'var(--red)'}">${pct}%</span>
    </div>${ancBar(pct)}</div>`;}).join('');
  document.getElementById('dash-anc').innerHTML=ancHtml||'<p style="color:var(--txt3);font-size:12px">No anchor sites configured.</p>';
  // Each holiday block (name+year+group) = 1 assignment regardless of how many
  // dates it spans. A multi-day holiday like Thanksgiving shouldn't count 4x.
  const hc={};
  const _hcSeen=new Set();
  S.holidays.forEach(h=>{
    const key=`${h.physId}|${h.name}|${h.year}|${h.group}`;
    if(_hcSeen.has(key)) return;
    _hcSeen.add(key);
    if(!hc[h.physId])hc[h.physId]=0;
    hc[h.physId]++;
  });
  document.getElementById('dash-hols').innerHTML=Object.entries(hc).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([id,n])=>
    `<div class="row"><span style="flex:1;font-size:12px">${pnameHtml(+id)}</span><span class="tag tp">${n} holidays</span></div>`
  ).join('')||'<p style="color:var(--txt3);font-size:12px">None recorded.</p>';
  document.getElementById('dash-open').innerHTML=S.openShifts.filter(o=>!o.claimedBy).slice(0,4).map(o=>
    `<div class="row" style="cursor:pointer" onclick="nav('open-shifts',document.querySelector('[onclick*=open-shifts]'))">
      <span style="font-size:12px;flex:1">${o.date}</span><span class="tag ta">${o.shiftType}</span>
      <span style="color:var(--txt3);font-size:11px">${o.sub||''}</span></div>`
  ).join('')||'<p style="color:var(--green-t);font-size:12px">All covered!</p>';
  document.getElementById('dash-vac').innerHTML=S.vacations.filter(v=>v.start>=ym+'-01').sort((a,b)=>a.start>b.start?1:-1).slice(0,4).map(v=>
    `<div class="row"><span style="flex:1;font-size:12px">${pnameHtml(v.physId)}</span><span class="tag tr">${v.type}</span><span style="color:var(--txt3);font-size:11px">${v.start}</span></div>`
  ).join('')||'<p style="color:var(--txt3);font-size:12px">None upcoming.</p>';
  if(isAdm){
    const drA=document.getElementById('dash-anc-mo');if(drA)drA.textContent=monthName;
    const drR=document.getElementById('dash-dr-recent');
    if(drR)drR.innerHTML=S.drShifts.filter(s=>s.date.startsWith(ym)).slice(0,5).map(s=>{
      const cls=s.shift==='1st'?'tb':s.shift==='2nd'?'tg':s.shift==='3rd'?'ta':'tpk';
      return`<div class="row"><span style="font-size:12px;flex:1">${pnameHtml(s.physId)}</span><span class="tag ${cls}">${s.shift}</span><span style="color:var(--txt3);font-size:11px">${s.date.slice(5)}</span></div>`;
    }).join('')||'<p style="color:var(--txt3);font-size:12px">No shifts.</p>';
    const irR=document.getElementById('dash-ir-recent');
    if(irR)irR.innerHTML=S.irCalls.filter(c=>c.date.startsWith(ym)).slice(0,5).map(c=>{
      const cls=irGroupColorClass(c.irGroup);
      return`<div class="row"><span style="font-size:12px;flex:1">${pnameHtml(c.physId)}</span><span class="tag ${cls}">${c.irGroup}</span><span style="color:var(--txt3);font-size:11px">${c.date.slice(5)} ${c.callType}</span></div>`;
    }).join('')||'<p style="color:var(--txt3);font-size:12px">No IR calls.</p>';
  }
}
