function previewIRAA(){
  if(!_adminOnly('preview IR auto-assign')) return;
  // Defer-shim: see previewIRShiftAA for the rationale. Greedy solver
  // freezes the UI for 1-10s on large rosters; show an indeterminate
  // bar first and yield a paint cycle.
  if(!previewIRAA._deferred){
    const _box = document.getElementById('ira-box');
    if(_box && typeof _showProgress === 'function'){
      _box.innerHTML = '<div id="iraa-progress" style="padding:24px;max-width:420px;margin:8px auto"></div>';
      const _typ = document.getElementById('ira-type')?.value || 'both';
      const _grp = document.getElementById('ira-grp')?.value || 'both';
      _showProgress('iraa-progress', `Solving IR call assignments — ${_typ}, ${_grp === 'both' ? 'both groups' : _grp}…`);
      previewIRAA._deferred = true;
      setTimeout(() => {
        try { previewIRAA(); }
        finally { previewIRAA._deferred = false; }
      }, 16);
      return;
    }
  }

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

  // Running counts: calls already on the schedule inside the build period plus
  // this run's picks. Seeded per group in the main loop from the same date
  // range the slots come from, so a half-month build counts only its half.
  const cntD = {}, cntW = {};
  irPs.forEach(p => { cntD[p.id] = 0; cntW[p.id] = 0; });
  // ─── LIMITS (rs-v128) ──────────────────────────────────────────────────
  // Two HARD limits per physician and call type. Nobody is assigned past
  // either one; a slot that nobody can take inside them is left as a gap.
  //   1. The Settings maximum for the calendar year — _irCallMaxYear — counted
  //      over the whole year, and paced through it when the build covers only
  //      part of the year (_irGroupCallMax).
  //   2. Fair share of this build period — _irFairShares: the period's slots
  //      split by IR FTE (start-date aware), rounded up to a whole call. What a
  //      colleague cannot take (at their maximum, or away for most of the
  //      period) is split among the others the same way.
  // (Through rs-v127 the target was advisory: an "over FTE" pick was made
  // rather than leave a slot open, and the Settings maximums were never read.)
  const planYear = months[0].slice(0,4);
  const periodDates = allCells.filter(c => c.day).map(c => c.date).sort();
  const periodStart = periodDates[0] || `${planYear}-01-01`;
  const periodEnd   = periodDates[periodDates.length - 1] || `${planYear}-12-31`;
  // physId → { D: {...}, W: {...} }, one record per call type:
  //   max, before, inP, after, pace, pm  — the Settings maximum (_irGroupCallMax)
  //   can    — the most they are able to cover in the period (_irCallCapacity)
  //   ceil   — the ceiling the re-split used: min(pm, can), or the count they
  //            reached when they could not take any of the dates left
  //   base   — FTE share of the period's slots
  //   share  — after the re-split; cap = share rounded up (the hard limit)
  const lim = {};
  const _L = (p, kind) => (lim[p.id] || {})[kind === 'weekend' ? 'W' : 'D'];
  // The most this physician may hold in the period, in cntD/cntW terms.
  // Call pools (rs-v136): the fair share (cap) counts calls in this pool only, the maximum (pm) every
  // pool — L.xP is what they already hold in other pools inside the period (0 for nearly everyone).
  const _quota = (p, kind) => { const L = _L(p, kind); return L ? Math.min(L.cap + (L.xP || 0), L.pm) : 0; };
  const _cnt = (p, kind) => kind === 'weekend' ? cntW[p.id] : cntD[p.id];
  const underLimit = (p, kind) => _cnt(p, kind) < _quota(p, kind);
  const limitReason = (p, kind) => {
    const L = _L(p, kind), have = _cnt(p, kind);
    if(!L) return 'no limit record';
    if(have >= L.pm){
      const yr = L.before + L.after + have;
      if(yr >= L.max) return `at Settings maximum (${yr} of ${L.max} in ${planYear})`;
      return `at Settings maximum for this point in the year (${L.before + have} of ${L.pace} through ${periodEnd}; ${L.max} for ${planYear})`;
    }
    return `at fair share (${have - (L.xP || 0)} of ${L.share.toFixed(1)})`;
  };
  const gapMeta = [];                   // one entry per unfilled slot: {date, kind, group, limited, maxed}

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
          // The slot being filled is open, so a weekend call this physician already holds on this
          // Friday is in ANOTHER pool (call pools, rs-v136): the same weekend twice.
          if(c.callType === 'weekend' && c.date === fri) return 'already on weekend call this date';
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
  const _awayOf = {};
  function whyBlocked(p, date, kind, g, skipAdjacency, opts){
    const allowRelax = !!(opts && opts.allowRelaxBreakable);
    const isWkd = (kind === 'weekend');
    const span  = isWkd ? [date, addDays(date,1), addDays(date,2), addDays(date,3)] : [date];
    const ym    = date.slice(0,7);

    // Vacation — any day of span (each physician's set built once per preview: S does not change while it runs)
    const vd = _awayOf[p.id] || (_awayOf[p.id] = _awayDays(p.id));
    for(const d of span) if(vd.has(d)) return (vd.notStartedBefore && d < vd.notStartedBefore) ? 'not started yet' : 'vacation';
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
  // Primary: who is furthest behind their limit FOR THE DATES THEY HAVE LEFT.
  //   urgency = (share of their quota still open) ÷ (share of the dates they
  //   can cover that are still ahead). For physicians with the same
  //   availability this is exactly the old "lowest count ÷ cap first". For
  //   someone who joins part-way through the period (or has a long vacation)
  //   it spreads their calls over the dates they can cover, instead of
  //   handing them every slot until their ratio "catches up" with colleagues
  //   who have been taking call since January.
  // Before that: whoever has not yet had their FTE share of the YEAR so far
  //   (_ytd below). Secondary (daily): prefer a physician who already has an IR
  //   procedure shift that day. Then the lower year-so-far ratio, then last
  //   name, for a deterministic result.
  let _avail = {}, _rem = {};           // per call type within one group — set by fillKind
  const _urgency = (p, kind) => {
    const _xpU = (_L(p, kind) || {}).xP || 0, q = _quota(p, kind) - _xpU;
    if(q <= 0) return -Infinity;
    const a = _avail[p.id] || 0;
    const aheadFrac = a > 0 ? Math.max(_rem[p.id] || 0, 0.5) / a : 1;
    return (1 - (_cnt(p, kind) - _xpU) / q) / aheadFrac;
  };
  // The year so far: calls held this year up to and including this run, against
  // the FTE share of the year's slots through the end of the build period
  // (toDate, _irGroupCallMax). A month or half-month build is one of many that
  // year, so who gets a date has to look past the period — otherwise the
  // round-up of every period's share, and every tie, go to the same
  // physicians all year. A preference only: the hard limits are unchanged.
  const _ytd = (p, kind) => {
    const L = _L(p, kind);
    if(!L || !(L.toDate > 0)) return { met: 1, ratio: 1e9 };
    const have = L.before - (L.xB || 0) + _cnt(p, kind) - (L.xP || 0);     // this pool's calls only
    // ...and only while they are not already ahead of an even spread of this
    // period's quota (urgency < 1): someone far behind for the year (back from
    // a long leave) would otherwise take every date until their cap was used up.
    return { met: (have >= Math.ceil(L.toDate - 1e-9) || _urgency(p, kind) < 1 - 1e-9) ? 1 : 0, ratio: have / L.toDate };
  };
  function sortDaily(pool, date){
    return pool.slice().sort((a, b) => {
      const ya = _ytd(a, 'daily'), yb = _ytd(b, 'daily');
      if(ya.met !== yb.met) return ya.met - yb.met;
      const ua = _urgency(a, 'daily'), ub = _urgency(b, 'daily');
      if(Math.abs(ua - ub) > 1e-9) return ub - ua;
      const shA = _hasIRShiftOnDate(a.id, date) ? 0 : 1;
      const shB = _hasIRShiftOnDate(b.id, date) ? 0 : 1;
      if(shA !== shB) return shA - shB;
      if(Math.abs(ya.ratio - yb.ratio) > 1e-9) return ya.ratio - yb.ratio;
      return (a.last||'').localeCompare(b.last||'');
    });
  }
  function sortWeekend(pool){
    return pool.slice().sort((a, b) => {
      const ya = _ytd(a, 'weekend'), yb = _ytd(b, 'weekend');
      if(ya.met !== yb.met) return ya.met - yb.met;
      const ua = _urgency(a, 'weekend'), ub = _urgency(b, 'weekend');
      if(Math.abs(ua - ub) > 1e-9) return ub - ua;
      if(Math.abs(ya.ratio - yb.ratio) > 1e-9) return ya.ratio - yb.ratio;
      return (a.last||'').localeCompare(b.last||'');
    });
  }

  // ─── MAIN LOOP ─────────────────────────────────────────────────────────
  // Stage 1: each pool's regular slots go to its own members (fair share, Settings maximum).
  // What stays open is kept per pool (_cpOpen) for stage 2, and the gap rows wait (_cpPend)
  // until stage 2 has run: a slot another pool's volunteer covers is not a gap.
  const _cpOpen = {}, _cpPend = [];
  groups.forEach(g => {
    const gPhys = irPs.filter(p => p.irGroup === g);
    if(!gPhys.length){
      // Call pools (rs-v136): a pool with no members — its open slots come only from the
      // physicians who list it (stage 2). Same slot lists as below.
      const o = _cpOpen[g] = { weekend: [], daily: [] };
      if(typ === 'weekend' || typ === 'both'){
        o.weekend = allCells.filter(c => c.dow === 5).map(c => c.date).filter(fri => {
          if(!_irHolidayWeekend(fri, g)) return true;
          const span = [fri, addDays(fri,1), addDays(fri,2), addDays(fri,3)];
          const matched = span.find(d => (S.holidayDefs||[]).some(h => (h.dates||[]).includes(d) && _irHolSlotsFor(h, g) > 0)) || span.find(d => isHolidayBlackout(d)) || fri;
          const held = S.irCalls.find(ic => ic.date === fri && ic.irGroup === g && ic.callType === 'weekend' && _isHolidaySyncedCall(ic));
          S._lastIRAAExcludedHolidayWknds.push({ friday: fri, matchedDate: matched, reason: _holidayReasonFor(matched), group: g, heldBy: held ? held.physId : null });
          return false;
        }).filter(fri => !S.irCalls.find(ic => ic.date === fri && ic.irGroup === g && ic.callType === 'weekend'));
      }
      if(typ === 'daily' || typ === 'both'){
        o.daily = allCells.filter(c => c.dow >= 1 && c.dow <= 4 && !isHolidayBlackout(c.date)).map(c => c.date)
          .filter(d => !S.irCalls.find(ic => ic.date === d && ic.irGroup === g && ic.callType === 'daily'));
      }
      return;
    }

    // A slot already held by a holiday-synced call belongs to holiday call, not
    // to anyone's share of regular call.
    const _holTaken = (d, kind) => S.irCalls.some(ic => ic.date === d && ic.irGroup === g && ic.callType === kind
      && typeof _isHolidaySyncedCall === 'function' && _isHolidaySyncedCall(ic));
    // Every regular slot of the period (filled or not) — the base of the fair share.
    const dailySlotsAll = allCells.filter(c => c.dow >= 1 && c.dow <= 4 && !isHolidayBlackout(c.date)).map(c => c.date)
      .filter(d => !_holTaken(d, 'daily'));
    const wkndSlotsAll = allCells.filter(c => c.dow === 5).map(c => c.date)
      .filter(fri => !_irHolidayWeekend(fri, g) && !_holTaken(fri, 'weekend'));
    // The slots still to fill, per call type (nobody holds them yet).
    const _taken = (d, kind) => S.irCalls.some(ic => ic.date === d && ic.irGroup === g && ic.callType === kind);
    const openDates = { weekend: wkndSlotsAll.filter(d => !_taken(d, 'weekend')), daily: dailySlotsAll.filter(d => !_taken(d, 'daily')) };
    // Who could take each open date before adjacency and limits (vacation, start
    // date, blackouts, rules). Drives the fill order, the urgency sort and what
    // each physician is able to cover.
    const baseEligOf = { weekend: {}, daily: {} };
    ['weekend', 'daily'].forEach(kind => openDates[kind].forEach(d => {
      baseEligOf[kind][d] = gPhys.filter(p => !whyBlocked(p, d, kind, g, true));
    }));
    // Limits for this group — both call types, so the summary table is complete
    // whichever type is being built.
    [['daily', 'D', dailySlotsAll, cntD], ['weekend', 'W', wkndSlotsAll, cntW]].forEach(([kind, key, slots, cnt]) => {
      const mx = _irGroupCallMax(gPhys, kind, _irYearSlots(kind, planYear, g), periodStart, periodEnd, planYear);
      const xc = _irCoverCounts(gPhys, kind, g, periodStart, periodEnd, planYear);   // calls in other pools (rs-v136)
      const ceilings = {};
      gPhys.forEach(p => {
        const free = openDates[kind].filter(d => baseEligOf[kind][d].includes(p));
        const can = mx[p.id].inP + _irCallCapacity(free, kind), x = xc[p.id];
        ceilings[p.id] = Math.min(mx[p.id].pm, can) - x.xP;           // the most of THIS pool's slots
        cnt[p.id] = mx[p.id].inP;
        (lim[p.id] = lim[p.id] || {})[key] = Object.assign({ can, ceil: ceilings[p.id] }, mx[p.id], (x.xB || x.xP || x.xA) ? x : {});
      });
      const sh = _irFairShares(gPhys, slots, kind, ceilings);
      gPhys.forEach(p => {
        const L = lim[p.id][key];
        L.base = sh.base[p.id]; L.share = sh.share[p.id]; L.cap = Math.ceil(sh.share[p.id] - 1e-9);
      });
    });

    // Fill every date of one call type for this group.
    const fillKind = (kind, dates) => {
      const isW = kind === 'weekend', key = isW ? 'W' : 'D';
      const cnt = isW ? cntW : cntD;
      const slotsAll = isW ? wkndSlotsAll : dailySlotsAll;
      // Who could take each date before adjacency and limits. Drives the
      // most-constrained-first order and the "dates still ahead" half of the
      // urgency sort.
      const baseElig = baseEligOf[kind];
      dates.forEach(d => { if(!baseElig[d]) baseElig[d] = gPhys.filter(p => !whyBlocked(p, d, kind, g, true)); });

      // One pass over a list of open dates; returns the dates still open.
      const pass = (todo) => {
        _avail = {}; _rem = {};
        gPhys.forEach(p => { _avail[p.id] = 0; });
        todo.forEach(d => baseElig[d].forEach(p => { _avail[p.id]++; }));
        gPhys.forEach(p => { _rem[p.id] = _avail[p.id]; });
        // Normal order: most-constrained dates first (fewest people who could take
        // them), then by calendar. When the Settings maximum cannot cover every
        // open slot the shortfall is certain and the maximum — not eligibility —
        // decides what stays open: visit the dates in bit-reversed calendar order
        // instead, so everyone's allowance is used evenly through the period and
        // the open slots are spread across it rather than piling up at the end
        // (or all landing after a mid-year starter arrives). Measured against
        // the maximum only — when back-to-back spacing is what falls short,
        // calendar order fills more — and only the part of it that can be used.
        // A physician's maximum counts only as far as they have open dates to use
        // it on (_avail, filled above) ...
        const room = gPhys.reduce((sum, p) => sum + Math.max(0, Math.min(lim[p.id][key].pm - cnt[p.id], _avail[p.id])), 0);
        // ... against what the group could place with no maximum at all: the dates
        // somebody can take, and no more than back-to-back spacing lets each hold.
        const reach = Math.min(todo.filter(d => baseElig[d].length).length,
          gPhys.reduce((sum, p) => sum + _irCallCapacity(todo.filter(d => baseElig[d].includes(p)), kind), 0));
        const short = room < reach;
        const chrono = todo.slice().sort();
        const pos = {}; chrono.forEach((d, i) => { pos[d] = i; });
        const bits = Math.max(1, Math.ceil(Math.log2(chrono.length || 1)));
        const rev = i => { let r = 0; for(let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1); return r; };
        const order = todo.slice().sort((a, b) => short
          ? rev(pos[a]) - rev(pos[b])
          : (baseElig[a].length - baseElig[b].length) || (a < b ? -1 : 1));

        const open = [];                  // dates nobody could take, for the repair step
        for(const date of order){
          const eligible = gPhys.filter(p => underLimit(p, kind) && !whyBlocked(p, date, kind, g, false));
          let relaxedPick = false;
          if(!eligible.length){
            // ── Relaxation retry ─────────────────────────────────────────
            // Nobody is eligible. Retry ignoring conference rules the admin
            // flagged allowBreakForUnfilledIR. Adjacency, participation,
            // call-day-site rules and the limits are never relaxed.
            for(const p of gPhys){
              if(!underLimit(p, kind)) continue;
              if(!whyBlocked(p, date, kind, g, false, {allowRelaxBreakable: true})) eligible.push(p);
            }
            if(eligible.length) relaxedPick = true;
          }
          if(eligible.length){
            const picked = (isW ? sortWeekend(eligible) : sortDaily(eligible, date))[0];
            const entry = {
              physId: picked.id, date, callType: kind, irGroup: g, site: '',
              notes: relaxedPick ? 'Auto (conference rule relaxed)' : 'Auto',
            };
            if(!isW) entry.needsProcShift = !_hasIRShiftOnDate(picked.id, date);
            entry._overFte = false;
            entry._relaxedBreakable = relaxedPick;
            preview.push(entry);
            cnt[picked.id]++;
          } else {
            open.push(date);
          }
          baseElig[date].forEach(p => { _rem[p.id]--; });
        }

        // ── Repair ───────────────────────────────────────────────────────
        // A slot can stay open although somebody still has room: that person is
        // blocked on this particular date (adjacent call, a rule) while everyone
        // who could take it is at a limit. Try one hand-over: Y, at their limit,
        // takes the open date and gives up another call from this run to Z, who
        // has room and can take that one. Nobody's count passes a limit.
        let budget = 8000;                // whyBlocked evaluations
        const stillOpen = [];
        for(const openDate of open){
          let fixed = false;
          if(budget > 0 && gPhys.some(z => underLimit(z, kind))){
            search:
            for(const y of gPhys){
              if(underLimit(y, kind)) continue;        // would have been picked already if eligible
              if(!baseElig[openDate].includes(y)) continue;   // away or rule-blocked that day: lifting a call cannot help
              const mine = preview.filter(a => a.physId === y.id && a.callType === kind && a.irGroup === g);
              for(const a of mine){
                if(budget <= 0) break search;
                // nobody with room could take the call Y would give up
                if(!gPhys.some(z => z.id !== y.id && underLimit(z, kind) && (baseElig[a.date] || []).includes(z))) continue;
                const at = preview.indexOf(a);
                preview.splice(at, 1);                 // lift Y's other call
                budget--;
                if(!whyBlocked(y, openDate, kind, g, false)){
                  const moved = { physId: y.id, date: openDate, callType: kind, irGroup: g, site: '', notes: 'Auto' };
                  if(!isW) moved.needsProcShift = !_hasIRShiftOnDate(y.id, openDate);
                  moved._overFte = false; moved._relaxedBreakable = false;
                  preview.push(moved);                 // Y on the open date
                  const takers = gPhys.filter(z => z.id !== y.id && underLimit(z, kind));
                  const ranked = isW ? sortWeekend(takers) : sortDaily(takers, a.date);
                  let z = null;
                  for(const cand of ranked){
                    budget--;
                    if(!whyBlocked(cand, a.date, kind, g, false)){ z = cand; break; }
                  }
                  if(z){
                    const given = { ...a, physId: z.id, notes: 'Auto', _overFte: false, _relaxedBreakable: false };
                    if(!isW) given.needsProcShift = !_hasIRShiftOnDate(z.id, a.date);
                    preview.push(given);               // Z takes the call Y gave up
                    cnt[z.id]++;                       // Y: one out, one in
                    fixed = true;
                    break search;
                  }
                  preview.splice(preview.indexOf(moved), 1);
                }
                preview.splice(at, 0, a);              // nothing worked — put it back
              }
            }
          }
          if(!fixed) stillOpen.push(openDate);
        }
        return stillOpen;
      };

      let left = pass(dates);
      // ── Re-split ───────────────────────────────────────────────────────
      // Dates are still open and somebody is still under their limit: that
      // person is blocked on every date that is left (or they would hold it),
      // so the rest of their share cannot be placed. Release it to the others
      // — split by FTE like everything else, never past anyone's Settings
      // maximum — and try the open dates again.
      const ceilNow = {};
      gPhys.forEach(p => { const L = lim[p.id][key]; ceilNow[p.id] = Math.min(L.pm, L.can) - (L.xP || 0); });
      for(let round = 0; round < gPhys.length && left.length; round++){
        const stuck = gPhys.filter(p => underLimit(p, kind));
        if(!stuck.length) break;
        stuck.forEach(p => { ceilNow[p.id] = lim[p.id][key].ceil = cnt[p.id] - (lim[p.id][key].xP || 0); });
        const sh = _irFairShares(gPhys, slotsAll, kind, ceilNow);
        let grew = false;
        gPhys.forEach(p => {
          const L = lim[p.id][key], cap = Math.ceil(sh.share[p.id] - 1e-9);
          if(cap > L.cap) grew = true;
          L.share = sh.share[p.id]; L.cap = cap;
        });
        if(!grew) break;
        left = pass(left);
      }

      // ── Last resort: conference rules flagged allowBreakForUnfilledIR ──
      // Dates are still open after the re-split. So far a physician's ceiling
      // counted only the dates they can take WITHOUT breaking such a rule
      // (L.can), so the retry in pass() could never use them past it. Count the
      // open dates they could take by breaking it, give them their FTE share of
      // those (never past the Settings maximum) and try once more.
      if(left.length){
        let raised = false;
        gPhys.forEach(p => {
          if(!(p.tbRules || []).some(r => r && r.allowBreakForUnfilledIR)) return;
          const extra = left.filter(d => !whyBlocked(p, d, kind, g, false, {allowRelaxBreakable: true}));
          const c = Math.min(lim[p.id][key].pm, cnt[p.id] + _irCallCapacity(extra, kind)) - (lim[p.id][key].xP || 0);
          if(extra.length && c > ceilNow[p.id]){ ceilNow[p.id] = c; raised = true; }
        });
        if(raised){
          const sh = _irFairShares(gPhys, slotsAll, kind, ceilNow);
          let grew = false;
          gPhys.forEach(p => {
            const L = lim[p.id][key], cap = Math.ceil(sh.share[p.id] - 1e-9);
            if(cap > L.cap){ L.share = sh.share[p.id]; L.cap = cap; L.ceil = ceilNow[p.id]; grew = true; }
          });
          if(grew) left = pass(left);
        }
      }

      left.sort().forEach(date => {
        const reasons = {}; let limited = false;
        gPhys.forEach(p => {
          const r = whyBlocked(p, date, kind, g, false);
          if(r) reasons[p.id] = r;
          else { reasons[p.id] = limitReason(p, kind); limited = true; }
        });
        const breakdown = gPhys.map(p => `${p.last}=${reasons[p.id]}`).join(', ');
        _cpPend.push({ g, kind, date, row: `${isW ? 'Wknd ' : ''}${date} ${g} [${breakdown}]`, meta: { date, kind, group: g, limited,
          maxed: Object.values(reasons).some(r => /^at Settings maximum/.test(r)),
          paced: Object.values(reasons).some(r => /^at Settings maximum for this point/.test(r)) } });
      });
      (_cpOpen[g] = _cpOpen[g] || { weekend: [], daily: [] })[kind] = left.slice().sort();
    };

    // Weekends are filled BEFORE daily call (rs-v128). A weekend is a four-day
    // span with the tightest neighbours (no call the Thursday before or the
    // Tuesday after, none within seven days), so under hard limits it has far
    // fewer people who can take it; daily call has more freedom and fits
    // around the weekends already placed. Filling daily first left weekends
    // open with everyone either adjacent-blocked or at their limit.
    // ── WEEKEND CALLS — Fridays; holiday weekends are left to holiday call ──
    if(typ === 'weekend' || typ === 'both'){
      const excludedWknds = [];
      const wkndDates = allCells.filter(c => c.dow === 5).map(c => c.date)
        .filter(fri => {
          if(!_irHolidayWeekend(fri, g)) return true;
          // A holiday weekend: not regular call. Note who holds the holiday call
          // for this group, if it has been assigned on the Holiday tab yet.
          const span = [fri, addDays(fri,1), addDays(fri,2), addDays(fri,3)];
          const matched = span.find(d => (S.holidayDefs||[]).some(h => (h.dates||[]).includes(d) && _irHolSlotsFor(h, g) > 0)) || span.find(d => isHolidayBlackout(d)) || fri;
          const held = S.irCalls.find(ic => ic.date === fri && ic.irGroup === g && ic.callType === 'weekend' && _isHolidaySyncedCall(ic));
          excludedWknds.push({ friday: fri, matchedDate: matched, reason: _holidayReasonFor(matched), group: g, heldBy: held ? held.physId : null });
          return false;
        })
        .filter(fri => !S.irCalls.find(ic => ic.date === fri && ic.irGroup === g && ic.callType === 'weekend'));
      S._lastIRAAExcludedHolidayWknds.push(...excludedWknds);
      fillKind('weekend', wkndDates);
    }

    // ── DAILY CALLS — Mon-Thu non-holiday dates ──
    if(typ === 'daily' || typ === 'both'){
      const dailyDates = allCells
        .filter(c => c.dow >= 1 && c.dow <= 4 && !isHolidayBlackout(c.date))
        .map(c => c.date)
        .filter(d => !S.irCalls.find(ic => ic.date === d && ic.irGroup === g && ic.callType === 'daily'));
      fillKind('daily', dailyDates);
    }
  });

  // ─── STAGE 2: COVER OTHER POOLS (rs-v136) ──────────────────────────────
  // The slots each pool of this run still has open are offered to the physicians who
  // list that pool in their profile ("Also takes IR call for"), whatever their own group
  // (none included), spread evenly by the room they have left under the Settings
  // maximum; their ranking decides only which pool that room goes to first
  // (_irCoverAllocate). Every hard rule stage 1 applies to a pool's own members
  // applies (whyBlocked with the covered pool), back-to-back is checked against every
  // call they hold in any pool, and the one limit is the Settings maximum for the
  // period (paced, counted over all pools) — their own pool's fair share does not cap it.
  // Cover spends only the room their OWN pool will not need: their FTE share of its
  // open slots that this run does not build (later in the year, or all of it when their
  // pool is not part of this run) stays free under the maximum (_irCoverYearCap).
  const _cpPools = getIRGroups();
  const _cpVols = irPs.map(p => ({ p, pools: _physCallPools(p, _cpPools).filter(g => groups.includes(g)) })).filter(v => v.pools.length);
  const _cpPicked = new Set(), _cpLeft = new Map();
  const _cpCache = {}, _cpCapOf = {}, _cpRunDates = new Set(periodDates);
  const _cpDecided = (g, kind, d) => groups.includes(g) && (typ === 'both' || typ === kind) && _cpRunDates.has(d);
  const _cpCap = (p, kind) => { const k = p.id + '|' + kind; return _cpCapOf[k] || (_cpCapOf[k] = _irCoverYearCap(p, kind, planYear, periodStart, periodEnd, _cpDecided, _cpCache)); };
  // Why a volunteer has no room left: the Settings maximum, or the room kept for their own pool.
  const _cpRoomWhy = (p, kind) => { const L = _L(p, kind), c = _cpCap(p, kind), have = _cnt(p, kind);
    return (L && c.keep > 0 && have < L.pm && have >= c.cap) ? `keeping ${c.keep} of their maximum for ${p.irGroup}'s own open calls through ${c.t}` : limitReason(p, kind); };
  if(_cpVols.length){
    // A volunteer outside this run's pools, or with no primary group, has no limit
    // record yet: the Settings maximum for the period and the calls already held in it.
    const _cpGM = {};
    _cpVols.forEach(({ p }) => {
      [['daily', 'D', cntD], ['weekend', 'W', cntW]].forEach(([kind, key, cnt]) => {
        if(lim[p.id] && lim[p.id][key]) return;
        const og = p.irGroup && _cpPools.includes(p.irGroup) ? p.irGroup : '';
        let mx;
        if(og){
          const gk = og + '|' + kind;
          if(!_cpGM[gk]) _cpGM[gk] = _irGroupCallMax(irPs.filter(q => q.irGroup === og), kind, _irYearSlots(kind, planYear, og), periodStart, periodEnd, planYear);
          mx = _cpGM[gk][p.id];
        } else mx = _irSoloCallMax(p, kind, planYear, periodStart, periodEnd);
        cnt[p.id] = mx.inP;
        (lim[p.id] = lim[p.id] || {})[key] = Object.assign({ coverOnly: true }, mx);
      });
    });
    const _cpSlots = [];
    groups.forEach(g => ['weekend', 'daily'].forEach(kind => ((_cpOpen[g] || {})[kind] || []).forEach(date => _cpSlots.push({ g, kind, date }))));
    const _cpRes = _irCoverAllocate({
      slots: _cpSlots, vols: _cpVols, poolOrder: groups,
      base: (p, date, kind, g) => whyBlocked(p, date, kind, g, true) || _irCoverHolidayBlock(p, date, kind, g),
      adj: (p, date, kind) => kind === 'weekend' ? adjacencyReasonWeekend(p.id, date) : adjacencyReasonDaily(p.id, date),
      room: (p, kind) => { const L = _L(p, kind); if(!L) return 0; const m = Math.min(L.pm, _cpCap(p, kind).cap); return isFinite(m) ? Math.max(0, m - _cnt(p, kind)) : Infinity; },
      load: (p, kind) => { const L = _L(p, kind) || {}, e = (p.irFte || 0) * _physYearFraction(p, planYear);
        return ((L.before || 0) + (L.after || 0) + _cnt(p, kind)) / (e > 0 ? e : 1e-9); },
      place: (p, sl) => {
        const entry = { physId: p.id, date: sl.date, callType: sl.kind, irGroup: sl.g, site: '', notes: `Auto (covering ${sl.g})` };
        if(sl.kind !== 'weekend') entry.needsProcShift = !_hasIRShiftOnDate(p.id, sl.date);
        entry._overFte = false; entry._relaxedBreakable = false; entry._cover = true;
        preview.push(entry);
        if(sl.kind === 'weekend') cntW[p.id]++; else cntD[p.id]++;
      },
    });
    _cpRes.picks.forEach(x => _cpPicked.add(x.slot.g + '|' + x.slot.kind + '|' + x.slot.date));
    _cpRes.left.forEach(x => {
      // 'kept': somebody with room under the maximum keeps it for their own pool's open calls.
      if(x.why === 'maxed' && x.detail.some(d => !d.why && /^keeping /.test(_cpRoomWhy(d.p, x.slot.kind)))) x.why = 'kept';
      _cpLeft.set(x.slot.g + '|' + x.slot.kind + '|' + x.slot.date, x);
    });
  }
  // Stage 1's gap rows, for the slots stage 2 did not cover either (same order and wording;
  // a pool somebody lists also says why nobody from another pool took it).
  const _cpListed = new Set(); _cpVols.forEach(v => v.pools.forEach(g => _cpListed.add(g)));
  const _cpWhy = { none: 'nobody lists this pool', maxed: 'everyone who lists it is at their maximum', kept: 'everyone who lists it is at their maximum or keeping the rest for their own pool', busy: 'nobody who lists it is free that day' };
  _cpPend.forEach(x => {
    const k = x.g + '|' + x.kind + '|' + x.date;
    if(_cpPicked.has(k)) return;
    const l = _cpLeft.get(k);
    if(l && _cpListed.has(x.g)){
      gaps.push(`${x.row} \u00b7 other pools: ${_cpWhy[l.why]} [${l.detail.map(d => `${d.p.last}=${d.why || _cpRoomWhy(d.p, x.kind)}`).join(', ')}]`);
      gapMeta.push(Object.assign(x.meta, { cover: l.why }));
    } else { gaps.push(x.row); gapMeta.push(x.meta); }
  });
  // Per pool of this run: what stage 2 covered and what is still open (why → count).
  const _cpSum = groups.map(g => {
    const _cpMemN = irPs.filter(p => p.irGroup === g).length, n = { weekend: 0, daily: 0 }, by = { weekend: {}, daily: {} }, open = { weekend: {}, daily: {} };
    preview.forEach(a => { if(a._cover && a.irGroup === g){ n[a.callType]++; by[a.callType][a.physId] = (by[a.callType][a.physId] || 0) + 1; } });
    ['weekend', 'daily'].forEach(kind => ((_cpOpen[g] || {})[kind] || []).forEach(date => {
      const k = g + '|' + kind + '|' + date; if(_cpPicked.has(k)) return;
      const l = _cpLeft.get(k), why = l ? l.why : 'none';
      open[kind][why] = (open[kind][why] || 0) + 1;
    }));
    const nOpen = kind => Object.values(open[kind]).reduce((a, b) => a + b, 0);
    return { g, members: _cpMemN, n, by, open, openD: nOpen('daily'), openW: nOpen('weekend'), listed: _cpListed.has(g) };
  });
  const _cpUncovered = _cpSum.filter(x => !x.members).reduce((a, x) => a + x.openD + x.openW, 0);

  // ─── TAIL: keep the rest (render) intact ───────────────────────────────

  // A preview never queues a save or an undo step (S is the reactive store; rs-v136).
  { const _r0=_isRestoring; _isRestoring=true; try{ S.iraPreview=preview; } finally { _isRestoring=_r0; } }
  // The limits this run applied — read by the regression tests and handy in the console.
  previewIRAA._last = { lim, planYear, periodStart, periodEnd, stamp: _iraStamp(),
    pools: _cpSum.map(x => ({ group: x.g, members: x.members, covered: { daily: x.n.daily, weekend: x.n.weekend }, open: { daily: x.openD, weekend: x.openW }, why: x.open, listed: x.listed })) };
  const dailyPrev=preview.filter(a=>a.callType==='daily');
  const wkndPrev=preview.filter(a=>a.callType==='weekend');
  // Hard rules (never waived): no back-to-back call, vacations and start dates,
  // site / conference / blackout rules, and — since rs-v128 — each physician's
  // fair share and the Settings maximum. The one opt-in relaxation left is a
  // conference rule the admin flagged allowBreakForUnfilledIR.
  const relaxedFills  = preview.filter(a=>a._relaxedBreakable).length;
  const limitedGaps   = gapMeta.filter(x=>x.limited).length;
  const maxedGaps     = gapMeta.filter(x=>x.maxed).length;
  const _mbD = _irCallMaxBase('daily'), _mbW = _irCallMaxBase('weekend');
  const _maxLbl = `${isFinite(_mbD) ? _mbD + ' weekday' : 'no weekday maximum'} / ${isFinite(_mbW) ? _mbW + ' weekend' : 'no weekend maximum'} per 1.0 FTE per year`;
  // What the yearly maximum would have to be to cover every slot of the year,
  // per group that has slots open at the maximum: the group's regular slots ÷
  // its FTE on staff (start dates counted). Only where that is MORE than the
  // maximum Settings holds now — otherwise raising it is not the answer.
  const _needParts = (()=>{
    const parts=[];
    [...new Set(gapMeta.filter(x=>x.maxed).map(x=>x.group))].forEach(g=>{
      const eff=irPs.filter(p=>p.irGroup===g).reduce((sum,p)=>sum+(p.irFte||0)*_physYearFraction(p,planYear),0);
      if(!(eff>0)) return;
      const kinds=new Set(gapMeta.filter(x=>x.maxed&&x.group===g).map(x=>x.kind));
      const bits=[];
      const nD=Math.ceil(_irYearSlots('daily',planYear,g).length/eff-1e-9), nW=Math.ceil(_irYearSlots('weekend',planYear,g).length/eff-1e-9);
      if(kinds.has('daily')   && nD>_mbD) bits.push(`${nD} weekday`);
      if(kinds.has('weekend') && nW>_mbW) bits.push(`${nW} weekend`);
      if(bits.length) parts.push(`${escHtml(g)}: about ${bits.join(' / ')}`);
    });
    return parts;
  })();
  const _maxedNote = !maxedGaps ? ''
    : _needParts.length
      ? ` <strong>${maxedGaps}</strong> of these are open because everyone who could take them is at the Settings maximum — raise it under Settings → FTE Caps if these should be covered, or assign them by hand. To cover every ${planYear} slot, the per-1.0-FTE yearly maximum would need to be — ${_needParts.join('; ')}.`
      : gapMeta.some(x=>x.paced)
        ? ` <strong>${maxedGaps}</strong> of these are open because the physicians free on those dates have used the part of their yearly maximum that this point in the year allows (the maximum is paced through the year). Building a longer period, or assigning them by hand, covers them.`
        : ` <strong>${maxedGaps}</strong> of these are open because the only physicians free on those dates are at the Settings maximum — assign them by hand, or raise the maximum under Settings → FTE Caps.`;
  // Conference rotations (tumor board / clinic) with no stored assignment on
  // some of the period's dates: on those days every participant counts as
  // attending, so none of them is offered call. Worth knowing before applying.
  const _rotOpen = [];
  [...(S.tumorBoards||[]), ...(S.clinics||[])].forEach(ev => {
    if(!ev || ev.active === false || !ev.rotation || !ev.rotation.enabled) return;
    const who = irPs.filter(p => (groups.includes(p.irGroup) || _cpVols.some(v => v.p === p)) && (ev.allowedPhysIds||[]).includes(p.id));
    if(!who.length) return;
    const miss = _eventOccurrencesInRange(ev, periodStart, periodEnd).filter(d => {
      if(_rotationPhysIdsFor(ev, d).length) return false;
      const dow = parseDateLocal(d).getDay();                 // only days this build can put someone on call
      return (typ !== 'weekend' && dow >= 1 && dow <= 4) || (typ !== 'daily' && (dow === 5 || dow === 6 || dow === 0 || dow === 1));
    }).sort();
    if(miss.length) _rotOpen.push({ name: ev.name || 'conference', n: miss.length, first: miss[0], who: who.map(p => p.last) });
  });

  let html=`<div style="font-weight:700;margin-bottom:8px">${preview.length} call assignments \u2014 ${gaps.length} gap(s) \u2014 ${label}<br>
    <span style="font-weight:400;font-size:11px;color:var(--txt2)">${dailyPrev.length} daily \u00b7 ${wkndPrev.length} weekend`;
  if(limitedGaps>0) html+=` \u00b7 <span style="color:var(--red-t);font-weight:700">${limitedGaps} left open at a limit</span>`;
  if(relaxedFills>0) html+=` \u00b7 <span style="color:var(--amber,#d97706);font-weight:700">${relaxedFills} conference rule relaxed</span>`;
  html+=`</span></div>`;

  // Call pools (rs-v136): what other pools' volunteers covered, and what is still open per pool.
  {
    const _kn = (n, kind) => `${n} ${kind === 'weekend' ? 'weekend' : 'weekday'} call${n === 1 ? '' : 's'}`;
    const _whyL = (x, kind) => Object.entries(x.open[kind]).map(([w, n]) => `${_cpWhy[w]}: ${n}`).join(' \u00b7 ');
    const cov = _cpSum.filter(x => x.n.daily || x.n.weekend).map(x => ['weekend', 'daily'].filter(k => x.n[k]).map(k =>
      `<strong>${escHtml(x.g)}:</strong> ${x.n[k]} open ${k === 'weekend' ? 'weekend' : 'weekday'} call${x.n[k] === 1 ? '' : 's'} covered from other pools (${Object.entries(x.by[k]).sort((a, b) => b[1] - a[1] || irPs.findIndex(p => p.id === +a[0]) - irPs.findIndex(p => p.id === +b[0])).map(([id, n]) => `${escHtml((_physById(+id) || {}).last || '?')} ${n}`).join(', ')})`).join('<br>')).join('<br>');
    const rest = _cpSum.filter(x => x.members && (x.openD || x.openW) && _cpVols.length).map(x => `<strong>${escHtml(x.g)}:</strong> ${[x.openW ? _kn(x.openW, 'weekend') : '', x.openD ? _kn(x.openD, 'daily') : ''].filter(Boolean).join(' + ')} still open \u2014 ${x.listed ? ['weekend', 'daily'].filter(k => x[k === 'weekend' ? 'openW' : 'openD']).map(k => `${k === 'weekend' ? 'weekend' : 'weekday'}: ${_whyL(x, k)}`).join('; ') : 'nobody lists this pool'}.`).join('<br>');
    // Volunteers from a pool this run does not build, while that pool still has open slots in the period:
    // their cover uses only the room left after their share of those slots (_irCoverYearCap).
    const _cpOut = [...new Set(preview.filter(a => a._cover).map(a => (_physById(a.physId) || {}).irGroup).filter(g => g && !groups.includes(g) && _cpPools.includes(g)))]
      .filter(g => allCells.some(c => ((c.dow >= 1 && c.dow <= 4 && !isHolidayBlackout(c.date)) || (c.dow === 5 && !_irHolidayWeekend(c.date, g)))
        && !S.irCalls.some(ic => ic.irGroup === g && ic.date === c.date && ic.callType === (c.dow === 5 ? 'weekend' : 'daily'))));
    const outNote = _cpOut.length ? `<div class="mt8">${_cpOut.map(escHtml).join(', ')} ${_cpOut.length > 1 ? 'are' : 'is'} not part of this run and still ha${_cpOut.length > 1 ? 've' : 's'} open calls in this period: ${_cpOut.length > 1 ? 'their' : 'its'} members cover here only with the room their Settings maximum leaves after their FTE share of their own pool's open calls this year, which stays free for its own build.</div>` : '';
    if(cov || rest) html+=`<div class="note ni mb8" style="font-size:11px"><strong>Other pools.</strong> A pool's open calls left after its own members' fair share go to the physicians who list it (physician profile \u2192 \u201cAlso takes IR call for\u201d), most room left under the Settings maximum first; their ranking only decides which pool their spare room goes to first.${cov ? `<div class="mt8">${cov}</div>` : ''}${rest ? `<div class="mt8">${rest}</div>` : ''}${outNote}</div>`;
    const ml = _cpSum.filter(x => !x.members && (x.openD || x.openW)).map(x => x.listed
      ? `<strong>${escHtml(x.g)}:</strong> no members \u2014 ${[x.openD ? _kn(x.openD, 'daily') : '', x.openW ? _kn(x.openW, 'weekend') : ''].filter(Boolean).join(' + ')} uncovered (${['daily', 'weekend'].filter(k => x[k === 'weekend' ? 'openW' : 'openD']).map(k => `${k === 'weekend' ? 'weekend' : 'weekday'}: ${_whyL(x, k)}`).join('; ')}).`
      : `<strong>${escHtml(x.g)}:</strong> no members and nobody lists it \u2014 ${[x.openD ? _kn(x.openD, 'daily') : '', x.openW ? _kn(x.openW, 'weekend') : ''].filter(Boolean).join(' + ')} uncovered.`).join('<br>');
    if(ml) html+=`<div class="note nw mb8" style="font-size:11px">${ml} <span class="txt3">A pool with no members is covered only by physicians who list it in their profile.</span></div>`;
  }

  if(limitedGaps>0)
    html+=`<div class="note nw mb8" >&#9888; <strong>${limitedGaps} slot(s) were left open rather than assign anyone past a limit.</strong> Nobody is given more than their fair share of the period or more than the Settings maximum for the year (${_maxLbl}, \u00d7 their FTE \u00d7 the part of the year they are on staff). Holiday call is counted on the Holiday tab and is not part of either limit.${_maxedNote} The open dates are listed at the bottom.</div>`;
  if(_rotOpen.length)
    html+=`<div class="note nw mb8" >&#9888; <strong>Conference rotation not assigned for part of this period.</strong> ${_rotOpen.map(r=>`\u201c${escHtml(r.name)}\u201d has no rotation assignment on ${r.n} date(s) from ${escHtml(r.first)}, so on those days every participant (${escHtml(r.who.join(', '))}) is treated as attending and is not given call.`).join(' ')} Generate the rotation first (Tumor Boards / Clinics) if only the assigned physician should be held back.</div>`;
  if(relaxedFills>0)
    html+=`<div class="note nw" style="margin-bottom:8px;background:var(--amber-bg);border-color:var(--amber)">&#9888; ${relaxedFills} slot(s) filled by relaxing a conference rule explicitly flagged <em>"allow break if IR schedule has unfilled slots"</em>. The assigned physician has a conference that day but admin opted-in to breaking the rule when needed to avoid gaps. Review before applying.</div>`;

  // Holiday weekends panel — a weekend a defined holiday touches is left to
  // holiday call (_irHolidayWeekend). Say which ones, and whether the Holiday
  // tab has someone on them yet: an unassigned one is nobody's call until then.
  // A pool with no members that nobody lists is reported in one line above (call pools, rs-v136): nobody can
  // take its holiday weekends either, so they are not listed here one by one.
  const _cpQuiet = new Set(_cpSum.filter(x => !x.members && !x.listed).map(x => x.g));
  const irExcluded = (S._lastIRAAExcludedHolidayWknds || []).filter(x => !_cpQuiet.has(x.group));
  if(irExcluded.length){
    const byGroup = {};
    irExcluded.forEach(x => {
      const g = x.group || '\u2014';
      (byGroup[g] = byGroup[g] || []).push(x);
    });
    const open = irExcluded.filter(x => x.heldBy == null).length;
    html += `<div class="note ${open ? 'nw' : 'ni'}" style="margin-bottom:10px;font-size:11px">
      <strong>\ud83c\udfd6 ${irExcluded.length} holiday weekend slot${irExcluded.length>1?'s':''} left to holiday call</strong> \u2014 a weekend with a holiday on any of its four days (Fri\u2192Mon) is not regular weekend call and does not count toward anyone's share or maximum.${open ? ` <strong>${open} ha${open>1?'ve':'s'} nobody assigned yet</strong> \u2014 assign ${open>1?'them':'it'} on the Holiday Call tab.` : ''}
      <div style="margin-top:6px;font-family:monospace;line-height:1.6;max-height:140px;overflow-y:auto">
        ${Object.entries(byGroup).map(([g, xs]) => `
          <div style="margin-top:4px"><strong style="font-family:sans-serif">${escHtml(g)}:</strong></div>
          ${xs.map(x => {
            const name = x.reason?.name || 'holiday';
            const who = x.heldBy != null ? `holiday call: ${escHtml(pname(x.heldBy))}` : '\u26a0 holiday call not assigned yet';
            return `&nbsp;&nbsp;Fri ${escHtml(x.friday)} \u2192 Mon ${escHtml(addDays(x.friday,3))} \u00b7 ${escHtml(name)} \u00b7 ${who}`;
          }).join('<br>')}
        `).join('')}
      </div>
    </div>`;
  }

  if(preview.length){
    html+='<div class="scroll-x"><table><thead><tr><th>Physician</th><th>Group</th><th>Date</th><th>Type</th><th>Covers</th></tr></thead><tbody>';
    // Cover for other pools (stage 2) is listed first, so it is not cut off below the first 60 rows.
    [...preview.filter(a=>a._cover),...preview.filter(a=>!a._cover)].slice(0,60).forEach(a=>{
      const dates=a.callType==='weekend'?`${a.date} \u2192 ${addDays(a.date,3)}`:a.date;
      const gSites=S.sites.filter(s=>s.irGroup===a.irGroup||s.irGroup==='Both').map(s=>s.name.split(' ')[0]).join(', ');
      const coverLbl=a.callType==='daily'?(gSites?`All ${a.irGroup} sites (${gSites})`:`${escHtml(a.irGroup)} call`)+(a._cover?' \u00b7 procedure shift at their own site':''):a.site;
      const rowStyle = a._overFte ? 'background:var(--red-bg,#fef2f2)'
                     : a._relaxedBreakable ? 'background:var(--amber-bg)'
                     : '';
      let passBadge = '';
      if(a._overFte) passBadge += `<span class="tag tr" style="font-size:9px;margin-left:4px" title="Assigned over FTE target — no other eligible physician">over FTE</span>`;
      if(a._relaxedBreakable) passBadge += `<span class="tag ta" style="font-size:9px;margin-left:4px;background:var(--amber-bg);color:var(--amber-t)" title="Conference rule broken — no other eligible physician and rule was flagged breakable">rule relaxed</span>`;
      if(a._cover) passBadge += `<span class="tag tgr" style="font-size:9px;margin-left:4px" title="Covers an open call of another pool they list in their profile">covering ${escHtml(a.irGroup)}</span>`;
      html+=`<tr style="${rowStyle}">
        <td>${pnameHtml(a.physId)}${passBadge}</td>
        <td><span class="tag ${irGroupColorClass(a.irGroup)}">${escHtml(String(a.irGroup))}</span></td>
        <td>${dates}</td>
        <td><span class="tag ${a.callType==='weekend'?'tpk':'tt'}">${a.callType}</span></td>
        <td style="font-size:11px;color:var(--txt2)">${coverLbl}</td></tr>`;
    });
    if(preview.length>60) html+=`<tr><td colspan="5" class="txt3">...and ${preview.length-60} more</td></tr>`;
    html+='</tbody></table></div>';
  }

  const tally=[];
  // Calls a physician holds in OTHER pools inside the period, by pool — on the schedule and this run's.
  const _cpOther=(p,kind,list)=>{ const m={}, own=p.irGroup||'';
    S.irCalls.forEach(c=>{ if(c.physId===p.id&&c.callType===kind&&_irIsCoverCall(c,p,_cpPools)&&c.date>=periodStart&&c.date<=periodEnd&&String(c.date).slice(0,4)===planYear&&!_isHolidaySyncedCall(c)) m[c.irGroup]=(m[c.irGroup]||0)+1; });
    list.forEach(a=>{ if(a.physId===p.id&&a.irGroup!==own) m[a.irGroup]=(m[a.irGroup]||0)+1; });
    return m; };
  irPs.filter(p=>grpFilter==='both'||p.irGroup===grpFilter||_cpVols.some(v=>v.p===p)).forEach(p=>{
    const L=lim[p.id]; if(!L||!L.D||!L.W) return;
    const row=(K,cnt,list,kind)=>{
      const tot=cnt[p.id]||0, yr=K.before+K.after+tot;                 // period total / calendar-year total (every pool), this run included
      const oth=_cpOther(p,kind,list), on=Object.values(oth).reduce((a,b)=>a+b,0), prim=tot-on, cov=!!K.coverOnly;
      const shown=cov?0:Math.max(K.base,K.share);                       // the FTE share, or the larger re-split share
      return { n:list.filter(a=>a.physId===p.id).length, tot, prim, oth, on, cov, yr, shown, up:!cov&&K.share>K.base+0.05,
               pct:shown>0?Math.round(prim/shown*100):0, over:!cov&&prim>K.cap, K };
    };
    tally.push({p, d:row(L.D,cntD,dailyPrev,'daily'), w:row(L.W,cntW,wkndPrev,'weekend')});
  });
  const _cpAnyOther=tally.some(t=>t.d.on||t.w.on||t.d.cov);
  if(tally.length){
    const anyUp=tally.some(t=>t.d.up||t.w.up);
    html+=`<div class="card" style="margin-top:10px"><div class="card-title" style="font-size:12px">FTE Distribution — ${label}
      <span style="font-size:10px;font-weight:400;color:var(--txt3);margin-left:6px">Fair share = this period's calls split by IR FTE (× the part of it each physician is on staff); vacation does not change it.${anyUp?' ↑ = includes calls a colleague cannot take (at their maximum, or away).':''} Max = Settings → FTE Caps for ${planYear} × FTE × part of the year on staff. Both are hard limits.</span>
    </div>
      <table class="fs-xs"><thead><tr><th>Physician</th><th>FTE</th>
        <th>Daily +new</th><th>${_cpAnyOther?'Daily own pool':'Daily total'}</th>${_cpAnyOther?'<th title="Weekday calls in other pools this period (cover)">Other pools</th>':''}<th title="Fair share of this period">Fair share</th><th title="Calls in ${planYear} / Settings maximum for ${planYear}">${planYear} / max</th><th>Daily %</th>
        <th>Wknd +new</th><th>${_cpAnyOther?'Wknd own pool':'Wknd total'}</th>${_cpAnyOther?'<th title="Weekend calls in other pools this period (cover)">Other pools</th>':''}<th title="Fair share of this period">Fair share</th><th title="Calls in ${planYear} / Settings maximum for ${planYear}">${planYear} / max</th><th>Wknd %</th>
      </tr></thead><tbody>`;
    const cells=r=>{
      const K=r.K, cls=r.over?'color:var(--red-t)':r.pct>=80?'color:var(--green-t)':'color:var(--txt2)';
      const mx=isFinite(K.max)
        ? `<span style="${r.yr>K.max?'color:var(--red-t);font-weight:700':r.yr>=K.max?'font-weight:700':''}">${r.yr} / ${K.max}</span>`
        : `<span title="No maximum set in Settings">${r.yr} / —</span>`;
      const oth=Object.entries(r.oth).map(([g,n])=>`${escHtml(g)} ${n}`).join(', ');
      return `<td style="text-align:center;color:var(--teal-t)">+${r.n}</td>
        <td class="tac">${r.prim}</td>
        ${_cpAnyOther?`<td class="tac"${oth?` title="${oth}"`:''}>${r.on?`+${r.on} <span class="txt3">(${oth})</span>`:'\u2014'}</td>`:''}
        <td class="tac txt3"${r.up?` title="FTE share ${K.base.toFixed(1)}; the rest is what colleagues cannot take"`:''}>${r.cov?'<span title="Takes call only in pools they list">\u2014</span>':r.shown.toFixed(1)}${r.up?' ↑':''}</td>
        <td class="tac txt3">${mx}</td>
        <td style="text-align:center;font-weight:700;${cls}">${r.cov?'\u2014':r.pct+'%'}</td>`;
    };
    tally.forEach(({p,d,w})=>{
      const _fr=_physYearFraction(p,planYear);
      const fteCell=_fr<1
        ? `<span title="${escHtml(_physStartNote(p,planYear))}">${p.irFte} × ${Math.round(_fr*100)}% = ${(Math.round(p.irFte*_fr*100)/100)}</span>`
        : `${p.irFte}`;
      html+=`<tr>
        <td class="fw6">${escHtml(p.last)}</td>
        <td class="tac">${fteCell}</td>
        ${cells(d)}
        ${cells(w)}
      </tr>`;
    });
    html+='</tbody></table></div>';
  }

  // IR physicians the builder never schedules: IR FTE but no IR group (or one
  // that is no longer in the list). They have no row above — say so.
  const _noGroup = irPs.filter(p => !getIRGroups().includes(p.irGroup) && !_physCallPools(p, _cpPools).length);
  if(_noGroup.length)
    html+=`<div class="note ni mt8" style="font-size:11px">Not scheduled for IR call: <strong>${_noGroup.map(p=>escHtml(p.last)).join(', ')}</strong> \u2014 IR FTE but no IR group. Set the group in the physician editor to include ${_noGroup.length>1?'them':'this physician'}.</div>`;

  if(gaps.length){
    // Show ALL gaps with their physician-by-physician breakdown so the admin
    // can see exactly what's blocking each. Legitimate blocks like vacation
    // or blackout mean those slots genuinely can't be filled. "FTE cap reached"
    // showing up only means the cap-waiver pass didn't run (shouldn't happen).
    html+=`<div class="note nw mt8" >
      <strong>\u26a0 ${gaps.length} unfilled slot(s) \u2014 nobody is eligible within the rules and limits.</strong>
      <div style="margin-top:6px;font-size:11px;font-family:monospace;line-height:1.7;max-height:240px;overflow-y:auto">
        ${gaps.map(g=>escHtml(g)).join('<br>')}
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--txt3)">
        Reason codes per physician: <strong>at fair share</strong> (already holds their share of this period), <strong>at Settings maximum</strong> (yearly maximum \u00d7 FTE \u00d7 part of year on staff; \u201cfor this point in the year\u201d when only part of the year is being built), <strong>vacation</strong>, <strong>not started yet</strong> (before their start date), <strong>sold-back</strong>, <strong>blackout</strong> (IR call blackout), <strong>2nd/3rd DR shift</strong>, <strong>already on IR this date</strong>, <strong>nearby weekend call</strong>, <strong>adjacent call</strong>, <strong>day condition</strong>, <strong>sequence rule</strong>, <strong>natural-language rule</strong>.
      </div>
    </div>`;
  }
  if(!preview.length&&!gaps.length&&!_cpUncovered)
    html='<div class="note ns">All IR call slots already filled for this period.</div>';

  document.getElementById('ira-box').innerHTML=html;
  document.getElementById('ira-apply').style.display=preview.length?'inline-block':'none';
}

function applyIRAA(){
  if(!_adminOnly('apply IR auto-assign'))return;
  if(!S.iraPreview.length){ if(typeof _toast==='function') _toast('Run Preview first to see what will be assigned.','info'); return; }
  // The limits were checked when Preview ran. If IR calls, the IR roster or the
  // Settings maximum changed since, this plan could pass a limit or double-book
  // a date — have it re-run.
  if(!previewIRAA._last || previewIRAA._last.stamp!==_iraStamp()){
    S.iraPreview=[];
    document.getElementById('ira-apply').style.display='none';
    document.getElementById('ira-box').innerHTML='<div class="note nw">Nothing was applied: IR calls, the IR roster, a vacation, shift or rule, or the Settings maximum changed after this preview was made. Click Preview again.</div>';
    if(typeof _toast==='function') _toast('The IR schedule or its limits changed since this preview \u2014 run Preview again.','warn');
    return;
  }
  const toApply=[...S.iraPreview];
  S.iraPreview=[];
  let procShiftsAdded=0;
  let procShiftsSkipped=0;
  const skippedLog=[];
  toApply.forEach(a=>{
    S.irCalls.push({id:S.nextId++,physId:a.physId,date:a.date,callType:a.callType,irGroup:a.irGroup,site:a.site,notes:a._cover?`Auto (covering ${a.irGroup})`:'Auto'});
    // Auto-create a 1st proc shift for daily calls where physician had none scheduled.
    // CRITICAL: if the physician has callDayRules that pin them to a specific
    // site when on call (e.g. "Greene: IR call → must be at CHN"), we MUST
    // honor that. Using irSitePrim blindly (Riverview for Greene) creates a
    // shift that directly violates the rule we just created the call against.
    //
    // rs-v82: dropped the `a.needsProcShift` gate — daily call now ALWAYS
    // auto-creates a paired shift when one doesn't exist. The `needsProcShift`
    // flag was set by the preview path only for some configurations, leaving
    // gaps where the user took call but had no procedure shift. Per policy
    // every daily call gets a matching procedure shift.
    if(a.callType==='daily'&&!_hasIRShiftOnDate(a.physId,a.date)){
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
      // Then all sites in the phys's OWN group (call pools: also when the call covers another pool).
      const _ownG = p.irGroup || '';
      (S.sites||[]).forEach(s => {
        if(_ownG && (s.irGroup === _ownG || s.irGroup === 'Both')) _push(s.name);
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
          kind: 'ir-shift', irGroup: _ownG,
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
          site:chosenSite,sub:'',notes:'Auto (with call)',irGroup:_ownG});
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
  const _nCover=toApply.filter(a=>a._cover).length;
  if(_nCover && typeof _audit==='function') _audit('irCall.coverAssign', {n:_nCover, pools:[...new Set(toApply.filter(a=>a._cover).map(a=>a.irGroup))]});
  triggerSave();
  _afterMutation();
  let note=procShiftsAdded?` · ${procShiftsAdded} proc shift(s) auto-created`:'';
  if(procShiftsSkipped) note+=` · ${procShiftsSkipped} proc shift(s) skipped (no rule-valid site)`;
  let html=`<div class="note ns">${n} IR call assignment(s) applied across ${_iraPeriodLabel(_iraMonths())}${note}.</div>`;
  if(skippedLog.length){
    html+=`<div class="note nw mt8" ><strong>Proc shifts not auto-created:</strong><br>
      <span style="font-family:monospace;font-size:11px">${skippedLog.map(escHtml).join('<br>')}</span></div>`;
  }
  document.getElementById('ira-box').innerHTML=html;
  document.getElementById('ira-apply').style.display='none';
}
