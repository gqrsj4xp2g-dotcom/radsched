function previewIRAA(){
  if(!_adminOnly('preview IR auto-assign')) return;

  // ─── INPUTS & SETUP ────────────────────────────────────────────────────
  const months    = _iraMonths();
  const label     = _iraPeriodLabel(months);
  const typ       = document.getElementById('ira-type').value;           // 'daily' | 'weekend' | 'both'
  const grpFilter = document.getElementById('ira-grp')?.value || 'both';
  const period    = document.getElementById('ira-period')?.value || 'H1';

  const preview = [];
  const gaps    = [];

  // Reset holiday-excluded weekend tracker for this run
  S._lastIRAAExcludedHolidayWknds = [];

  const allCells = months.flatMap(ym => _filterCellsByPeriod(buildCal(ym), period));
  const irPs     = S.physicians.filter(p => p.irFte > 0);
  const groups   = getIRGroups().filter(g => grpFilter === 'both' || g === grpFilter);

  // Running counts (existing + preview) used for FTE deficit ordering.
  // Existing counts are pulled from S.irCalls for the entire period so we
  // balance across the full horizon, not just unfilled slots.
  const cntD = {}, cntW = {};
  irPs.forEach(p => {
    cntD[p.id] = months.reduce((s, ym) => s + irDailyCnt(p.id, ym), 0);
    cntW[p.id] = months.reduce((s, ym) => s + irWkndCnt(p.id, ym),  0);
  });
  // Capacity (vacation-adjusted rounded-up targets). Used only for DEFICIT
  // ORDERING and for labeling when someone is "over FTE" — never for hard
  // exclusion. Per user requirement: "Do not schedule any call back to back
  // even if that causes someone to take more call than they have to."
  const dailyCapFn = p => Math.max(Math.ceil(irDailyTargetAdjusted(p, months)), 1);
  const wkndCapFn  = p => Math.max(Math.ceil(irWkndTargetAdjusted(p, months)),  1);

  // ─── HARD ADJACENCY PREDICATES ─────────────────────────────────────────
  // Adjacency checks are strict: a candidate is rejected if it would create
  // ANY back-to-back situation, across both existing assignments and the
  // current preview. Considered sources:
  //   - S.irCalls            (existing daily + weekend IR calls)
  //   - preview              (assignments made earlier in this same run)
  //
  // A "daily call on date D" conflicts with:
  //   • another daily call on D-1 or D+1
  //   • a weekend span whose Fri→Mon includes D-1 or D+1 or D
  //   • a weekend whose Thu-pre is D (i.e. weekend starting D+1)
  //   • a weekend whose Tue-post is D (i.e. weekend starting D-4)
  //
  // A "weekend call starting Friday F" (span F..F+3) conflicts with:
  //   • any call whose date falls in F..F+3 (double-booked)
  //   • a daily call on F-1 (Thu-pre) or F+4 (Tue-post)
  //   • a weekend call whose span overlaps F..F+3 (shouldn't occur — different
  //     physician would have it — but safety)
  //   • another weekend within ±7 days (same physician)
  function _iterCallsFor(pid){
    // Yield every call record (existing + preview) for this physician.
    const out = [];
    for(const c of S.irCalls){ if(c.physId === pid) out.push(c); }
    for(const c of preview){ if(c.physId === pid) out.push(c); }
    return out;
  }
  function _coversDate(c, date){
    // Does call-record c "cover" the given ISO date?
    if(c.callType === 'daily') return c.date === date;
    if(c.callType === 'weekend'){
      // Fri..Mon inclusive (4 days)
      return date >= c.date && date <= addDays(c.date, 3);
    }
    return false;
  }
  function adjacencyReasonDaily(pid, date){
    const calls = _iterCallsFor(pid);
    const prev  = addDays(date, -1);
    const next  = addDays(date,  1);
    for(const c of calls){
      // Same-day overlap
      if(_coversDate(c, date)){
        return c.callType === 'weekend'
          ? `already on weekend call (${c.date}→${addDays(c.date,3)})`
          : `already on daily call this date`;
      }
      // Prev-day adjacency
      if(_coversDate(c, prev)){
        return c.callType === 'weekend'
          ? `back-to-back (weekend call ends ${addDays(c.date,3)})`
          : `back-to-back (daily call on ${prev})`;
      }
      // Next-day adjacency
      if(_coversDate(c, next)){
        return c.callType === 'weekend'
          ? `back-to-back (weekend call starts ${c.date})`
          : `back-to-back (daily call on ${next})`;
      }
      // Thu-pre of a weekend: if candidate is the Thursday before this
      // physician's Friday-weekend, that's back-to-back.
      if(c.callType === 'weekend' && date === addDays(c.date, -1)){
        return `day before their weekend call (Fri ${c.date})`;
      }
      // Tue-post of a weekend: if candidate is the Tuesday after Mon-end.
      if(c.callType === 'weekend' && date === addDays(c.date, 4)){
        return `day after their weekend call (Mon ${addDays(c.date,3)})`;
      }
    }
    return null;
  }
  function adjacencyReasonWeekend(pid, fri){
    const calls = _iterCallsFor(pid);
    const thu   = addDays(fri, -1);
    const tue   = addDays(fri,  4);
    const span  = [fri, addDays(fri,1), addDays(fri,2), addDays(fri,3)];
    for(const c of calls){
      // Overlap within span
      for(const d of span){
        if(_coversDate(c, d)){
          if(c.callType === 'weekend' && c.date === fri) continue; // self
          return c.callType === 'weekend'
            ? `another weekend call covers ${d} (${c.date}→${addDays(c.date,3)})`
            : `daily call on ${d} within the weekend span`;
        }
      }
      // Thu-pre
      if(_coversDate(c, thu)){
        return c.callType === 'weekend'
          ? `weekend call on ${c.date} ends day before`
          : `daily call on Thu-pre (${thu})`;
      }
      // Tue-post
      if(_coversDate(c, tue)){
        return c.callType === 'weekend'
          ? `weekend call on ${c.date} starts day after`
          : `daily call on Tue-post (${tue})`;
      }
      // Another weekend within ±7 days. _daysBetween is DST-safe.
      if(c.callType === 'weekend' && c.date !== fri){
        if(_daysBetween(fri, c.date) <= 7) return `another weekend call within 7 days (${c.date})`;
      }
    }
    return null;
  }

  // ─── ELIGIBILITY EVALUATION ────────────────────────────────────────────
  // Returns null if the physician is eligible, or a human-readable reason
  // string if blocked. `kind` ∈ {'daily', 'weekend'}.
  // `skipAdjacency` is used only for the "most-constrained date" ordering
  // pass — adjacency is always enforced in the actual pick loop.
  // whyBlocked: returns null if the physician is eligible, or a reason string.
  //   opts.allowRelaxBreakable = true → ignore tbRules flagged with
  //     allowBreakForUnfilledIR. Used during the relaxation retry after a gap.
  //     Adjacency, site rules, vacation, and participation are NEVER relaxed.
  function whyBlocked(p, date, kind, g, skipAdjacency, opts){
    const allowRelax = !!(opts && opts.allowRelaxBreakable);
    const isWkd = (kind === 'weekend');
    const span  = isWkd ? [date, addDays(date,1), addDays(date,2), addDays(date,3)] : [date];
    const ym    = date.slice(0,7);

    // Vacation — any day of span
    const vd = vacDays(p.id);
    for(const d of span) if(vd.has(d)) return 'vacation';
    // Sold-back
    for(const d of span) if(isSoldBackDate(p.id, d)) return 'sold-back';
    // IR call blackout (admin-configured per-physician)
    for(const d of span) if(isIRCallBlackout(p.id, d)) return 'IR call blackout';
    // DR 2nd/3rd shift on any day — physician can't be on call
    for(const d of span) if(_has2ndOr3rdShift(p.id, d)) return '2nd/3rd DR shift that day';
    // Site rule — IR call must be allowed at physician's primary site
    if(!irCallSiteRuleOk(p, p.irSitePrim || '', date)) return 'site rule blocks IR call';
    // Day-of-week condition
    if(!dayConditionSiteOk(p, p.irSitePrim || '', date, 'ir-call')) return 'day-of-week condition';
    // Sequence rule
    if(!sequenceOk(p, date, ym, p.irSitePrim || '', '')) return 'sequence rule';
    // Natural-language rule
    const nlCtx = {
      physId: p.id, date, site: p.irSitePrim || '',
      shift: isWkd ? 'ir-weekend' : 'ir-call',
      kind:  isWkd ? 'ir-weekend' : 'ir-call',
      irGroup: g, ym
    };
    if(!natLangRulesOk(nlCtx)) return 'natural-language rule';
    // Conference rule — check each day of span for configured tbRules.
    // If relaxation is enabled, rules flagged allowBreakForUnfilledIR are
    // ignored (the user explicitly opted-in to breaking them when needed).
    for(const d of span){
      const tbCtx = {
        physId: p.id, date: d, site: p.irSitePrim || '',
        shift: isWkd ? 'ir-weekend' : 'ir-call',
        kind:  isWkd ? 'ir-weekend' : 'ir-call',
        irGroup: g, ym
      };
      if(!tbRulesOk(p, tbCtx, {allowRelaxBreakable: allowRelax})) return 'conference rule (tumor board / clinic)';
    }
    // Implicit tumor-board / clinic participation — block call on any day
    // the physician is an assigned participant of a tumor board or clinic
    // (via allowedPhysIds + rotation gating if enabled). A physician at a
    // conference can't simultaneously field call; admins shouldn't have to
    // configure a per-physician rule for the obvious case.
    //
    // HOWEVER: if the admin has explicitly configured a breakable
    // no-call-on-day tbRule for this physician (or for any conference),
    // that is a direct opt-in to breaking the same invariant this implicit
    // check enforces — and the explicit rule should win. Without this
    // concession, breakable rules never have any effect in practice,
    // because the implicit block short-circuits before the physician can
    // be considered. The only way for breakable to fire was for the
    // physician to NOT be listed as a participant, which defeats the
    // purpose entirely.
    //
    // Semantics: if allowRelax is true AND the physician has ANY no-call-on-day
    // tbRule flagged allowBreakForUnfilledIR that matches the current date,
    // we skip the implicit participation block for that date.
    for(const d of span){
      const participantDates = _conferenceDatesForPhys(p.id, d, d, null);
      if(participantDates && participantDates.has(d)){
        // Check for a matching breakable explicit rule.
        let bypassed = false;
        if(allowRelax){
          const tbRules = p.tbRules || [];
          for(const r of tbRules){
            if(!r || r.action !== 'no-call-on-day') continue;
            if(!r.allowBreakForUnfilledIR) continue;
            // Rule scope: eventId null/undefined = any conference; otherwise
            // must match a specific event that this date is an occurrence of.
            if(r.eventId == null){ bypassed = true; break; }
            const occDates = _conferenceDatesForPhys(p.id, d, d, r.eventId);
            if(occDates && occDates.has(d)){ bypassed = true; break; }
          }
        }
        if(!bypassed) return 'participating in tumor board / clinic that day';
      }
    }
    // Call-day-site rule (direction 2) — if physician has an EXISTING day
    // shift on any date in the span at the wrong site, block.
    if(!callDayRulesOk(p, nlCtx)) return 'call-day site rule (day shift at wrong site)';
    // Adjacency — HARD. Never back-to-back.
    if(!skipAdjacency){
      const adj = isWkd ? adjacencyReasonWeekend(p.id, date) : adjacencyReasonDaily(p.id, date);
      if(adj) return adj;
    }
    return null;
  }

  // ─── SORTING ───────────────────────────────────────────────────────────
  // Primary: FTE deficit (count / cap) — most behind gets picked first.
  // Secondary: prefer physician who already has an IR procedure shift on this
  //            date (they're already at work; call is a smaller imposition).
  // Tertiary: lastname alphabetical for deterministic tie-breaking.
  function sortDaily(pool, date){
    return pool.slice().sort((a, b) => {
      const ra = cntD[a.id] / (dailyCapFn(a) || 1);
      const rb = cntD[b.id] / (dailyCapFn(b) || 1);
      if(Math.abs(ra - rb) > 1e-6) return ra - rb;
      const shA = _hasIRShiftOnDate(a.id, date) ? 0 : 1;
      const shB = _hasIRShiftOnDate(b.id, date) ? 0 : 1;
      if(shA !== shB) return shA - shB;
      return (a.last||'').localeCompare(b.last||'');
    });
  }
  function sortWeekend(pool){
    return pool.slice().sort((a, b) => {
      const ra = cntW[a.id] / (wkndCapFn(a) || 1);
      const rb = cntW[b.id] / (wkndCapFn(b) || 1);
      if(Math.abs(ra - rb) > 1e-6) return ra - rb;
      return (a.last||'').localeCompare(b.last||'');
    });
  }

  // ─── MAIN LOOP ─────────────────────────────────────────────────────────
  groups.forEach(g => {
    const gPhys = irPs.filter(p => p.irGroup === g);
    if(!gPhys.length) return;

    // ── DAILY CALLS — Mon-Thu non-holiday dates ──
    if(typ === 'daily' || typ === 'both'){
      const dailyDates = allCells
        .filter(c => c.dow >= 1 && c.dow <= 4 && !isHolidayBlackout(c.date))
        .map(c => c.date)
        .filter(d => !S.irCalls.find(ic => ic.date === d && ic.irGroup === g && ic.callType === 'daily'));

      // Most-constrained-first ordering (excluding adjacency since that's
      // dynamic based on assignment order).
      const baseCount = {};
      dailyDates.forEach(d => {
        baseCount[d] = gPhys.filter(p => !whyBlocked(p, d, 'daily', g, true)).length;
      });
      dailyDates.sort((a, b) => baseCount[a] - baseCount[b] || (a < b ? -1 : 1));

      for(const date of dailyDates){
        const reasons = {};
        const eligible = [];
        for(const p of gPhys){
          const r = whyBlocked(p, date, 'daily', g, false);
          if(r){ reasons[p.id] = r; continue; }
          eligible.push(p);
        }
        let relaxedPick = false;
        if(!eligible.length){
          // ── Relaxation retry ─────────────────────────────────────────────
          // Primary filter returned no eligible physicians. Retry with
          // allowRelaxBreakable=true, which skips tbRules flagged
          // allowBreakForUnfilledIR. The admin explicitly opted into allowing
          // those rules to be broken when the schedule would otherwise have a
          // hole. Adjacency, participation, and call-day-site rules are NOT
          // relaxed — only the per-rule breakable opt-in.
          for(const p of gPhys){
            const r = whyBlocked(p, date, 'daily', g, false, {allowRelaxBreakable: true});
            if(r) continue;
            eligible.push(p);
          }
          if(eligible.length) relaxedPick = true;
        }
        if(!eligible.length){
          const breakdown = gPhys.map(p => `${p.last}=${reasons[p.id] || 'unknown'}`).join(', ');
          gaps.push(`${date} ${g} [${breakdown}]`);
          continue;
        }
        const picked   = sortDaily(eligible, date)[0];
        const overFte  = cntD[picked.id] >= dailyCapFn(picked);
        const noteBits = [];
        if(overFte) noteBits.push('over FTE target');
        if(relaxedPick) noteBits.push('conference rule relaxed');
        preview.push({
          physId: picked.id, date, callType: 'daily', irGroup: g, site: '',
          notes: noteBits.length ? `Auto (${noteBits.join(' · ')})` : 'Auto',
          needsProcShift: !_hasIRShiftOnDate(picked.id, date),
          _overFte: overFte,
          _relaxedBreakable: relaxedPick,
        });
        cntD[picked.id]++;
      }
    }

    // ── WEEKEND CALLS — Fridays; skip all-holiday spans ──
    if(typ === 'weekend' || typ === 'both'){
      const excludedWknds = [];
      const wkndDates = allCells.filter(c => c.dow === 5).map(c => c.date)
        .filter(fri => {
          // Skip ONLY when every day of the Fri→Mon span is a defined holiday.
          // Mixed spans (some holiday + some non-holiday) still need an IR
          // weekend call person to cover the non-holiday portion.
          const span = [fri, addDays(fri,1), addDays(fri,2), addDays(fri,3)];
          const allHoliday = span.every(d => isHolidayBlackout(d));
          if(allHoliday){
            const matched = span[0];
            const reason  = _holidayReasonFor(matched);
            excludedWknds.push({ friday: fri, matchedDate: matched, reason, group: g, allHoliday: true });
            return false;
          }
          return true;
        })
        .filter(fri => !S.irCalls.find(ic => ic.date === fri && ic.irGroup === g && ic.callType === 'weekend'));
      S._lastIRAAExcludedHolidayWknds.push(...excludedWknds);

      const baseCount = {};
      wkndDates.forEach(fri => {
        baseCount[fri] = gPhys.filter(p => !whyBlocked(p, fri, 'weekend', g, true)).length;
      });
      wkndDates.sort((a, b) => baseCount[a] - baseCount[b] || (a < b ? -1 : 1));

      for(const fri of wkndDates){
        const reasons = {};
        const eligible = [];
        for(const p of gPhys){
          const r = whyBlocked(p, fri, 'weekend', g, false);
          if(r){ reasons[p.id] = r; continue; }
          eligible.push(p);
        }
        let relaxedPick = false;
        if(!eligible.length){
          // Relaxation retry — see daily loop for rationale.
          for(const p of gPhys){
            const r = whyBlocked(p, fri, 'weekend', g, false, {allowRelaxBreakable: true});
            if(r) continue;
            eligible.push(p);
          }
          if(eligible.length) relaxedPick = true;
        }
        if(!eligible.length){
          const breakdown = gPhys.map(p => `${p.last}=${reasons[p.id] || 'unknown'}`).join(', ');
          gaps.push(`Wknd ${fri} ${g} [${breakdown}]`);
          continue;
        }
        const picked  = sortWeekend(eligible)[0];
        const overFte = cntW[picked.id] >= wkndCapFn(picked);
        const noteBits = [];
        if(overFte) noteBits.push('over FTE target');
        if(relaxedPick) noteBits.push('conference rule relaxed');
        preview.push({
          physId: picked.id, date: fri, callType: 'weekend', irGroup: g, site: '',
          notes: noteBits.length ? `Auto (${noteBits.join(' · ')})` : 'Auto',
          _overFte: overFte,
          _relaxedBreakable: relaxedPick,
        });
        cntW[picked.id]++;
      }
    }
  });

  // ─── TAIL: keep the rest (render) intact ───────────────────────────────

  S.iraPreview=preview;
  const dailyPrev=preview.filter(a=>a.callType==='daily');
  const wkndPrev=preview.filter(a=>a.callType==='weekend');
  // Under the new single-pass algorithm, adjacency is hard-enforced: nothing
  // is ever back-to-back. The only "waivers" possible are:
  //   1. FTE cap — when all eligible physicians are already at or over target,
  //      the least-overrun one is picked anyway to avoid a gap.
  //   2. Breakable conference rule — rules flagged allowBreakForUnfilledIR
  //      are ignored on a relaxation retry when the primary filter can't
  //      fill the slot. Admin explicitly opted in per-rule.
  const overFteFills  = preview.filter(a=>a._overFte).length;
  const relaxedFills  = preview.filter(a=>a._relaxedBreakable).length;

  let html=`<div style="font-weight:700;margin-bottom:8px">${preview.length} call assignments \u2014 ${gaps.length} gap(s) \u2014 ${label}<br>
    <span style="font-weight:400;font-size:11px;color:var(--txt2)">${dailyPrev.length} daily \u00b7 ${wkndPrev.length} weekend`;
  if(overFteFills>0) html+=` \u00b7 <span style="color:var(--red-t);font-weight:700">${overFteFills} over FTE target</span>`;
  if(relaxedFills>0) html+=` \u00b7 <span style="color:var(--amber,#d97706);font-weight:700">${relaxedFills} conference rule relaxed</span>`;
  html+=`</span></div>`;

  if(overFteFills>0)
    html+=`<div class="note nw" style="margin-bottom:8px">&#9888; ${overFteFills} slot(s) assigned to a physician already at or over their FTE target \u2014 no other eligible physician was available. Back-to-back and rule violations were NOT waived (per hard-rule policy). Review before applying.</div>`;
  if(relaxedFills>0)
    html+=`<div class="note nw" style="margin-bottom:8px;background:#fef3c7;border-color:#d97706">&#9888; ${relaxedFills} slot(s) filled by relaxing a conference rule explicitly flagged <em>"allow break if IR schedule has unfilled slots"</em>. The assigned physician has a conference that day but admin opted-in to breaking the rule when needed to avoid gaps. Review before applying.</div>`;

  // Holiday-excluded weekends panel — IR weekends skipped only when EVERY day of
  // the Fri→Mon span is a defined holiday. Mixed spans (some holiday + some non-
  // holiday) still get a weekend call assignment for the non-holiday coverage.
  const irExcluded = S._lastIRAAExcludedHolidayWknds || [];
  if(irExcluded.length){
    // Group by irGroup for a cleaner breakdown
    const byGroup = {};
    irExcluded.forEach(x => {
      const g = x.group || '—';
      (byGroup[g] = byGroup[g] || []).push(x);
    });
    html += `<div class="note ni" style="margin-bottom:10px;font-size:11px">
      <strong>🏖 ${irExcluded.length} IR weekend${irExcluded.length>1?'s':''} skipped (entire Fri→Mon span is holiday)</strong> — fully covered by Holiday Auto-Assign:
      <div style="margin-top:6px;font-family:monospace;line-height:1.6;max-height:140px;overflow-y:auto">
        ${Object.entries(byGroup).map(([g, xs]) => `
          <div style="margin-top:4px"><strong style="font-family:sans-serif">${escHtml(g)}:</strong></div>
          ${xs.map(x => {
            const name = x.reason?.name || '—';
            return `&nbsp;&nbsp;Fri ${escHtml(x.friday)} → all 4 days of Fri→Mon span are in "${escHtml(name)}" (Holiday Call → Define Holidays)`;
          }).join('<br>')}
        `).join('')}
      </div>
    </div>`;
  }

  if(preview.length){
    html+='<div style="overflow-x:auto"><table><thead><tr><th>Physician</th><th>Group</th><th>Date</th><th>Type</th><th>Covers</th></tr></thead><tbody>';
    preview.slice(0,60).forEach(a=>{
      const dates=a.callType==='weekend'?`${a.date} \u2192 ${addDays(a.date,3)}`:a.date;
      const gSites=S.sites.filter(s=>s.irGroup===a.irGroup||s.irGroup==='Both').map(s=>s.name.split(' ')[0]).join(', ');
      const coverLbl=a.callType==='daily'?`All ${a.irGroup} sites (${gSites})`:a.site;
      const rowStyle = a._overFte ? 'background:var(--red-bg,#fef2f2)'
                     : a._relaxedBreakable ? 'background:#fef3c7'
                     : '';
      let passBadge = '';
      if(a._overFte) passBadge += `<span class="tag tr" style="font-size:9px;margin-left:4px" title="Assigned over FTE target — no other eligible physician">over FTE</span>`;
      if(a._relaxedBreakable) passBadge += `<span class="tag ta" style="font-size:9px;margin-left:4px;background:#fde68a;color:#92400e" title="Conference rule broken — no other eligible physician and rule was flagged breakable">rule relaxed</span>`;
      html+=`<tr style="${rowStyle}">
        <td>${pnameHtml(a.physId)}${passBadge}</td>
        <td><span class="tag ${irGroupColorClass(a.irGroup)}">${a.irGroup}</span></td>
        <td>${dates}</td>
        <td><span class="tag ${a.callType==='weekend'?'tpk':'tt'}">${a.callType}</span></td>
        <td style="font-size:11px;color:var(--txt2)">${coverLbl}</td></tr>`;
    });
    if(preview.length>60) html+=`<tr><td colspan="5" style="color:var(--txt3)">...and ${preview.length-60} more</td></tr>`;
    html+='</tbody></table></div>';
  }

  const tally=[];
  irPs.filter(p=>grpFilter==='both'||p.irGroup===grpFilter).forEach(p=>{
    const newD=dailyPrev.filter(a=>a.physId===p.id).length;
    const newW=wkndPrev.filter(a=>a.physId===p.id).length;
    const totD=cntD[p.id]||0,totW=cntW[p.id]||0;
    const tgtD=irDailyTargetAdjusted(p,months)||irDailyTargetPeriod(p,months);
    const tgtW=irWkndTargetAdjusted(p,months)||irWkndTargetPeriod(p,months);
    const pctD=tgtD>0?Math.round(totD/tgtD*100):0;
    const pctW=tgtW>0?Math.round(totW/tgtW*100):0;
    tally.push({p,newD,newW,totD,totW,tgtD,tgtW,pctD,pctW});
  });
  if(tally.length){
    html+=`<div class="card" style="margin-top:10px"><div class="card-title" style="font-size:12px">FTE Distribution \u2014 ${label}
      <span style="font-size:10px;font-weight:400;color:var(--txt3);margin-left:6px">Targets = finite slots \u00f7 group FTE \u00d7 physician FTE</span>
    </div>
      <table style="font-size:11px"><thead><tr><th>Physician</th><th>FTE</th>
        <th>Daily +new</th><th>Daily total</th><th>6-mo target</th><th>Daily %</th>
        <th>Wknd +new</th><th>Wknd total</th><th>6-mo target</th><th>Wknd %</th>
      </tr></thead><tbody>`;
    tally.forEach(({p,newD,newW,totD,totW,tgtD,tgtW,pctD,pctW})=>{
      const dCls=pctD>110?'color:var(--red-t)':pctD>=80?'color:var(--green-t)':'color:var(--txt2)';
      const wCls=pctW>110?'color:var(--red-t)':pctW>=80?'color:var(--green-t)':'color:var(--txt2)';
      html+=`<tr>
        <td style="font-weight:600">${p.last}</td>
        <td style="text-align:center">${p.irFte}</td>
        <td style="text-align:center;color:var(--teal-t)">+${newD}</td>
        <td style="text-align:center">${totD}</td>
        <td style="text-align:center;color:var(--txt3)">${tgtD.toFixed(1)}</td>
        <td style="text-align:center;font-weight:700;${dCls}">${pctD}%</td>
        <td style="text-align:center;color:var(--teal-t)">+${newW}</td>
        <td style="text-align:center">${totW}</td>
        <td style="text-align:center;color:var(--txt3)">${tgtW.toFixed(1)}</td>
        <td style="text-align:center;font-weight:700;${wCls}">${pctW}%</td>
      </tr>`;
    });
    html+='</tbody></table></div>';
  }

  if(gaps.length){
    // Show ALL gaps with their physician-by-physician breakdown so the admin
    // can see exactly what's blocking each. Legitimate blocks like vacation
    // or blackout mean those slots genuinely can't be filled. "FTE cap reached"
    // showing up only means the cap-waiver pass didn't run (shouldn't happen).
    html+=`<div class="note nw" style="margin-top:8px">
      <strong>\u26a0 ${gaps.length} uncoverable gap(s) \u2014 no eligible physician even with all constraints waived.</strong>
      <div style="margin-top:6px;font-size:11px;font-family:monospace;line-height:1.7;max-height:240px;overflow-y:auto">
        ${gaps.map(g=>escHtml(g)).join('<br>')}
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--txt3)">
        Reason codes per physician: <strong>vacation</strong>, <strong>sold-back</strong>, <strong>blackout</strong> (IR call blackout), <strong>2nd/3rd DR shift</strong>, <strong>already on IR this date</strong>, <strong>nearby weekend call</strong>, <strong>adjacent call</strong>, <strong>day condition</strong>, <strong>sequence rule</strong>, <strong>natural-language rule</strong>.
      </div>
    </div>`;
  }
  if(!preview.length&&!gaps.length)
    html='<div class="note ns">All IR call slots already filled for this period.</div>';

  document.getElementById('ira-box').innerHTML=html;
  document.getElementById('ira-apply').style.display=preview.length?'inline-block':'none';
}

function applyIRAA(){
  if(!_adminOnly('apply IR auto-assign'))return;
  if(!S.iraPreview.length)return;
  const toApply=[...S.iraPreview];
  S.iraPreview=[];
  let procShiftsAdded=0;
  let procShiftsSkipped=0;
  const skippedLog=[];
  toApply.forEach(a=>{
    S.irCalls.push({id:S.nextId++,physId:a.physId,date:a.date,callType:a.callType,irGroup:a.irGroup,site:a.site,notes:'Auto'});
    // Auto-create a 1st proc shift for daily calls where physician had none scheduled.
    // CRITICAL: if the physician has callDayRules that pin them to a specific
    // site when on call (e.g. "Greene: IR call → must be at CHN"), we MUST
    // honor that. Using irSitePrim blindly (Riverview for Greene) creates a
    // shift that directly violates the rule we just created the call against.
    if(a.callType==='daily'&&a.needsProcShift&&!_hasIRShiftOnDate(a.physId,a.date)){
      const p=S.physicians.find(x=>x.id===a.physId);
      if(!p) return;
      // ── 1. Figure out which sites are rule-valid for this phys+call combo.
      //
      // A site is a valid candidate if BOTH directions of callDayRulesOk
      // pass when we put the physician there with an IR 1st shift AND the
      // call we're about to create on the same date. We simulate this by
      // calling callDayRulesOk with kind='ir-shift' and a ctx.site of each
      // candidate; the rules evaluate against the already-created call (we
      // pushed above) so direction 1 fires correctly.
      //
      // We also enforce the site's own rules (site.irAnchors / fillins /
      // allowedSites) and existing IR shift eligibility (site rule, day
      // condition) so the auto-shift isn't itself invalid for some other
      // reason.
      const candidateSites = [];
      const primSite = p.irSitePrim || '';
      // Build candidate list: primary first, then group sites, then any
      // site listed as valid by rule (deduplicated).
      const seen = new Set();
      function _push(siteName){
        if(!siteName || seen.has(siteName)) return;
        seen.add(siteName);
        candidateSites.push(siteName);
      }
      _push(primSite);
      // Check if callDayRules explicitly require a specific site for this callType —
      // if yes, prioritize that site.
      (p.callDayRules||[]).forEach(r => {
        if(!r || !r.requiredSite) return;
        const ct = r.callType || 'any-call';
        // This call is 'ir-call' (daily). Match 'any-call' or 'ir-call'.
        if(ct !== 'any-call' && ct !== 'ir-call') return;
        // If rule has a shift filter that excludes 1st, skip it.
        if(r.shift && r.shift !== '1st') return;
        // Put requiredSite FIRST — highest priority.
        candidateSites.unshift(r.requiredSite);
        seen.add(r.requiredSite);
      });
      // Then all sites in the phys's group.
      (S.sites||[]).forEach(s => {
        if(s.irGroup === a.irGroup || s.irGroup === 'Both') _push(s.name);
      });
      // Dedup while preserving order (requiredSite-prioritized → primary → group)
      const orderedCandidates = [];
      const seen2 = new Set();
      candidateSites.forEach(s => {
        if(s && !seen2.has(s)){ seen2.add(s); orderedCandidates.push(s); }
      });
      // ── 2. Pick the first candidate that passes all rule checks.
      let chosenSite = null;
      for(const siteName of orderedCandidates){
        const ctx = {
          physId: p.id, date: a.date, site: siteName, shift: '1st',
          kind: 'ir-shift', irGroup: a.irGroup,
          shiftKey: 's1', ym: a.date.slice(0,7), sub: '',
        };
        // callDayRulesOk direction 1: must match requiredSite when on call.
        if(!callDayRulesOk(p, ctx)) continue;
        // Site rule must allow IR shift at this site for this phys.
        if(!irSiteRuleOk(p, siteName, a.date)) continue;
        // Day-of-week condition must pass.
        if(!dayConditionSiteOk(p, siteName, a.date, 'ir-shift')) continue;
        // Sequence rule too.
        if(!sequenceOk(p, a.date, a.date.slice(0,7), siteName, '')) continue;
        // Natural-language rule.
        if(!natLangRulesOk(ctx)) continue;
        // Conference rule.
        if(!tbRulesOk(p, ctx)) continue;
        chosenSite = siteName;
        break;
      }
      if(chosenSite){
        S.irShifts.push({id:S.nextId++,physId:a.physId,date:a.date,shift:'1st',
          site:chosenSite,sub:'',notes:'Auto (with call)',irGroup:a.irGroup});
        procShiftsAdded++;
      } else {
        // No rule-valid site could be found. Skip the auto-shift rather
        // than force a violation. Admin will see the call without a shift
        // and can place one manually if needed.
        procShiftsSkipped++;
        skippedLog.push(`${a.date} · ${p.last} — no rule-valid site for auto-shift (call was still assigned)`);
      }
    }
  });
  const n=toApply.length;
  triggerSave();
  _afterMutation();
  let note=procShiftsAdded?` · ${procShiftsAdded} proc shift(s) auto-created`:'';
  if(procShiftsSkipped) note+=` · ${procShiftsSkipped} proc shift(s) skipped (no rule-valid site)`;
  let html=`<div class="note ns">${n} IR call assignment(s) applied across ${_iraPeriodLabel(_iraMonths())}${note}.</div>`;
  if(skippedLog.length){
    html+=`<div class="note nw" style="margin-top:8px"><strong>Proc shifts not auto-created:</strong><br>
      <span style="font-family:monospace;font-size:11px">${skippedLog.map(escHtml).join('<br>')}</span></div>`;
  }
  document.getElementById('ira-box').innerHTML=html;
  document.getElementById('ira-apply').style.display='none';
}
