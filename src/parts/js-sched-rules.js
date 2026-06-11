/**
 * siteRuleOk(p, siteName, ym, date, shiftKey)
 * Returns true if physician p is allowed at siteName for shiftKey on date.
 * Checks: site blocked flag, blackout date ranges, monthly cap, shift-type cap.
 */
function siteRuleOk(p, siteName, ym, date, shiftKey){
  const rules = (p.siteRules||[]);
  const rule  = rules.find(r=>r.site===siteName);
  if(!rule) return true;                        // no rule = unrestricted
  if(rule.blocked) return false;                // hard block
  // Blackout date ranges
  if((rule.blackouts||[]).some(b=>date>=b.start&&date<=b.end)) return false;
  // Allowed shift types (shiftKey='s1'|'s2'|'s3'|'home', allowedShifts stores '1st'|'2nd'|'3rd'|'wknd'|'ir')
  if(rule.allowedShifts?.length && shiftKey){
    const keyMap={s1:'1st',s2:'2nd',s3:'3rd',home:'home'};
    const shiftName=keyMap[shiftKey]||shiftKey;
    if(!rule.allowedShifts.includes(shiftName) && !rule.allowedShifts.includes(shiftKey)) return false;
  }
  // Per-month cap for this site
  if(rule.maxPerMonth){
    const used = S.drShifts.filter(s=>
      s.physId===p.id && s.date.startsWith(ym) && s.site===siteName
    ).length;
    if(used >= rule.maxPerMonth) return false;
  }
  // Per-week cap for this site
  if(rule.maxPerWeek){
    // Get week boundaries for this date (Mon–Sun)
    const d = parseDateLocal(date);
    const dow = d.getDay();
    const weekMon = addDays(date, -(dow===0?6:dow-1));
    const weekSun = addDays(weekMon, 6);
    const usedWk = S.drShifts.filter(s=>
      s.physId===p.id && s.site===siteName &&
      s.date >= weekMon && s.date <= weekSun
    ).length;
    if(usedWk >= rule.maxPerWeek) return false;
  }
  return true;
}
/**
 * dayConditionSiteOk(p, siteName, date, context)
 * Returns true if the physician is eligible to work at siteName on the given date
 * based on day-of-week restrictions in their site rules.
 * context: 'dr-shift' | 'ir-call' | 'ir-shift'
 */
// IR-specific site rule check — checks blocked/blackout/allowedShifts
// but NOT maxPerMonth/maxPerWeek (those count S.drShifts and are DR-only).
// Used for IR PROCEDURE SHIFTS. IR call has its own check (irCallSiteRuleOk)
// so admins can allow procedure shifts without allowing call, or vice versa.
function irSiteRuleOk(p, siteName, date){
  const rule = (p.siteRules||[]).find(r => r.site===siteName);
  if(!rule) return true;                          // no rule = unrestricted
  if(rule.blocked) return false;                  // hard blocked from this site
  if((rule.blackouts||[]).some(b => date>=b.start && date<=b.end)) return false;
  // If allowedShifts is set, require 'ir-shift' (new explicit code) or 'ir'
  // (legacy — meant "both IR types"). Legacy back-compat matters because
  // older snapshots saved rules with 'ir' and those should continue to
  // allow procedure shifts until the admin re-opens the rule.
  if(rule.allowedShifts?.length){
    const allowed = rule.allowedShifts;
    if(!allowed.includes('ir-shift') && !allowed.includes('ir')) return false;
  }
  return true;
}

// IR call–specific site rule check. Mirrors irSiteRuleOk but gates on
// 'ir-call' instead of 'ir-shift'. Legacy 'ir' allows call too.
function irCallSiteRuleOk(p, siteName, date){
  const rule = (p.siteRules||[]).find(r => r.site===siteName);
  if(!rule) return true;
  if(rule.blocked) return false;
  if((rule.blackouts||[]).some(b => date>=b.start && date<=b.end)) return false;
  if(rule.allowedShifts?.length){
    const allowed = rule.allowedShifts;
    if(!allowed.includes('ir-call') && !allowed.includes('ir')) return false;
  }
  return true;
}

function dayConditionSiteOk(p, siteName, date, context){
  // context: 'dr-shift' | 'ir-call' | 'ir-shift' | any
  const conds = (p.dayConditions||[]);
  if(!conds.length) return true;
  const dow = parseDateLocal(date).getDay();
  for(const c of conds){
    if(c.dow !== dow) continue;
    // schedType filter
    if(c.schedType && c.schedType !== 'any' && c.schedType !== context) continue;
    // If a requiredSite is specified, the physician MUST be at that site
    if(c.requiredSite && c.requiredSite !== siteName) return false;
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CONFERENCE RULES (tumor boards / clinics) + CALL-DAY SITE RULES
   ═══════════════════════════════════════════════════════════════════════════
   Two new physician-rule families share this section:

   1. p.tbRules[] = [{eventId|null, action, n?, requiredSite?, shift?, notes}]
      eventId — id of a tumor board OR clinic; null = applies to ALL
                conferences this physician participates in.
      action  — one of:
        'no-call-on-day'         → block any IR/weekend call on the event date
        'no-shift-on-day'        → block any DR/IR shift on the event date
        'must-be-at-site-on-day' → DR shift on event date must be requiredSite
        'schedule-shift-prior'   → REQUIRE a day shift on date - n  (preference; flagged
                                   but does not block — auto-assign uses it as a hint)
        'schedule-shift-after'   → REQUIRE a day shift on date + n  (same — preference)
        'block-day-prior'        → block any shift on date - n
        'block-day-after'        → block any shift on date + n
        'prefer-light-day'       → block 2nd / 3rd shift on the event date

   2. p.callDayRules[] = [{callType, requiredSite, shift?, notes}]
      callType — 'ir-call' | 'ir-weekend' | 'weekend-call' | 'any-call'
      requiredSite — site the day shift on the same date must be at
      shift — optional restrict to a specific shift type (default any day shift)

   Both rule families short-circuit to "true" (no rule) when the physician
   has no rules of that family — zero overhead for physicians with no
   conference involvement.
*/

// Resolve the conference event by id, across both collections. Returns null
// if not found (e.g. a stale rule referencing a deleted board).
function _eventById(eventId){
  if(eventId == null) return null;
  return (S.tumorBoards||[]).find(t => t.id === eventId)
      || (S.clinics||[]).find(c => c.id === eventId)
      || null;
}

// Returns the set of ISO dates in [startISO, endISO] on which physId has
// at least one tumor-board or clinic occurrence (after rotation gating).
// Used by tbRulesOk to find rule-relevant dates relative to the candidate.
function _conferenceDatesForPhys(physId, startISO, endISO, eventId){
  const out = new Set();
  const visit = (item) => {
    if(!(item.allowedPhysIds||[]).includes(physId)) return;
    const occs = _eventOccurrencesInRange(item, startISO, endISO);
    for(const d of occs){
      if(item.rotation && item.rotation.enabled){
        const ids = _rotationPhysIdsFor(item, d);
        // Fail-safe: ungated when no stored assignment exists. Mirrors
        // calendar feed and digest behavior so conference rules don't
        // mysteriously stop firing when assignments age out.
        if(ids.length && !ids.includes(physId)) continue;
      }
      out.add(d);
    }
  };
  if(eventId == null){
    (S.tumorBoards||[]).forEach(visit);
    (S.clinics||[]).forEach(visit);
  } else {
    const ev = _eventById(eventId);
    if(ev) visit(ev);
  }
  return out;
}

/**
 * _conferenceDatesForEvent — return the set of occurrence dates for a SPECIFIC
 * event in [startISO, endISO], ignoring whether the physician is listed as a
 * participant. Used by explicit per-physician tbRules: when an admin
 * configures "no IR shift on Vein Clinic day for Dr. X", the admin is
 * asserting Dr. X is affected regardless of the clinic's allowedPhysIds list
 * (which exists for scheduling the clinic itself, not for rule scoping).
 *
 * Previously tbRulesOk only used _conferenceDatesForPhys, which REQUIRES the
 * physician be in allowedPhysIds — so rules tied to a conference the
 * physician doesn't participate in silently returned zero dates and the rule
 * never fired. Rotation gating still applies: if the event has rotation
 * enabled and a stored assignment doesn't include the physician, the day
 * won't match. Events with no stored rotation fall through to all
 * occurrences (same fail-safe semantics as the sibling helper).
 */
function _conferenceDatesForEvent(physId, startISO, endISO, eventId){
  const out = new Set();
  if(eventId == null) return out;
  const ev = _eventById(eventId);
  if(!ev) return out;
  const occs = _eventOccurrencesInRange(ev, startISO, endISO);
  for(const d of occs){
    if(ev.rotation && ev.rotation.enabled){
      const ids = _rotationPhysIdsFor(ev, d);
      if(ids.length && !ids.includes(physId)) continue;
    }
    out.add(d);
  }
  return out;
}

// Add/subtract days from an ISO date, returning ISO. Wraps the existing
// addDays helper if available; otherwise computes locally.
function _isoShift(iso, deltaDays){
  if(typeof addDays === 'function') return addDays(iso, deltaDays);
  const d = parseDateLocal(iso); if(!d) return iso;
  d.setDate(d.getDate() + deltaDays);
  return fmtDate(d);
}

/**
 * tbRulesOk(p, ctx) — evaluate all conference rules for the candidate
 * assignment. Returns true if every rule allows the assignment, false on
 * the first violation. Preference-style rules ('schedule-shift-prior/after',
 * 'prefer-light-day' for 1st-shift cases) never block; only the explicit
 * block actions return false.
 *
 * ctx = {physId, date, site?, shift?, kind}
 *   kind ∈ {'dr-shift','ir-shift','ir-call','ir-weekend','dr-weekend','holiday'}
 */
function tbRulesOk(p, ctx, opts){
  const rules = (p && p.tbRules) || [];
  if(!rules.length) return true;
  if(!ctx || !ctx.date) return true;
  // opts.allowRelaxBreakable: when true, skip (ignore) rules flagged with
  // allowBreakForUnfilledIR. Auto-assign uses this in a relaxation retry when
  // the primary pass couldn't fill a slot; breakable rules are dropped so a
  // physician can be placed despite a conference conflict, rather than leaving
  // the schedule with a hole.
  const allowRelax = !!(opts && opts.allowRelaxBreakable);
  for(const r of rules){
    if(!r || !r.action) continue;
    if(allowRelax && r.allowBreakForUnfilledIR) continue;

    // Resolve the rule's day-offset range. Supports both new nMin/nMax and
    // legacy single-n schema. All actions that use offsets iterate the full
    // range so a "1-3 days before" rule covers every day in that window.
    const nMin = (r.nMin != null) ? Math.max(0, +r.nMin)
               : (r.n    != null) ? Math.max(0, +r.n)    : 0;
    const nMax = (r.nMax != null) ? Math.max(nMin, +r.nMax) : nMin;

    // Occurrence lookup window: widest possible span covering the rule.
    const startISO = _isoShift(ctx.date, -nMax);
    const endISO   = _isoShift(ctx.date,  nMax);
    // For rules scoped to a SPECIFIC event, use the event-based helper so the
    // rule fires regardless of whether the physician is in allowedPhysIds.
    // An admin configuring "no IR shift on Vein Clinic day for Dr. X" is
    // asserting the rule applies to Dr. X — the clinic's allowedPhysIds is
    // for scheduling the clinic itself, not for scoping per-physician rules.
    // For rules scoped to "any conference" (eventId null), participant gating
    // still applies — otherwise the rule would fire on every conference in
    // the system, which is never what an admin means.
    const occDates = (r.eventId != null)
      ? _conferenceDatesForEvent(p.id, startISO, endISO, r.eventId)
      : _conferenceDatesForPhys(p.id, startISO, endISO, r.eventId);
    if(!occDates.size) continue;

    if(r.action === 'no-call-on-day'){
      if(ctx.kind !== 'ir-call' && ctx.kind !== 'ir-weekend' &&
         ctx.kind !== 'dr-weekend' && ctx.kind !== 'holiday') continue;
      if(occDates.has(ctx.date)) return false;
    }
    else if(r.action === 'no-shift-on-day'){
      if(ctx.kind !== 'dr-shift' && ctx.kind !== 'ir-shift') continue;
      if(occDates.has(ctx.date)) return false;
    }
    else if(r.action === 'must-be-at-site-on-day'){
      if(ctx.kind !== 'dr-shift' && ctx.kind !== 'ir-shift') continue;
      if(!occDates.has(ctx.date)) continue;
      if(!r.requiredSite) continue;
      if(ctx.site !== r.requiredSite) return false;
      if(r.shift && ctx.shift && ctx.shift !== r.shift) return false;
    }
    else if(r.action === 'block-day-prior'){
      // Block if ctx.date falls in [nMin, nMax] days BEFORE any occurrence.
      for(const occ of occDates){
        for(let k = Math.max(1, nMin); k <= Math.max(1, nMax); k++){
          if(_isoShift(occ, -k) === ctx.date) return false;
        }
      }
    }
    else if(r.action === 'block-day-after'){
      for(const occ of occDates){
        for(let k = Math.max(1, nMin); k <= Math.max(1, nMax); k++){
          if(_isoShift(occ, k) === ctx.date) return false;
        }
      }
    }
    else if(r.action === 'prefer-light-day'){
      if(ctx.kind !== 'dr-shift' && ctx.kind !== 'ir-shift') continue;
      if(!occDates.has(ctx.date)) continue;
      const sh = ctx.shift || '';
      if(sh === '2nd' || sh === '3rd') return false;
    }
    // 'schedule-shift-prior' / 'schedule-shift-after' are PREFERENCES only —
    // they nudge auto-assign but never block. _conferenceShiftPreferenceFor
    // exposes them to the assignment scorer as a hint.
  }
  return true;
}

/**
 * Returns a small score adjustment (+/-) for a candidate based on the
 * physician's prefer-style conference rules. Negative = preferred (auto-assign
 * sorts ascending in many places). Currently +/- 1 per matched preference.
 * Safe to call even when no rules exist — returns 0.
 */
function _conferenceShiftPreferenceFor(p, ctx){
  const rules = (p && p.tbRules) || [];
  if(!rules.length) return 0;
  if(!ctx || !ctx.date) return 0;
  if(ctx.kind !== 'dr-shift' && ctx.kind !== 'ir-shift') return 0;
  let score = 0;
  for(const r of rules){
    if(r.action !== 'schedule-shift-prior' && r.action !== 'schedule-shift-after') continue;
    // shiftKind filter: if rule is scoped to a specific kind (dr-shift or
    // ir-shift), only apply the preference when the candidate matches.
    if(r.shiftKind && r.shiftKind !== ctx.kind) continue;
    // Resolve offset range.
    const nMin = (r.nMin != null) ? Math.max(0, +r.nMin)
               : (r.n    != null) ? Math.max(0, +r.n)    : 1;
    const nMax = (r.nMax != null) ? Math.max(nMin, +r.nMax) : nMin;
    const startISO = _isoShift(ctx.date, -nMax);
    const endISO   = _isoShift(ctx.date,  nMax);
    // Use event-based lookup for explicit per-event rules; participant gating
    // only applies to "any conference" scope. See tbRulesOk for rationale.
    const occDates = (r.eventId != null)
      ? _conferenceDatesForEvent(p.id, startISO, endISO, r.eventId)
      : _conferenceDatesForPhys(p.id, startISO, endISO, r.eventId);
    for(const occ of occDates){
      for(let k = Math.max(0, nMin); k <= Math.max(0, nMax); k++){
        const target = r.action === 'schedule-shift-prior'
          ? _isoShift(occ, -k)
          : _isoShift(occ, k);
        if(target === ctx.date){ score--; break; } // prefer this date
      }
    }
  }
  return score;
}

/**
 * callDayRulesOk(p, ctx) — enforces per-physician rules that tie day-shift
 * site to call assignment. Two directions:
 *
 * Direction 1 (original): candidate is a DAY SHIFT and the physician is
 *   already on call that day. The rule's requiredSite must match the day
 *   shift's site. Prevents admins from scheduling a call physician's day
 *   shift at the wrong site.
 *
 * Direction 2 (added): candidate is a CALL (ir-call / ir-weekend / weekend)
 *   and the physician has an existing day shift on that date. The rule's
 *   requiredSite must match the existing day shift's site — e.g. a rule
 *   "IR call only when scheduled at North" blocks call assignment on a day
 *   the physician is scheduled at Riverview. Before this added direction,
 *   IR call auto-assign would ignore these rules entirely and happily
 *   assign calls regardless of where the physician was physically working.
 *
 * Returns true if no rule blocks; false if any matching rule fails.
 */
function callDayRulesOk(p, ctx){
  const rules = (p && p.callDayRules) || [];
  if(!rules.length) return true;
  if(!ctx || !ctx.date) return true;
  const date = ctx.date;

  // Normalize site strings: trim whitespace and lowercase. Historical cause of
  // "rule doesn't fire" reports: rule stored 'CHN ' (trailing space) while
  // shift stored 'CHN', or case mismatch ('Chn' vs 'CHN'). Strict equality
  // silently skipped the rule. Normalization is the forgiving default.
  const _ns = s => (s||'').toString().trim().toLowerCase();

  // Direction 1: day-shift candidate, check existing call
  if(ctx.kind === 'dr-shift' || ctx.kind === 'ir-shift'){
    const callsToday = {
      'ir-call': false, 'ir-weekend': false, 'weekend-call': false
    };
    (S.irCalls||[]).forEach(c => {
      if(c.physId !== p.id) return;
      if(c.callType === 'weekend'){
        // Weekend call covers Fri → Mon (4 consecutive days). Previously
        // this function only matched c.date === date, which meant a
        // physician on weekend call Fri 6/5 → Mon 6/8 appeared "on call"
        // only on 6/5 for rule-checking. Their Monday day shift wasn't
        // gated against the rule, letting it be placed at Riverview
        // even when the physician had an "on weekend call → CHN" rule.
        if(date >= c.date && date <= addDays(c.date, 3)){
          callsToday['ir-weekend'] = true;
        }
      } else {
        if(c.date === date) callsToday['ir-call'] = true;
      }
    });
    (S.weekendCalls||[]).forEach(w => {
      if(w.physId !== p.id) return;
      if(w.satDate === date || w.sunDate === date || w.date === date) callsToday['weekend-call'] = true;
    });
    for(const r of rules){
      if(!r || !r.requiredSite) continue;
      const ct = r.callType || 'any-call';
      // "any-call" scope means "this rule fires when the physician is on
      // ANY of the tracked call types" — NOT "always fires". Without this
      // distinction, an 'any-call → CHN' rule would block the physician
      // from every site except CHN for EVERY day shift, even on days when
      // the physician isn't on call at all. Prior to this fix, the legacy-
      // rule migration (ir-call → any-call) created exactly this cascade:
      // every migrated physician was effectively pinned to CHN every
      // working day.
      const isOnAnyCall = callsToday['ir-call'] || callsToday['ir-weekend'] || callsToday['weekend-call'];
      const matchesCall = (ct === 'any-call') ? isOnAnyCall : !!callsToday[ct];
      if(!matchesCall) continue;
      if(r.shift && ctx.shift && ctx.shift !== r.shift) continue;
      // shiftKind filter: if rule is scoped to only dr-shift or only ir-shift,
      // skip candidates of the other kind. Default (empty) applies to both.
      if(r.shiftKind && r.shiftKind !== ctx.kind) continue;
      if(_ns(ctx.site) !== _ns(r.requiredSite)) return false;
    }
    return true;
  }

  // Direction 2: call-candidate, check existing day shift
  // ctx.kind ∈ {'ir-call', 'ir-weekend', 'dr-weekend'}.
  if(ctx.kind === 'ir-call' || ctx.kind === 'ir-weekend' || ctx.kind === 'dr-weekend'){
    // Figure out which callType(s) the candidate represents, since rules
    // can scope to a specific call type.
    const candCallType = ctx.kind === 'ir-call'     ? 'ir-call'
                       : ctx.kind === 'ir-weekend'  ? 'ir-weekend'
                       : 'weekend-call';
    for(const r of rules){
      if(!r || !r.requiredSite) continue;
      const ct = r.callType || 'any-call';
      // Only apply rules that target this call type (or any-call)
      if(ct !== 'any-call' && ct !== candCallType) continue;
      // Find the physician's EXISTING day shift on this date (or across the
      // weekend span for weekend call). If they have no day shift, the rule
      // doesn't block — the requirement is about WHERE they're working,
      // not about whether they're working.
      const datesToCheck = (candCallType === 'ir-weekend' || candCallType === 'weekend-call')
        ? [date, addDays(date,1), addDays(date,2), addDays(date,3)]
        : [date];
      // Does ANY day in the span include an existing shift that conflicts
      // with the required site? If the rule's shift filter is set, only
      // check shifts of that type. If shiftKind is set (dr-shift only or
      // ir-shift only), only collect shifts of that kind — a rule scoped to
      // "IR day shift only" should ignore DR shifts when checking existing
      // placements, and vice versa.
      for(const d of datesToCheck){
        const existingShifts = [];
        if(r.shiftKind !== 'dr-shift'){
          (S.irShifts||[]).forEach(s => {
            if(s.physId !== p.id || s.date !== d) return;
            if(s.shift === 'Home') return;
            if(r.shift && s.shift !== r.shift) return;
            existingShifts.push(s);
          });
        }
        if(r.shiftKind !== 'ir-shift'){
          (S.drShifts||[]).forEach(s => {
            if(s.physId !== p.id || s.date !== d) return;
            if(s.shift === 'Home') return;
            if(r.shift && s.shift !== r.shift) return;
            existingShifts.push(s);
          });
        }
        // If the physician has a shift on this date and NONE of them is at
        // the required site, the rule blocks. If they have no shift, the
        // rule is silent for this date.
        if(existingShifts.length && !existingShifts.some(s => _ns(s.site) === _ns(r.requiredSite))){
          return false;
        }
      }
    }
    return true;
  }

  return true;
}

// ── Conference-rules tab UI ─────────────────────────────────────────────

// Repopulate the event picker. Called when tab opens or after add/delete.
function _srRefreshTBEventOptions(){
  const sel = document.getElementById('sr-tb-event'); if(!sel) return;
  const tbs = (S.tumorBoards||[]).map(t => ({id:t.id, label:`🔬 ${t.name}`}));
  const cls = (S.clinics||[]).map(c => ({id:c.id, label:`🏥 ${c.name}`}));
  const opts = [{id:'', label:'— Any conference (all I attend) —'}].concat(tbs, cls);
  const cur = sel.value;
  sel.innerHTML = opts.map(o => `<option value="${o.id===''?'':o.id}">${_tbEsc(o.label)}</option>`).join('');
  if(cur) sel.value = cur;
  // Also populate the required-site dropdown
  const siteSel = document.getElementById('sr-tb-site');
  if(siteSel){
    const prev = siteSel.value;
    siteSel.innerHTML = (S.sites||[]).map(s => `<option value="${_tbEsc(s.name)}">${_tbEsc(s.name)}</option>`).join('');
    if(prev) siteSel.value = prev;
  }
}

// Show/hide the action-specific input groups when the action picker changes.
function _srTBOnActionChange(){
  const action = document.getElementById('sr-tb-action')?.value;
  const numWrap   = document.getElementById('sr-tb-numeric-wrap');
  const siteWrap  = document.getElementById('sr-tb-site-wrap');
  const kindWrap  = document.getElementById('sr-tb-shiftkind-wrap');
  // N (days) — both the "block" and "schedule-shift" variants need this.
  const needsN = ['schedule-shift-prior','schedule-shift-after','block-day-prior','block-day-after'].includes(action);
  if(numWrap) numWrap.style.display = needsN ? '' : 'none';
  // Required-site picker is only for must-be-at-site-on-day
  const needsSite = action === 'must-be-at-site-on-day';
  if(siteWrap) siteWrap.style.display = needsSite ? '' : 'none';
  // Shift-kind picker (DR / IR / Any) only for schedule-shift-*
  const needsKind = action === 'schedule-shift-prior' || action === 'schedule-shift-after';
  if(kindWrap) kindWrap.style.display = needsKind ? '' : 'none';
}

// Tracks whether the Conference-rule form is in "edit" mode. When non-null,
// saveTBRule replaces tbRules[_editingTBRuleIdx] instead of appending.
let _editingTBRuleIdx = null;

// Load an existing rule into the form for editing.
function startEditTBRule(idx){
  if(!_adminOnly('edit conference rule')) return;
  const p = S.physicians.find(x => x.id === _srPhysId);
  if(!p || !Array.isArray(p.tbRules) || !p.tbRules[idx]) return;
  const r = p.tbRules[idx];
  _editingTBRuleIdx = idx;
  _srRefreshTBEventOptions();
  const set = (id, v) => { const el = document.getElementById(id); if(el) el.value = v == null ? '' : v; };
  set('sr-tb-event',   r.eventId == null ? '' : String(r.eventId));
  set('sr-tb-action',  r.action || '');
  // Range fields: honor nMin/nMax if present, fall back to legacy n.
  const legacyN = (r.n != null) ? r.n : 1;
  set('sr-tb-num-min', r.nMin != null ? r.nMin : legacyN);
  set('sr-tb-num-max', r.nMax != null && r.nMax !== r.nMin ? r.nMax : '');
  set('sr-tb-site',    r.requiredSite || '');
  set('sr-tb-shift',   r.shift || '');
  set('sr-tb-shiftkind', r.shiftKind || '');
  set('sr-tb-notes',   r.notes || '');
  const breakEl = document.getElementById('sr-tb-breakable');
  if(breakEl) breakEl.checked = !!r.allowBreakForUnfilledIR;
  _srTBOnActionChange();
  // Swap the button labels so it's clear we're editing.
  const addBtn = document.getElementById('sr-tb-add-btn');
  const canBtn = document.getElementById('sr-tb-cancel-btn');
  const note   = document.getElementById('sr-tb-edit-note');
  if(addBtn) addBtn.textContent = '✓ Update Rule';
  if(canBtn) canBtn.style.display = 'inline-block';
  if(note)   note.style.display = 'inline-block';
  // Scroll form into view so the admin sees it react to the click.
  document.getElementById('srt-tb')?.scrollIntoView({behavior:'smooth',block:'center'});
}

// Revert edit mode and reset form labels.
function cancelEditTBRule(){
  _editingTBRuleIdx = null;
  const addBtn = document.getElementById('sr-tb-add-btn');
  const canBtn = document.getElementById('sr-tb-cancel-btn');
  const note   = document.getElementById('sr-tb-edit-note');
  if(addBtn) addBtn.textContent = '＋ Add Conference Rule';
  if(canBtn) canBtn.style.display = 'none';
  if(note)   note.style.display = 'none';
  // Clear fields back to defaults
  const set = (id, v) => { const el = document.getElementById(id); if(el) el.value = v; };
  set('sr-tb-event', '');
  set('sr-tb-action', 'no-call-on-day');
  set('sr-tb-num-min', '1');
  set('sr-tb-num-max', '');
  set('sr-tb-site', '');
  set('sr-tb-shift', '');
  set('sr-tb-shiftkind', '');
  set('sr-tb-notes', '');
  const breakEl = document.getElementById('sr-tb-breakable');
  if(breakEl) breakEl.checked = false;
  _srTBOnActionChange();
}

// Save the currently-edited rule OR append a new one.
function saveTBRule(){
  if(!_adminOnly(_editingTBRuleIdx != null ? 'edit conference rule' : 'add conference rule')) return;
  const p = S.physicians.find(x => x.id === _srPhysId);
  if(!p){ alert('No physician selected.'); return; }
  const eventIdRaw = document.getElementById('sr-tb-event')?.value;
  let eventId = null;
  if(eventIdRaw !== '' && eventIdRaw != null){
    eventId = +eventIdRaw;
    const ev = _eventById(eventId);
    if(!ev){
      _srRefreshTBEventOptions();
      alert('That conference no longer exists. The dropdown has been refreshed — please pick again.');
      return;
    }
  }
  const action = document.getElementById('sr-tb-action')?.value;
  if(!action){ _toast('Pick a rule type.', 'err'); return; }

  const rule = {
    eventId,
    action,
    notes: (document.getElementById('sr-tb-notes')?.value || '').trim(),
    allowBreakForUnfilledIR: !!document.getElementById('sr-tb-breakable')?.checked,
  };
  if(['schedule-shift-prior','schedule-shift-after','block-day-prior','block-day-after'].includes(action)){
    const minV = Math.max(0, +(document.getElementById('sr-tb-num-min')?.value) || 1);
    const maxRaw = (document.getElementById('sr-tb-num-max')?.value || '').trim();
    const maxV = maxRaw === '' ? minV : Math.max(0, +maxRaw);
    rule.nMin = Math.min(minV, maxV);
    rule.nMax = Math.max(minV, maxV);
    // Keep legacy n for back-compat with any older code path still reading it.
    rule.n = rule.nMin;
  }
  if(action === 'must-be-at-site-on-day'){
    rule.requiredSite = document.getElementById('sr-tb-site')?.value || '';
    if(!rule.requiredSite){ _toast('Pick a required site.', 'err'); return; }
    const sh = document.getElementById('sr-tb-shift')?.value || '';
    if(sh) rule.shift = sh;
  }
  if(action === 'schedule-shift-prior' || action === 'schedule-shift-after'){
    const kind = document.getElementById('sr-tb-shiftkind')?.value || '';
    if(kind) rule.shiftKind = kind; // '' = any, 'dr-shift', 'ir-shift'
  }

  if(!Array.isArray(p.tbRules)) p.tbRules = [];

  if(_editingTBRuleIdx != null){
    // Update existing rule in place.
    if(!p.tbRules[_editingTBRuleIdx]){
      alert('The rule you were editing no longer exists. It may have been removed in another window.');
      _editingTBRuleIdx = null;
      cancelEditTBRule();
      renderSiteRulesList();
      return;
    }
    p.tbRules[_editingTBRuleIdx] = rule;
    _editingTBRuleIdx = null;
  } else {
    // Block exact duplicates so admins can't accidentally double a rule.
    const existing = p.tbRules.find(r =>
      r.action === rule.action &&
      (r.eventId||null) === (rule.eventId||null) &&
      (r.nMin||null) === (rule.nMin||null) &&
      (r.nMax||null) === (rule.nMax||null) &&
      (r.requiredSite||'') === (rule.requiredSite||'') &&
      (r.shift||'') === (rule.shift||'') &&
      (r.shiftKind||'') === (rule.shiftKind||'')
    );
    if(existing){ alert('That exact rule already exists for this physician.'); return; }
    p.tbRules.push(rule);
  }

  cancelEditTBRule(); // reset form + labels
  triggerSave();
  _afterMutation();
  renderSiteRulesList();
}

// Legacy alias — any stray inline onclick still calling addTBRule works.
function addTBRule(){ return saveTBRule(); }

function removeTBRule(idx){
  if(!_adminOnly('remove conference rule')) return;
  const p = S.physicians.find(x => x.id === _srPhysId);
  if(!p || !Array.isArray(p.tbRules)) return;
  // If the admin is currently editing this rule, cancel edit mode first.
  if(_editingTBRuleIdx === idx) cancelEditTBRule();
  else if(_editingTBRuleIdx != null && _editingTBRuleIdx > idx) _editingTBRuleIdx--;
  p.tbRules.splice(idx, 1);
  triggerSave();
  _afterMutation();
  renderSiteRulesList();
}

// ── Call-day-site rule UI ───────────────────────────────────────────────

function _srRefreshCallSiteSiteOptions(){
  const sel = document.getElementById('sr-cs-site'); if(!sel) return;
  const prev = sel.value;
  sel.innerHTML = (S.sites||[]).map(s => `<option value="${_tbEsc(s.name)}">${_tbEsc(s.name)}</option>`).join('');
  if(prev) sel.value = prev;
}

function addCallSiteRule(){
  if(!_adminOnly('add call-day site rule')) return;
  const p = S.physicians.find(x => x.id === _srPhysId);
  if(!p){ alert('No physician selected.'); return; }
  const callType = document.getElementById('sr-cs-calltype')?.value;
  const requiredSite = document.getElementById('sr-cs-site')?.value;
  if(!callType || !requiredSite){ _toast('Pick call type and required site.', 'err'); return; }
  // Validate the site is still in S.sites — admin may have deleted it from
  // another window since the modal opened.
  if(!(S.sites||[]).some(s => s.name === requiredSite)){
    _srRefreshCallSiteSiteOptions();
    alert(`Site "${requiredSite}" no longer exists. The dropdown has been refreshed — please pick again.`);
    return;
  }
  const shift = document.getElementById('sr-cs-shift')?.value || '';
  const shiftKind = document.getElementById('sr-cs-shiftkind')?.value || '';
  const notes = (document.getElementById('sr-cs-notes')?.value || '').trim();
  if(!Array.isArray(p.callDayRules)) p.callDayRules = [];
  const editIdx = _editingStructIdx.callSite;
  // When editing, we splice-replace by index. Skip the duplicate check against
  // the entry we're editing (it'd always match), but still block dupes against
  // OTHER entries.
  const existing = p.callDayRules.findIndex((r, i) =>
    i !== editIdx &&
    r.callType === callType &&
    r.requiredSite === requiredSite &&
    (r.shift||'') === (shift||'') &&
    (r.shiftKind||'') === (shiftKind||'')
  );
  if(existing >= 0){ alert('That call-day site rule already exists for this physician.'); return; }
  const rule = {callType, requiredSite, notes};
  if(shift) rule.shift = shift;
  if(shiftKind) rule.shiftKind = shiftKind;
  if(editIdx != null && p.callDayRules[editIdx]){
    p.callDayRules[editIdx] = rule;
    _editingStructIdx.callSite = null;
  } else {
    p.callDayRules.push(rule);
  }
  const notesEl = document.getElementById('sr-cs-notes'); if(notesEl) notesEl.value = '';
  triggerSave();
  _afterMutation();
  renderSiteRulesList();
}

function removeCallSiteRule(idx){
  if(!_adminOnly('remove call-day site rule')) return;
  const p = S.physicians.find(x => x.id === _srPhysId);
  if(!p || !Array.isArray(p.callDayRules)) return;
  p.callDayRules.splice(idx, 1);
  triggerSave();
  _afterMutation();
  renderSiteRulesList();
}

// ── Display strings for the rule-list section ────────────────────────────

// Human-readable label for a tbRule. Used in renderSiteRulesList.
function _describeTBRule(r){
  const ev = _eventById(r.eventId);
  const evName = ev ? ev.name : (r.eventId == null ? 'any conference' : `(deleted #${r.eventId})`);
  const evIcon = !ev ? '⚠' : (S.tumorBoards||[]).some(t=>t.id===r.eventId) ? '🔬' : '🏥';
  // For *-prior / *-after actions, render either a single N or a range min–max.
  const nRange = () => {
    const mn = (r.nMin != null) ? r.nMin : (r.n != null ? r.n : 1);
    const mx = (r.nMax != null) ? r.nMax : mn;
    return mn === mx ? `${mn} day(s)` : `${mn}–${mx} day(s)`;
  };
  const kindLabel = () => {
    if(r.shiftKind === 'dr-shift') return 'DR day shift';
    if(r.shiftKind === 'ir-shift') return 'IR day shift';
    return 'day shift';
  };
  switch(r.action){
    case 'no-call-on-day':         return `${evIcon} <strong>No call</strong> on ${evName} day`;
    case 'no-shift-on-day':        return `${evIcon} <strong>No DR/IR shift</strong> on ${evName} day`;
    case 'must-be-at-site-on-day': return `${evIcon} On ${evName} day, must be at <strong>${_tbEsc(r.requiredSite||'?')}</strong>${r.shift?` (${r.shift})`:''}`;
    case 'schedule-shift-prior':   return `${evIcon} <strong>Prefer ${kindLabel()}</strong> ${nRange()} before ${evName}`;
    case 'schedule-shift-after':   return `${evIcon} <strong>Prefer ${kindLabel()}</strong> ${nRange()} after ${evName}`;
    case 'block-day-prior':        return `${evIcon} <strong>No shift</strong> ${nRange()} before ${evName}`;
    case 'block-day-after':        return `${evIcon} <strong>No shift</strong> ${nRange()} after ${evName}`;
    case 'prefer-light-day':       return `${evIcon} <strong>Light coverage</strong> on ${evName} day (no 2nd/3rd)`;
    default:                       return `${evIcon} ${_tbEsc(r.action)}`;
  }
}

function _describeCallSiteRule(r){
  const ctLabel = {
    'ir-call':'IR call', 'ir-weekend':'IR weekend call',
    'weekend-call':'DR weekend call', 'any-call':'Any call'
  }[r.callType] || r.callType;
  const kindLabel = r.shiftKind === 'dr-shift' ? 'DR day shift'
                  : r.shiftKind === 'ir-shift' ? 'IR day shift'
                  : 'day shift';
  return `📞 If on <strong>${ctLabel}</strong>, ${kindLabel} must be at <strong>${_tbEsc(r.requiredSite||'?')}</strong>${r.shift?` (${r.shift})`:''}`;
}

/**
 * natLangRulesOk(ctx) — evaluate all enabled natural-language if/then rules.
 * ctx = { physId, date, site?, shift?, sub?, irGroup?, kind }
 *   kind ∈ {'dr-shift','ir-shift','ir-call','ir-weekend','dr-weekend','holiday'}
 * Returns true if no enabled rule BLOCKS this assignment, false otherwise.
 * Semantics:
 *   - action='block': if when matches, block the assignment.
 *   - action='require': if when matches AND the assignment does NOT satisfy
 *     requireSite/requireShift, block. If when does NOT match, rule is silent.
 *   - action='limit': if when matches and the physician is already at max for
 *     the given period, block.
 *   - action='prefer': ignored for eligibility — treated as a hint only.
 */
function natLangRulesOk(ctx){
  const rules = (S.natLangRules||[]).filter(r=>r.enabled!==false);
  if(!rules.length) return true;
  // Basic guard — caller must supply physId and date. If missing, silently allow
  // rather than throwing, so a misuse doesn't crash auto-assign.
  if(!ctx||ctx.physId==null||!ctx.date) return true;
  for(const r of rules){
    const w = r.when||{}, t = r.then||{};
    if(!t.action) continue;  // malformed rule — skip
    // when-clause: all specified constraints must match the assignment
    if(w.physId!=null && w.physId!==ctx.physId) continue;
    if(w.site && w.site!==ctx.site) continue;
    if(w.shift){
      // Map auto-assign shift strings to rule-side strings
      const sh=ctx.shift;
      if(w.shift!==sh) continue;
    }
    if(w.sub && w.sub!==ctx.sub) continue;
    if(w.irGroup && w.irGroup!==ctx.irGroup) continue;
    if(Array.isArray(w.dow)&&w.dow.length){
      const dow = parseDateLocal(ctx.date).getDay();
      if(!w.dow.includes(dow)) continue;
    }
    if(w.dateRange){
      if(w.dateRange.start && ctx.date<w.dateRange.start) continue;
      if(w.dateRange.end   && ctx.date>w.dateRange.end)   continue;
    }
    // when-clause matched — apply the effect
    if(t.action==='block')   return false;
    if(t.action==='require'){
      if(t.requireSite  && ctx.site  && ctx.site  !== t.requireSite)  return false;
      if(t.requireShift && ctx.shift && ctx.shift !== t.requireShift) return false;
    }
    if(t.action==='limit'){
      const monthKey=(ctx.date||'').slice(0,7);
      const yearKey =(ctx.date||'').slice(0,4);
      // Count existing assignments for this physician in the same "kind" bucket
      const count = (period) => {
        const inRange = d => {
          if(!d) return false;
          if(period==='month') return d.startsWith(monthKey);
          if(period==='year')  return d.startsWith(yearKey);
          if(period==='week'){
            // ISO-ish: same Mon-Sun block
            const d1=parseDateLocal(ctx.date), d2=parseDateLocal(d);
            const toMon = dt => { const c=new Date(dt); c.setDate(c.getDate()-((c.getDay()+6)%7)); return fmtDate(c); };
            return toMon(d1)===toMon(d2);
          }
          return false;
        };
        let n=0;
        (S.drShifts||[]).forEach(s=>{ if(s.physId===ctx.physId && inRange(s.date)) n++; });
        (S.irShifts||[]).forEach(s=>{ if(s.physId===ctx.physId && inRange(s.date)) n++; });
        (S.irCalls||[]).forEach(c=>{ if(c.physId===ctx.physId && inRange(c.date)) n++; });
        (S.weekendCalls||[]).forEach(c=>{ if(c.physId===ctx.physId && inRange(c.satDate||c.date)) n++; });
        return n;
      };
      if(t.maxPerMonth!=null && count('month')>=t.maxPerMonth) return false;
      if(t.maxPerWeek!=null  && count('week') >=t.maxPerWeek)  return false;
      if(t.maxPerYear!=null  && count('year') >=t.maxPerYear)  return false;
    }
    // prefer: no hard constraint
  }
  return true;
}
/**
 * sequenceOk(p, date, ym)
 * Returns true if assigning physician p to their primary site on `date` would
 * NOT violate any maxConsec (consecutive-day) rule across all their site rules.
 * Called before adding a shift to prevent streaks longer than the configured cap.
 */
function sequenceOk(p, date, ym, candSite, candSlotLabel){
  const seq = p.seqRules;
  // Per-site maxConsec from siteRules (old model, kept for compat)
  const perSiteRules = (p.siteRules||[]).filter(r=>r.maxConsec>0);
  for(const rule of perSiteRules){
    const cap = rule.maxConsec;
    let streak=0, d=date;
    for(let i=0;i<cap;i++){
      d=addDays(d,-1);
      const has=S.drShifts.some(s=>s.physId===p.id&&s.date===d&&s.site===rule.site)
             ||S.irShifts.some(s=>s.physId===p.id&&s.date===d&&s.site===rule.site);
      if(has) streak++; else break;
    }
    if(streak>=cap) return false;
  }
  // Global maxConsec from seqRules
  if(seq?.maxConsec){
    const cap=seq.maxConsec;
    let streak=0, d=date;
    for(let i=0;i<cap;i++){
      d=addDays(d,-1);
      const has=S.drShifts.some(s=>s.physId===p.id&&s.date===d)
             ||S.irShifts.some(s=>s.physId===p.id&&s.date===d);
      if(has) streak++; else break;
    }
    if(streak>=cap) return false;
  }
  // Global minRest (min days off between shifts)
  if(seq?.minRest){
    for(let i=1;i<=seq.minRest;i++){
      const prev=addDays(date,-i);
      const prevHas=S.drShifts.some(s=>s.physId===p.id&&s.date===prev)
                  ||S.irShifts.some(s=>s.physId===p.id&&s.date===prev);
      if(prevHas) return false;
    }
  }
  // Per-site / per-slot sequence rules — newer system. Each rule scopes to a
  // site (and optionally a labeled slot like 'stfs1'). We only enforce a rule
  // when the candidate assignment falls inside its scope; rules for sites
  // other than the candidate site are skipped entirely.
  const siteSeqRules = p.siteSeqRules||[];
  if(siteSeqRules.length && candSite){
    for(const rule of siteSeqRules){
      if(rule.site !== candSite) continue;
      // If the rule scopes to a specific slotLabel, require the candidate
      // assignment to be at that label too. If candSlotLabel is unknown
      // (legacy callers that don't pass it), conservatively skip the rule
      // to avoid false-blocking — sequenceOk's contract is "block if
      // certain"; uncertainty defaults to allow.
      if(rule.slotLabel){
        if(!candSlotLabel) continue;
        if(rule.slotLabel !== candSlotLabel) continue;
      }
      // Predicate: does an existing shift on date `d` count toward this
      // rule's streak? Match by site, and if the rule is slot-scoped also
      // by stored slotLabel on the prior shift. Both DR and IR shifts now
      // carry slotLabel — site-only rules match either; slot-scoped rules
      // require the label to match.
      const counts = (d) => {
        const irHits = (S.irShifts||[]).filter(s =>
          s.physId === p.id && s.date === d && s.site === rule.site
          && (!rule.slotLabel || (s.slotLabel||'') === rule.slotLabel));
        if(irHits.length) return true;
        const drHits = (S.drShifts||[]).filter(s =>
          s.physId === p.id && s.date === d && s.site === rule.site
          && (!rule.slotLabel || (s.slotLabel||'') === rule.slotLabel));
        return drHits.length > 0;
      };
      if(rule.maxConsec){
        const cap = rule.maxConsec;
        let streak=0, d=date;
        for(let i=0;i<cap;i++){
          d = addDays(d,-1);
          if(counts(d)) streak++; else break;
        }
        if(streak >= cap) return false;
      }
      if(rule.minRest){
        for(let i=1;i<=rule.minRest;i++){
          const prev = addDays(date,-i);
          if(counts(prev)) return false;
        }
      }
    }
  }
  return true;
}
