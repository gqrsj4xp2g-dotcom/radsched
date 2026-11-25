// Settings stores five weekly profiles. A sixth calendar row uses the final
// profile, including specialty requirements from practices using weekly data.
function _drSlotWeek(date){
  return Math.min(5, getWeek(date, date.slice(0,7)));
}

function _drAutoDatesFree(physId, dates){
  const away = _awayDays(physId);
  return dates.every(date => !away.has(date) && !_physBookingsOnDate(physId, date).length);
}

function _drAutoRulesOk(p, ctx){
  return natLangRulesOk(ctx) && tbRulesOk(p, ctx) && callDayRulesOk(p, ctx);
}

function previewAA(){
  if(!_adminOnly('preview auto-assign')) return;
  const ym=document.getElementById('aa-mo').value||_todayLocalYM();
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
  drs.forEach(p=>{ effTarget[p.id]=drEffectiveTarget(p,ym); });
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
      const rA=cnt[a.id].wd/Math.max(1,effTarget[a.id]), rB=cnt[b.id].wd/Math.max(1,effTarget[b.id]);
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
      const wk=_drSlotWeek(c.date);
      // TWO-PHASE FILL (2026-07): subspecialty slots fill FIRST across ALL
      // sites/shifts for the day, then general slots — so a scarce specialist
      // can't be consumed by one site's general slot while another site's
      // subspecialty slot goes unfilled. Sub-holders whose specialty slots
      // are already covered overflow into general slots in phase 2 (the
      // general pool has no sub restriction).
      ['sub','any'].forEach(_subPhase=>{
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

          fillList.filter(f=>_subPhase==='sub'?!!f.targetSub:!f.targetSub).forEach(({targetSub, slotIndex}) => {
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
              if(!_drAutoDatesFree(p.id,[c.date]))return false;
              if(_has2ndOr3rdShift(p.id,c.date))return false;
              if(preview.some(a=>a.physId===p.id&&a.date===c.date))return false;
              const assumedSub = targetSub || p.drSubs?.[0] || '';
              const _ctx={physId:p.id,date:c.date,site:st.name,shift:sh,sub:assumedSub,kind:'dr-shift'};
              if(!_drAutoRulesOk(p,_ctx))return false;
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
      });   // end sub→any phase loop
      // Fill configured remote positions first, then eligible physicians who
      // still need weekday work. Both use exactly the same eligibility rules.
      const homeSite='At Home / Remote';
      const homeNeed=Number(S.siteSlots[`${homeSite}|${wk}|Home`])||0;
      let homeCount=S.drShifts.filter(s=>s.date===c.date && s.shift==='Home' && (!s.site || s.site===homeSite)).length;
      const homePool=drs.filter(p=>{
        if(!p.shiftElig?.home || cnt[p.id].wd>=effTarget[p.id])return false;
        if(preview.some(a=>a.physId===p.id && a.date===c.date))return false;
        if(!_drAutoDatesFree(p.id,[c.date]))return false;
        const ctx={physId:p.id,date:c.date,site:homeSite,shift:'Home',sub:p.drSubs?.[0]||'',kind:'dr-shift'};
        return _drAutoRulesOk(p,ctx);
      });
      for(const p of sortByDeficit(homePool,homeSite,c.date,'Home','dr-shift')){
        const slotLabel=homeCount<homeNeed ? (S.siteSlotLabels||{})[`${homeSite}|Home|#${homeCount}`]||'' : '';
        preview.push({type:'home',physId:p.id,date:c.date,shift:'Home',site:homeSite,sub:p.drSubs?.[0]||'',notes:'Auto-home',autoHome:true,slotLabel});
        cnt[p.id].wd++;
        cnt[p.id].home++;
        homeCount++;
      }
      let posted=S.openShifts.filter(o=>!o.claimedBy && o.date===c.date && o.site===homeSite && o.shiftType==='Home Shift').length;
      for(let i=homeCount;i<homeNeed;i++){
        gaps.push(`${c.date} ${homeSite} Home`);
        if(posted>0){ posted--; continue; }
        S.openShifts.push({id:S.nextId++,date:c.date,shiftType:'Home Shift',sub:'',site:homeSite,group:'DR',claimedBy:null,notes:''});
      }
    });
  }
  if(typ==='weekend'||typ==='both'){
    const excludedWeekends = []; // {satDate, matchedDate, reason} for diagnostic output
    cells.filter(c=>c.day&&c.dow===6).forEach(c=>{
      // HOLIDAY WEEKENDS are excluded from the auto-builder up front: if
      // EITHER Saturday or Sunday is a defined holiday, holiday call covers
      // that whole weekend — regular weekend call must not be assigned (or
      // gaps posted) for it. A Friday-before or Monday-after holiday does
      // NOT affect the Sat–Sun weekend by itself unless the holiday block's
      // dates include a weekend day. The Holiday Definitions tab (with the
      // federal-holiday fallback) is authoritative for what's a holiday.
      const sunDate = addDays(c.date, 1);
      const satIsHoliday = isHolidayBlackout(c.date);
      const sunIsHoliday = isHolidayBlackout(sunDate);
      if(satIsHoliday || sunIsHoliday){
        const reason = _holidayReasonFor(satIsHoliday ? c.date : sunDate);
        excludedWeekends.push({satDate: c.date, matchedDate: satIsHoliday ? c.date : sunDate, reason, allHoliday: satIsHoliday && sunIsHoliday});
        return;
      }
      // 2026-07 redesign: each needed slot is TWO shifts (day + swing);
      // SUBSPECIALTY slots fill BEFORE general ('') slots so specialty
      // coverage is staffed first; needs come from the per-weekend override
      // merged over the global defaults, and the configured COUNT is honored
      // (the old pass hard-capped at 1 and even assigned subs with need=0).
      const _needEntries=Object.entries(_wkndNeedsFor(c.date))
        .filter(([,need])=>(_wkndNeedCount(need,'day')+_wkndNeedCount(need,'swing'))>0)
        .sort((a,b)=>(a[0]===''?1:0)-(b[0]===''?1:0));   // subs first, general last
      const _yr=c.date.slice(0,4);
      _needEntries.forEach(([sub,need])=>{
        ['day','swing'].forEach(wshift=>{
          let ex=S.weekendCalls.filter(w=>(w.satDate||w.date)===c.date&&(w.sub||'')===sub&&((w.wshift||'day')===wshift)).length
                +preview.filter(a=>a.type==='wk'&&(a.satDate||a.date)===c.date&&(a.sub||'')===sub&&((a.wshift||'day')===wshift)).length;
          while(ex<_wkndNeedCount(need,wshift)){
            const pool=drs.filter(p=>{
              if(!p.shiftElig.wknd)return false;
              // Diagnostic weekend call keys on DAY-shift DR FTE: a 2nd/3rd-
              // shift-only radiologist (day FTE 0) gets no weekend call.
              if(_drDayFte(p)<=0)return false;   // daytime DR FTE required for ALL weekend call (2026-07-31: no swing exception)
              if(sub&&!p.drSubs.includes(sub))return false;
              // Non-Eastern physicians (by home address) work SWING only —
              // their local hours align with the swing shift, not day.
              if(wshift==='day'&&!_wkndDayOk(p))return false;
              if(!_drAutoDatesFree(p.id,[c.date,sunDate]))return false;
              // Same physician shouldn't hold two shifts the same weekend
              if(preview.some(a=>a.type==='wk'&&(a.satDate||a.date)===c.date&&a.physId===p.id))return false;
              // No back-to-back weekend call — inherent to ALL weekend
              // assignment (matches the IR rule + the manual-add block).
              if(typeof _hasAdjacentWeekend==='function'&&_hasAdjacentWeekend(p.id,c.date))return false;
              if(preview.some(a=>a.type==='wk'&&a.physId===p.id&&_daysBetween(a.satDate||a.date,c.date)===7))return false;
              // Summer cap: ≤ N weekends Jun 1 – Aug 31 (default 2)
              if(_wkndIsSummer(c.date)&&_wkndSummerCount(p.id,_yr,preview)>=_wkndSummerCapFor(p,_yr))return false;
              // Yearly cap × DR FTE × part of the start year on staff (unset = no cap)
              const _yc=_wkndYearCap(p,_yr);
              if(_yc!=null&&_wkndYearCount(p.id,_yr,preview)>=_yc)return false;
              const _wkCap=p.seqRules?.maxWkCalls||maxDR(p,'wk');
              const _wkctx={physId:p.id,date:c.date,site:'',shift:'wknd',sub,kind:'dr-weekend'};
              if(!_drAutoRulesOk(p,_wkctx))return false;
              return cnt[p.id].wk<_wkCap;
            }).sort((a,b)=>{
              const rA=cnt[a.id].wk/maxDR(a,'wk'), rB=cnt[b.id].wk/maxDR(b,'wk');
              if(Math.abs(rA-rB)>0.005) return rA-rB;
              return cnt[b.id].wk-cnt[a.id].wk;
            });
            if(pool.length){
              const p=pool[0];
              preview.push({type:'wk',physId:p.id,satDate:c.date,sunDate,sub,site:'',ctype:'Primary',wshift,notes:'Auto'});
              cnt[p.id].wk++;
            } else {
              // No candidates — post EVERY remaining unfilled slot of this
              // sub+shift to the shift market (not just the first), deduped
              // against unclaimed posts already there so re-previewing never
              // double-posts, then stop looping the same empty pool.
              let _osDup=(S.openShifts||[]).filter(o=>o.shiftType==='Weekend Call'&&!o.claimedBy&&o.date===c.date&&(o.sub||'')===sub&&(o.wshift||(o.notes==='Swing shift'?'swing':'day'))===wshift).length;
              for(let miss=ex;miss<_wkndNeedCount(need,wshift);miss++){
                gaps.push(`Weekend ${c.date} ${sub||'General'} (${wshift})`);
                if(_osDup>0){ _osDup--; continue; }
                S.openShifts.push({id:S.nextId++,date:c.date,shiftType:'Weekend Call',sub,site:'At Home / Remote',group:'DR',claimedBy:null,wshift,notes:wshift==='swing'?'Swing shift':'Day shift'});
              }
              break;
            }
            ex++;
          }
        });
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
      <strong>🏖 ${excluded.length} holiday weekend${excluded.length>1?'s':''} skipped (Sat or Sun is a defined holiday)</strong> — covered by Holiday Auto-Assign:
      <div style="margin-top:6px;font-family:monospace;line-height:1.6;max-height:120px;overflow-y:auto">
        ${excluded.map(x=>{
          const name = x.reason?.name || '—';
          return `Sat ${escHtml(x.satDate)} + Sun ${escHtml(addDays(x.satDate,1))} → both part of "${escHtml(name)}" (Holiday Call → Define Holidays)`;
        }).join('<br>')}
      </div>
    </div>`;
  }

  // ── FTE Attainment Table ──────────────────────────────────────────────────
  html+=`<div class="card mb10" >
    <div class="card-title" style="font-size:12px">FTE Attainment — ${new Date(ym+'-01').toLocaleString('default',{month:'long',year:'numeric'})}
      <span style="font-size:10px;font-weight:400;color:var(--txt3);margin-left:6px">Targets adjusted for vacation/blackout days</span>
    </div>
    <div class="scroll-x"><table><thead><tr>
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
    const vdCount=_awayDays(p.id);
    const availDays=buildCal(ym).filter(c=>c.day&&!c.isWknd&&!isHolidayBlackout(c.date)&&!vdCount.has(c.date)).length;
    const wkExist=wkCnt(p.id,ym);
    const wkNew=preview.filter(a=>a.physId===p.id&&a.type==='wk').length;
    const wkTgt=maxDR(p,'wk');
    html+=`<tr>
      <td class="fw6">${pnameHtml(p.id)}</td>
      <td class="tac">${p.drFte}</td>
      <td class="tac txt3">${availDays}</td>
      <td class="tac txt3">${existing}</td>
      <td style="text-align:center;color:var(--teal-t)">+${newShifts}</td>
      <td class="tac fw7">${total}</td>
      <td class="tac txt3">${tgt}</td>
      <td style="text-align:center;font-weight:800;color:${pctColor}">${pct}%</td>
      ${typ!=='weekday'?`<td class="tac">${wkExist+wkNew}</td><td class="tac txt3">${wkTgt}</td>`:''}
    </tr>`;
  });
  html+=`</tbody></table></div></div>`;

  if(hospPrev.length+wkPrev.length>0){
    html+='<div class="scroll-x"><table><thead><tr><th>Physician</th><th>Date</th><th>Type</th><th>Site</th><th>Anchor?</th></tr></thead><tbody>';
    [...hospPrev,...wkPrev].slice(0,30).forEach(a=>{
      const p=_physById(a.physId);
      const site=a.site||''; const isAnc=p?.anchorSite===site;
      html+=`<tr><td>${pnameHtml(a.physId)}</td><td>${a.satDate||a.date}</td><td><span class="tag ${a.type==='wk'?'tg':'tb'}">${a.type==='wk'?'Weekend':a.shift}</span></td><td>${site}</td><td>${isAnc?'<span class="tag tg">✓</span>':'—'}</td></tr>`;
    });
    if(hospPrev.length+wkPrev.length>30) html+=`<tr><td colspan="5" class="txt3">...and ${hospPrev.length+wkPrev.length-30} more</td></tr>`;
    html+='</tbody></table></div>';
  }
  if(homePrev.length) html+=`<div class="note ni mt8" >+ ${homePrev.length} at-home fills for unscheduled DR physicians.</div>`;
  if(gaps.length) html+=`<div class="note nw mt8" >${gaps.length} gap(s) — open shifts created.</div>`;
  document.getElementById('aa-box').innerHTML=html;
  document.getElementById('aa-apply').style.display=preview.length?'inline-block':'none';
}function applyAA(){
  if(!_adminOnly('apply auto-assign'))return;
  if(!S.aaPreview.length){ if(typeof _toast==='function') _toast('Run Preview first to see what will be assigned.','info'); return; }
  const toApply=[...S.aaPreview];
  S.aaPreview=[];
  let applied=0;
  toApply.forEach(a=>{
    const p=_physById(a.physId);
    const weekend=a.type==='wk';
    const date=a.date||a.satDate;
    const dates=weekend ? [date,a.sunDate||addDays(date,1)] : [date];
    const ctx={physId:a.physId,date,site:a.site||'',shift:weekend?'wknd':a.shift,sub:a.sub||'',kind:weekend?'dr-weekend':'dr-shift'};
    if(!p || !_drAutoDatesFree(p.id,dates) || !_drAutoRulesOk(p,ctx))return;
    const ym=date.slice(0,7);
    if(!weekend && drCnt(p.id,ym)>=drEffectiveTarget(p,ym))return;
    applied++;
    if(weekend)
      S.weekendCalls.push({id:S.nextId++,physId:a.physId,satDate:a.satDate||a.date,sunDate:a.sunDate||addDays(a.satDate||a.date,1),sub:a.sub,site:a.site,ctype:'Primary',wshift:a.wshift||'day',notes:'Auto'});
    else
      S.drShifts.push({id:S.nextId++,physId:a.physId,date:a.date,shift:a.shift,site:a.site,sub:a.sub,notes:a.notes||'Auto',autoHome:!!a.autoHome,slotLabel:a.slotLabel||''});
  });
  triggerSave();
  // Same bug fix as applyIRShiftAA: push the full refresh fan-out
  // so the calendar, dashboard, FTE monitor, fairness scoreboard,
  // and unfilled-slots tab all reflect the new state on subsequent
  // apply runs. Without this, the second-and-later applies looked
  // like they did nothing on the calendar.
  if(typeof _afterMutation === 'function') _afterMutation();
  const skipped=toApply.length-applied;
  document.getElementById('aa-box').innerHTML=`<div class="note ${skipped?'nw':'ns'}">${applied} shifts applied.${skipped?' '+skipped+' skipped after eligibility changed. Run Preview again.':''}</div>`;
  S.aaPreview=[];document.getElementById('aa-apply').style.display='none';
}
