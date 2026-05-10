function previewAA(){
  if(!_adminOnly('preview auto-assign')) return;
  const ym=document.getElementById('aa-mo').value||new Date().toISOString().slice(0,7);
  const typ=document.getElementById('aa-type').value;
  // Build period: 'month' (default), 'semi-1', or 'semi-2'. The half-month
  // options narrow the cell set so admins can fill the schedule in two
  // smaller passes — useful when the second half of the month isn't yet
  // finalized vacation-wise. effTarget intentionally still uses the full
  // month; we don't shrink quotas just because we're filling fewer days,
  // since the next semi-build will pick up where we left off.
  const period = document.getElementById('aa-period')?.value || 'month';
  const preview=[],gaps=[];
  const cells = _filterCellsByPeriod(buildCal(ym), period);
  // DR auto-assign candidate pool: DR-role and MIXED-role physicians with
  // drFte > 0. Previously this filter used `role === 'DR'` which silently
  // excluded MIXED physicians from auto-assign, leaving them out of new
  // schedules even when their drFte called for coverage. Switching to
  // `role !== 'IR'` keeps DR+MIXED in and strict-IR out.
  const drs=S.physicians.filter(p=>p.drFte>0&&p.role!=='IR');
  // Per-physician effective target (vacation-adjusted) for this month
  const effTarget={};
  drs.forEach(p=>{ effTarget[p.id]=drEffectiveTarget(p,ym)||1; });
  // wd = total weekday DR shifts, home = subset that are Home shifts. The
  // home count powers the home/in-person preference tiebreaker in
  // sortByDeficit so we can compare current Home% to p.drHomePctPref.
  const cnt={};drs.forEach(p=>{cnt[p.id]={wd:drCnt(p.id,ym),wk:wkCnt(p.id,ym),home:drHomeCnt(p.id,ym)};});

  // Anchor % target — from Settings. When a physician is below this rate at
  // their anchor site, they get a ranked boost toward assignments there.
  const ANC_PCT = (S.cfg?.anchorPct ?? 70) / 100;
  // Count existing hospital shifts at anchor site for each physician
  const ancCnt = {}, ancTot = {};
  drs.forEach(p => {
    ancCnt[p.id] = 0; ancTot[p.id] = 0;
    S.drShifts.filter(s => s.physId===p.id && s.date.startsWith(ym) && s.shift!=='Home').forEach(s => {
      ancTot[p.id]++;
      if(p.anchorSite && s.site === p.anchorSite) ancCnt[p.id]++;
    });
  });

  // Sort comparator: lowest fill-ratio first; break ties by anchor fit driven
  // by the anchorPct setting; then by highest deficit.
  // sortByDeficit: orders the candidate pool for a given site, with optional
  // date/shift/kind context so conference-preference rules can nudge order.
  // The conference preference (negative score = preferred) only kicks in
  // when there are no stronger differentiators (anchor pressure, fill%) —
  // it's a final tiebreaker that respects "schedule day shift N days
  // before/after my tumor board" preferences without overriding fairness.
  function sortByDeficit(pool, site, ctxDate, ctxShift, ctxKind){
    const wantPref = !!(ctxDate && ctxKind);
    // Pre-compute whether the current slot is Home so the preference scorer
    // below knows which direction to nudge.
    const isHomeSlot = ctxShift === 'Home';
    const isInPersonSlot = ctxShift === '1st' || ctxShift === '2nd' || ctxShift === '3rd';
    // Returns a score where LOWER = sort earlier. 0 = neutral. Driven by the
    // physician's drHomePctPref (0-100, target % Home of total DR shifts).
    // For a Home slot, physicians UNDER their home target (need more home)
    // get a negative score and sort first. For an in-person slot, physicians
    // OVER their home target (need more in-person) get a negative score.
    const homePrefScore = (p) => {
      if(p.drHomePctPref == null) return 0;            // no preference set
      if(!isHomeSlot && !isInPersonSlot) return 0;     // not a Home/in-person slot
      const total = cnt[p.id].wd;
      if(total <= 0) return 0;                          // no data yet — let normal sort decide
      const target = (+p.drHomePctPref) / 100;
      const currentHome = (cnt[p.id].home || 0) / total;
      const distance = currentHome - target;            // + = over-home, - = under-home
      return isHomeSlot ? distance : -distance;
    };
    return pool.slice().sort((a,b)=>{
      const rA=cnt[a.id].wd/effTarget[a.id], rB=cnt[b.id].wd/effTarget[b.id];
      if(Math.abs(rA-rB)>0.005) return rA-rB; // lowest fill% first
      // Home/in-person preference — only kicks in for physicians who set
      // drHomePctPref. 5% threshold prevents micro-fluctuations from
      // overriding the more important anchor / conference signals below.
      const hpA = homePrefScore(a), hpB = homePrefScore(b);
      if(Math.abs(hpA - hpB) > 0.05) return hpA - hpB;
      // Anchor target pressure — physicians below the anchorPct% target at their
      // anchor site get preference when the assignment IS their anchor site.
      // This actively drives the setting's value into the scheduling decision.
      const aRate = ancTot[a.id]>0 ? ancCnt[a.id]/ancTot[a.id] : 0;
      const bRate = ancTot[b.id]>0 ? ancCnt[b.id]/ancTot[b.id] : 0;
      const aBelow = a.anchorSite===site && aRate < ANC_PCT;
      const bBelow = b.anchorSite===site && bRate < ANC_PCT;
      if(aBelow !== bBelow) return aBelow ? -1 : 1;
      // Prefer anchor site match (regardless of rate)
      const ancA=(a.anchorSite===site?-1:0)+(a.siteRules?.find(r=>r.site===site)?.preferred?-0.5:0);
      const ancB=(b.anchorSite===site?-1:0)+(b.siteRules?.find(r=>r.site===site)?.preferred?-0.5:0);
      if(ancA!==ancB) return ancA-ancB;
      // Conference shift preference — physicians whose tbRules say "schedule
      // day shift N days before/after my tumor board" get a negative score
      // for matching dates so they sort earlier. Only consults preference
      // when caller passed a date/kind; otherwise zero overhead.
      if(wantPref){
        const cctx={physId:a.id, date:ctxDate, shift:ctxShift, kind:ctxKind};
        const dctx={physId:b.id, date:ctxDate, shift:ctxShift, kind:ctxKind};
        const prefA=_conferenceShiftPreferenceFor(a, cctx);
        const prefB=_conferenceShiftPreferenceFor(b, dctx);
        if(prefA !== prefB) return prefA - prefB;  // more-preferred (more negative) sorts first
      }
      return (effTarget[b.id]-cnt[b.id].wd)-(effTarget[a.id]-cnt[a.id].wd); // highest deficit
    });
  }

  if(typ==='weekday'||typ==='both'){
    cells.filter(c=>c.day&&!c.isWknd&&!isHolidayBlackout(c.date)).forEach(c=>{
      const wk=getWeek(c.date,ym);
      S.sites.filter(st=>st.name!=='At Home / Remote').forEach(st=>{
        // Hospital sites now process BOTH '1st' (in-person) and 'Home' (read-
        // from-home attributed to this hospital). The same fillList / sub-
        // breakdown / slot-label machinery handles both — only the eligKey
        // and the shift string differ.
        ['1st','Home'].forEach(sh=>{
          const need=S.siteSlots[`${st.name}|${wk}|${sh}`]||0;if(!need)return;
          const ex=S.drShifts.filter(s=>s.date===c.date&&s.site===st.name&&s.shift===sh).length
                  +preview.filter(a=>a.date===c.date&&a.site===st.name&&a.shift===sh).length;
          let slots=need-ex;if(slots<=0)return;
          // Map shift type → physician shiftElig key. 'home' is added so the
          // hospital-Home pass uses the same Home-eligibility flag that the
          // pseudo-site Home pass below relies on.
          const kMap={s1:'1st',s2:'2nd',s3:'3rd',home:'Home'};const k=Object.entries(kMap).find(([,v])=>v===sh)?.[0];

          // Per-specialty breakdown: if S.siteSlotsSubs[site|wk|sh] is set,
          // build an ordered fill list where each entry targets a specific
          // subspecialty. Remaining slots (total - sum of subs) are "any"
          // slots. If no breakdown configured, all slots are "any".
          //
          // Each fillList entry now also carries a slotIndex so we can attach
          // an admin-set slotLabel from S.siteSlotLabels (per-site, per-shift,
          // stable across weeks). Indexing is sequential within this (site,
          // week, shift) triple — sub-targeted slots get the lower indices,
          // any-slots get the rest. The order is deterministic so re-runs
          // assign the same physician to the same labeled position.
          const subMap = (S.siteSlotsSubs||{})[`${st.name}|${wk}|${sh}`] || {};
          const fillList = []; // each entry: {targetSub, slotIndex}
          let _nextSlotIdx = ex; // first unfilled index = count of already-placed
          Object.entries(subMap).forEach(([targetSub, n]) => {
            const count = +n || 0;
            // Already-placed shifts at this specialty count against the need
            const exSub = S.drShifts.filter(s=>s.date===c.date&&s.site===st.name&&s.shift===sh&&s.sub===targetSub).length
                        + preview.filter(a=>a.date===c.date&&a.site===st.name&&a.shift===sh&&a.sub===targetSub).length;
            for(let i=0; i<count-exSub; i++) fillList.push({targetSub, slotIndex:_nextSlotIdx++});
          });
          // Any remaining slots beyond the sub breakdown
          const anyLeft = slots - fillList.length;
          for(let i=0; i<anyLeft; i++) fillList.push({targetSub: null, slotIndex:_nextSlotIdx++});

          fillList.forEach(({targetSub, slotIndex}) => {
            // Resolve the admin-set slot label for this position, if any
            const _slotLabel = (S.siteSlotLabels||{})[`${st.name}|${sh}|#${slotIndex}`] || '';
            const pool=drs.filter(p=>{
              if(!p.shiftElig[k])return false;
              if(p.allowedSites?.length&&!p.allowedSites.includes(st.name))return false;
              // When a specialty is targeted, filter out physicians who don't have it
              if(targetSub && !(p.drSubs||[]).includes(targetSub)) return false;
              if(!siteRuleOk(p,st.name,ym,c.date,k))return false;
              if(!dayConditionSiteOk(p,st.name,c.date,'dr-shift'))return false;
              if(!sequenceOk(p,c.date,ym,st.name,_slotLabel))return false;
              if(isSoldBackDate(p.id,c.date)&&st.name!=='At Home / Remote')return false;
              const vd=vacDays(p.id);if(vd.has(c.date))return false;
              if(_has2ndOr3rdShift(p.id,c.date))return false;
              if(preview.find(a=>a.physId===p.id&&a.date===c.date))return false;
              // Pre-existing manually-assigned shifts on this date. Previously
              // only the current-preview pool was checked, so auto-assign could
              // double-book a physician who already had a manual shift.
              // For in-person shifts ('1st'/'2nd'/'3rd'): existing Home shifts
              // don't block — auto can displace them with procedure work.
              // For Home shifts: existing Home shifts DO block, otherwise we'd
              // double-assign the same phys to two Home slots on the same day.
              if(sh==='Home'){
                if(S.drShifts.some(s=>s.physId===p.id&&s.date===c.date))return false;
              } else {
                if(S.drShifts.some(s=>s.physId===p.id&&s.date===c.date&&s.shift!=='Home'))return false;
              }
              if((S.irShifts||[]).some(s=>s.physId===p.id&&s.date===c.date&&s.shift!=='Home'))return false;
              // Also block on daily/weekend IR calls so auto-assign doesn't
              // stack a DR day shift on top of call coverage.
              if((S.irCalls||[]).some(ic=>{
                if(ic.physId!==p.id) return false;
                if(ic.callType==='daily') return ic.date===c.date;
                if(ic.callType==='weekend'){
                  return c.date===ic.date||c.date===addDays(ic.date,1)
                       ||c.date===addDays(ic.date,2)||c.date===addDays(ic.date,3);
                }
                return false;
              })) return false;
              const assumedSub = targetSub || p.drSubs?.[0] || '';
              const _ctx={physId:p.id,date:c.date,site:st.name,shift:sh,sub:assumedSub,kind:'dr-shift'};
              if(!natLangRulesOk(_ctx))return false;
              if(!tbRulesOk(p,_ctx))return false;
              if(!callDayRulesOk(p,_ctx))return false;
              return cnt[p.id].wd<effTarget[p.id];
            });
            const sorted=sortByDeficit(pool,st.name,c.date,sh,'dr-shift');
            const p=sorted[0];
            if(!p){
              // Gap messaging includes the specialty when targeted
              const gapLabel = targetSub ? `${c.date} ${st.name} ${sh} (${targetSub})` : `${c.date} ${st.name} ${sh}`;
              gaps.push(gapLabel);
              if(!S.openShifts.find(o=>o.date===c.date&&o.site===st.name&&o.shiftType===sh+' Shift'&&(!targetSub||o.sub===targetSub)))
                S.openShifts.push({id:S.nextId++,date:c.date,shiftType:sh+' Shift',sub:targetSub||'',site:st.name,group:'DR',claimedBy:null,notes:''});
              return;
            }
            // Assigned sub: targeted one if specified, else physician's primary
            const assignSub = targetSub || p.drSubs[0] || '';
            preview.push({type:'wd',physId:p.id,date:c.date,shift:sh,site:st.name,sub:assignSub,notes:'Auto',autoHome:false,slotLabel:_slotLabel});
            cnt[p.id].wd++;
            // Track Home subset separately so the home/in-person preference
            // tiebreaker can compute current Home% mid-run.
            if(sh==='Home') cnt[p.id].home = (cnt[p.id].home||0) + 1;
          });
        });
      });
      // Configured home slots
      const hNeed=S.siteSlots[`At Home / Remote|${wk}|Home`]||0;
      const hEx=S.drShifts.filter(s=>s.date===c.date&&s.shift==='Home').length
               +preview.filter(a=>a.date===c.date&&a.shift==='Home').length;
      if(hNeed-hEx>0){
        const hpool=sortByDeficit(drs.filter(p=>{
          if(!p.shiftElig.home)return false;
          const vd=vacDays(p.id);if(vd.has(c.date))return false;
          if(preview.find(a=>a.physId===p.id&&a.date===c.date))return false;
          const _hctx={physId:p.id,date:c.date,site:'At Home / Remote',shift:'Home',kind:'dr-shift'};
          if(!natLangRulesOk(_hctx))return false;
          if(!tbRulesOk(p,_hctx))return false;
          if(!callDayRulesOk(p,_hctx))return false;
          return cnt[p.id].wd<effTarget[p.id];
        }),'At Home / Remote',c.date,'Home','dr-shift');
        for(let i=0;i<hNeed-hEx;i++){const p=hpool[i];if(!p)break;
          // Home slots are also labeled per-shift, so look up the label
          // for slot index = (already-placed Home count + i for THIS pass).
          const _hSlotIdx = hEx + i;
          const _hSlotLabel = (S.siteSlotLabels||{})[`At Home / Remote|Home|#${_hSlotIdx}`] || '';
          preview.push({type:'home',physId:p.id,date:c.date,shift:'Home',site:'At Home / Remote',sub:p.drSubs[0]||'',notes:'Auto-home',autoHome:true,slotLabel:_hSlotLabel});
          cnt[p.id].wd++;
          cnt[p.id].home = (cnt[p.id].home||0) + 1;}
      }
      // Auto-home: fill ALL remaining physicians up to their effective FTE target
      sortByDeficit(drs,'At Home / Remote',c.date,'Home','dr-shift').forEach(p=>{
        const vd=vacDays(p.id);if(vd.has(c.date))return;
        if(!p.shiftElig.home)return;
        const alreadyDR=S.drShifts.find(s=>s.physId===p.id&&s.date===c.date);
        const alreadyWk=S.weekendCalls.find(w=>w.physId===p.id&&((w.satDate||w.date)===c.date||(w.sunDate)===c.date));
        const alreadyPrev=preview.find(a=>a.physId===p.id&&a.date===c.date);
        if(!alreadyDR&&!alreadyWk&&!alreadyPrev&&cnt[p.id].wd<effTarget[p.id]){
          preview.push({type:'home',physId:p.id,date:c.date,shift:'Home',site:'At Home / Remote',sub:p.drSubs[0]||'',notes:'Auto-home',autoHome:true});
          cnt[p.id].wd++;
          cnt[p.id].home = (cnt[p.id].home||0) + 1;
        }
      });
    });
  }
  if(typ==='weekend'||typ==='both'){
    const excludedWeekends = []; // {satDate, matchedDate, reason} for diagnostic output
    cells.filter(c=>c.day&&c.dow===6).forEach(c=>{
      // Skip a weekend ONLY when BOTH Saturday and Sunday are defined holidays.
      // A single-day holiday (only Sat or only Sun) still needs the OTHER day
      // covered by regular weekend call — holiday call handles the holiday day
      // and weekend call handles the non-holiday day. A Friday-before or
      // Monday-after holiday does NOT affect the Sat-Sun weekend assignment.
      // The Holiday Definitions tab is authoritative for what's a holiday.
      const sunDate = addDays(c.date, 1);
      const satIsHoliday = isHolidayBlackout(c.date);
      const sunIsHoliday = isHolidayBlackout(sunDate);
      if(satIsHoliday && sunIsHoliday){
        const reason = _holidayReasonFor(c.date);
        excludedWeekends.push({satDate: c.date, matchedDate: c.date, reason, allHoliday: true});
        return;
      }
      Object.entries(S.wkndNeeds).forEach(([sub,need])=>{
        const ex=S.weekendCalls.filter(w=>(w.satDate||w.date)===c.date&&w.sub===sub).length
                +preview.filter(a=>a.type==='wk'&&a.date===c.date&&a.sub===sub).length;
        if(ex>=1)return;
        const pool=drs.filter(p=>{
          if(!p.shiftElig.wknd||!p.drSubs.includes(sub))return false;
          const vd=vacDays(p.id);
          if(vd.has(c.date)||vd.has(sunDate))return false;
          const _wkCap=p.seqRules?.maxWkCalls||maxDR(p,'wk');
          const _wkctx={physId:p.id,date:c.date,site:p.anchorSite||p.drSite||'',shift:'wknd',sub,kind:'dr-weekend'};
          if(!natLangRulesOk(_wkctx))return false;
          if(!tbRulesOk(p,_wkctx))return false;
          return cnt[p.id].wk<_wkCap;
        }).sort((a,b)=>{
          const rA=cnt[a.id].wk/maxDR(a,'wk'), rB=cnt[b.id].wk/maxDR(b,'wk');
          if(Math.abs(rA-rB)>0.005) return rA-rB;
          return cnt[b.id].wk-cnt[a.id].wk;
        });
        if(pool.length){const p=pool[0];preview.push({type:'wk',physId:p.id,satDate:c.date,sunDate,sub,site:p.anchorSite||p.drSite,ctype:'Primary',notes:'Auto'});cnt[p.id].wk++;}
        else{gaps.push(`Weekend ${c.date} ${sub}`);S.openShifts.push({id:S.nextId++,date:c.date,shiftType:'Weekend Call',sub,site:'TBD',group:'DR',claimedBy:null,notes:''});}
      });
    });
    // Stash excluded weekends in a module-level var so the UI render can show them
    S._lastAAExcludedHolidayWknds = excludedWeekends;
  }
  S.aaPreview=preview;
  const hospPrev=preview.filter(a=>a.type==='wd');
  const homePrev=preview.filter(a=>a.type==='home');
  const wkPrev=preview.filter(a=>a.type==='wk');
  let html=`<div style="font-weight:700;margin-bottom:8px">${preview.length} assignments — ${gaps.length} gap(s)<br>
    <span style="font-weight:400;font-size:11px;color:var(--txt2)">${hospPrev.length} hospital · ${homePrev.length} at-home · ${wkPrev.length} weekend</span></div>`;

  // Holiday-excluded weekends panel — weekends where BOTH Sat and Sun are defined
  // holidays (no regular weekend call needed; holiday call handles both days).
  const excluded = S._lastAAExcludedHolidayWknds || [];
  if(excluded.length){
    html += `<div class="note ni" style="margin-bottom:10px;font-size:11px">
      <strong>🏖 ${excluded.length} weekend${excluded.length>1?'s':''} skipped (both Sat + Sun are defined holidays)</strong> — fully covered by Holiday Auto-Assign:
      <div style="margin-top:6px;font-family:monospace;line-height:1.6;max-height:120px;overflow-y:auto">
        ${excluded.map(x=>{
          const name = x.reason?.name || '—';
          return `Sat ${escHtml(x.satDate)} + Sun ${escHtml(addDays(x.satDate,1))} → both part of "${escHtml(name)}" (Holiday Call → Define Holidays)`;
        }).join('<br>')}
      </div>
    </div>`;
  }

  // ── FTE Attainment Table ──────────────────────────────────────────────────
  html+=`<div class="card" style="margin-bottom:10px">
    <div class="card-title" style="font-size:12px">FTE Attainment — ${new Date(ym+'-01').toLocaleString('default',{month:'long',year:'numeric'})}
      <span style="font-size:10px;font-weight:400;color:var(--txt3);margin-left:6px">Targets adjusted for vacation/blackout days</span>
    </div>
    <div style="overflow-x:auto"><table><thead><tr>
      <th>Physician</th><th>FTE</th><th>Available Days</th>
      <th>Existing</th><th>+New</th><th>Total</th><th>Target</th><th>Attain %</th>
      ${typ!=='weekday'?'<th>Wknd</th><th>Wknd Target</th>':''}
    </tr></thead><tbody>`;
  drs.forEach(p=>{
    const existing=drCnt(p.id,ym);
    const newShifts=preview.filter(a=>a.physId===p.id&&a.type!=='wk').length;
    const total=existing+newShifts;
    const tgt=effTarget[p.id];
    const pct=tgt>0?Math.round(total/tgt*100):100;
    const pctColor=pct>=95?'var(--green-t)':pct>=80?'var(--amber,#d97706)':'var(--red-t)';
    const vdCount=vacDays(p.id);
    const availDays=buildCal(ym).filter(c=>c.day&&!c.isWknd&&!isHolidayBlackout(c.date)&&!vdCount.has(c.date)).length;
    const wkExist=wkCnt(p.id,ym);
    const wkNew=preview.filter(a=>a.physId===p.id&&a.type==='wk').length;
    const wkTgt=maxDR(p,'wk');
    html+=`<tr>
      <td style="font-weight:600">${pnameHtml(p.id)}</td>
      <td style="text-align:center">${p.drFte}</td>
      <td style="text-align:center;color:var(--txt3)">${availDays}</td>
      <td style="text-align:center;color:var(--txt3)">${existing}</td>
      <td style="text-align:center;color:var(--teal-t)">+${newShifts}</td>
      <td style="text-align:center;font-weight:700">${total}</td>
      <td style="text-align:center;color:var(--txt3)">${tgt}</td>
      <td style="text-align:center;font-weight:800;color:${pctColor}">${pct}%</td>
      ${typ!=='weekday'?`<td style="text-align:center">${wkExist+wkNew}</td><td style="text-align:center;color:var(--txt3)">${wkTgt}</td>`:''}
    </tr>`;
  });
  html+=`</tbody></table></div></div>`;

  if(hospPrev.length+wkPrev.length>0){
    html+='<div style="overflow-x:auto"><table><thead><tr><th>Physician</th><th>Date</th><th>Type</th><th>Site</th><th>Anchor?</th></tr></thead><tbody>';
    [...hospPrev,...wkPrev].slice(0,30).forEach(a=>{
      const p=S.physicians.find(x=>x.id===a.physId);
      const site=a.site||''; const isAnc=p?.anchorSite===site;
      html+=`<tr><td>${pnameHtml(a.physId)}</td><td>${a.satDate||a.date}</td><td><span class="tag ${a.type==='wk'?'tg':'tb'}">${a.type==='wk'?'Weekend':a.shift}</span></td><td>${site}</td><td>${isAnc?'<span class="tag tg">✓</span>':'—'}</td></tr>`;
    });
    if(hospPrev.length+wkPrev.length>30) html+=`<tr><td colspan="5" style="color:var(--txt3)">...and ${hospPrev.length+wkPrev.length-30} more</td></tr>`;
    html+='</tbody></table></div>';
  }
  if(homePrev.length) html+=`<div class="note ni" style="margin-top:8px">+ ${homePrev.length} at-home fills for unscheduled DR physicians.</div>`;
  if(gaps.length) html+=`<div class="note nw" style="margin-top:8px">${gaps.length} gap(s) — open shifts created.</div>`;
  document.getElementById('aa-box').innerHTML=html;
  document.getElementById('aa-apply').style.display=preview.length?'inline-block':'none';
}function applyAA(){
  if(!_adminOnly('apply auto-assign'))return;
  if(!S.aaPreview.length)return;
  const toApply=[...S.aaPreview];
  S.aaPreview=[];
  toApply.forEach(a=>{
    if(a.type==='wk')
      S.weekendCalls.push({id:S.nextId++,physId:a.physId,satDate:a.satDate||a.date,sunDate:a.sunDate||addDays(a.satDate||a.date,1),sub:a.sub,site:a.site,ctype:'Primary',notes:'Auto'});
    else
      S.drShifts.push({id:S.nextId++,physId:a.physId,date:a.date,shift:a.shift,site:a.site,sub:a.sub,notes:a.notes||'Auto',autoHome:!!a.autoHome,slotLabel:a.slotLabel||''});
  });
  triggerSave();document.getElementById('aa-box').innerHTML=`<div class="note ns">${S.aaPreview.length} shifts applied.</div>`;
  S.aaPreview=[];document.getElementById('aa-apply').style.display='none';
}
