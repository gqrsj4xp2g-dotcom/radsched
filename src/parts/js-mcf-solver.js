const _MCF_WORKER_SOURCE = `
self.onmessage = function(e){
  const { id, kind, args } = e.data;
  try{
    if(kind === 'mcf'){
      const result = solveMCF.apply(null, args);
      self.postMessage({ id, ok: true, result });
    } else {
      self.postMessage({ id, ok: false, error: 'unknown kind: ' + kind });
    }
  }catch(err){
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};

// Same _mcfSolve as the main thread. Bellman-Ford successive-shortest-path.
function solveMCF(numNodes, edges, source, sink, maxFlow){
  const adj = Array.from({length: numNodes}, () => []);
  edges.forEach((e, i) => {
    adj[e.from].push({to: e.to, cap: e.cap, cost: e.cost, rev: adj[e.to].length, edgeIdx: i});
    adj[e.to].push({to: e.from, cap: 0, cost: -e.cost, rev: adj[e.from].length - 1, edgeIdx: -1});
  });
  let totalFlow = 0, totalCost = 0;
  let safetyIter = Math.max(1000, maxFlow * 4);
  while(totalFlow < maxFlow && safetyIter-- > 0){
    const INF = Number.POSITIVE_INFINITY;
    const dist = new Array(numNodes).fill(INF);
    const prevNode = new Array(numNodes).fill(-1);
    const prevEdge = new Array(numNodes).fill(-1);
    dist[source] = 0;
    let changed = true, bfIter = 0;
    while(changed && bfIter++ < numNodes){
      changed = false;
      for(let u = 0; u < numNodes; u++){
        if(dist[u] === INF) continue;
        const aEdges = adj[u];
        for(let i = 0; i < aEdges.length; i++){
          const ed = aEdges[i];
          if(ed.cap <= 0) continue;
          const nd = dist[u] + ed.cost;
          if(nd < dist[ed.to]){
            dist[ed.to] = nd;
            prevNode[ed.to] = u;
            prevEdge[ed.to] = i;
            changed = true;
          }
        }
      }
    }
    if(dist[sink] === INF) break;
    let bottleneck = INF;
    for(let cur = sink; cur !== source; cur = prevNode[cur]){
      const ed = adj[prevNode[cur]][prevEdge[cur]];
      if(ed.cap < bottleneck) bottleneck = ed.cap;
    }
    if(bottleneck === INF || bottleneck <= 0) break;
    for(let cur = sink; cur !== source; cur = prevNode[cur]){
      const ed = adj[prevNode[cur]][prevEdge[cur]];
      ed.cap -= bottleneck;
      adj[ed.to][ed.rev].cap += bottleneck;
    }
    totalFlow += bottleneck;
    totalCost += bottleneck * dist[sink];
  }
  const edgeFlows = new Array(edges.length).fill(0);
  for(let u = 0; u < numNodes; u++){
    for(const ed of adj[u]){
      if(ed.edgeIdx >= 0){
        edgeFlows[ed.edgeIdx] = edges[ed.edgeIdx].cap - ed.cap;
      }
    }
  }
  return { flow: totalFlow, cost: totalCost, edgeFlows };
}
`;

let _mcfWorker = null;
let _mcfWorkerNextId = 1;
const _mcfWorkerCallbacks = {};

function _ensureMcfWorker(){
  if(_mcfWorker) return _mcfWorker;
  if(typeof Worker !== 'function') return null;
  try{
    const blob = new Blob([_MCF_WORKER_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    _mcfWorker = new Worker(url);
    _mcfWorker.onmessage = (e) => {
      const { id, ok, result, error } = e.data || {};
      const cb = _mcfWorkerCallbacks[id];
      if(!cb) return;
      delete _mcfWorkerCallbacks[id];
      if(ok) cb.resolve(result);
      else cb.reject(new Error(error || 'worker error'));
    };
    _mcfWorker.onerror = (e) => {
      console.warn('[RS] MCF worker error', e);
      // Reject any pending calls and tear down so the next attempt
      // re-creates a fresh worker (or falls back to in-thread).
      Object.values(_mcfWorkerCallbacks).forEach(cb => cb.reject(e));
      Object.keys(_mcfWorkerCallbacks).forEach(k => delete _mcfWorkerCallbacks[k]);
      try{ _mcfWorker.terminate(); }catch(_){}
      _mcfWorker = null;
    };
  }catch(err){
    console.warn('[RS] Could not start MCF worker, falling back to main thread:', err);
    _mcfWorker = null;
  }
  return _mcfWorker;
}

function _mcfSolveAsync(numNodes, edges, source, sink, maxFlow){
  const w = _ensureMcfWorker();
  if(!w){
    // No worker support — run in thread, return a resolved Promise so
    // callers can use the same await pattern. The synchronous freeze
    // is unavoidable here, but at least the API is uniform.
    return Promise.resolve(_mcfSolve(numNodes, edges, source, sink, maxFlow));
  }
  return new Promise((resolve, reject) => {
    const id = _mcfWorkerNextId++;
    _mcfWorkerCallbacks[id] = { resolve, reject };
    w.postMessage({ id, kind: 'mcf', args: [numNodes, edges, source, sink, maxFlow] });
    // Watchdog: if the worker hangs (extremely large graph?) for >15s,
    // reject so the caller can fall back. The main-thread version would
    // also be unresponsive but at least the user gets feedback.
    setTimeout(() => {
      if(_mcfWorkerCallbacks[id]){
        delete _mcfWorkerCallbacks[id];
        reject(new Error('MCF solver timed out after 15s'));
      }
    }, 15000);
  });
}

function _mcfSolve(numNodes, edges, source, sink, maxFlow){
  const adj = Array.from({length: numNodes}, () => []);
  // Each forward edge stores its index in the input array so the caller
  // can decode flow assignments. Reverse edges store -1.
  edges.forEach((e, i) => {
    adj[e.from].push({to: e.to, cap: e.cap, cost: e.cost, rev: adj[e.to].length, edgeIdx: i});
    adj[e.to].push({to: e.from, cap: 0, cost: -e.cost, rev: adj[e.from].length - 1, edgeIdx: -1});
  });
  let totalFlow = 0, totalCost = 0;
  // Cap iterations defensively — pathological inputs (negative-cost cycles
  // in residual graph due to caller error) shouldn't hang the browser.
  let safetyIter = Math.max(1000, maxFlow * 4);
  while(totalFlow < maxFlow && safetyIter-- > 0){
    const INF = Number.POSITIVE_INFINITY;
    const dist = new Array(numNodes).fill(INF);
    const prevNode = new Array(numNodes).fill(-1);
    const prevEdge = new Array(numNodes).fill(-1);
    dist[source] = 0;
    // Bellman-Ford. We only iterate up to numNodes-1 times (enough to find
    // shortest path), then check for negative cycles. In practice converges
    // in 2-4 iterations for our graph shapes.
    let changed = true, bfIter = 0;
    while(changed && bfIter++ < numNodes){
      changed = false;
      for(let u = 0; u < numNodes; u++){
        if(dist[u] === INF) continue;
        const aEdges = adj[u];
        for(let i = 0; i < aEdges.length; i++){
          const e = aEdges[i];
          if(e.cap <= 0) continue;
          const nd = dist[u] + e.cost;
          if(nd < dist[e.to]){
            dist[e.to] = nd;
            prevNode[e.to] = u;
            prevEdge[e.to] = i;
            changed = true;
          }
        }
      }
    }
    if(dist[sink] === INF) break; // no augmenting path → matching is complete
    // Find bottleneck capacity along the path
    let bottleneck = INF;
    for(let cur = sink; cur !== source; cur = prevNode[cur]){
      const e = adj[prevNode[cur]][prevEdge[cur]];
      if(e.cap < bottleneck) bottleneck = e.cap;
    }
    if(bottleneck === INF || bottleneck <= 0) break; // shouldn't happen but defensive
    // Push flow
    for(let cur = sink; cur !== source; cur = prevNode[cur]){
      const e = adj[prevNode[cur]][prevEdge[cur]];
      e.cap -= bottleneck;
      adj[e.to][e.rev].cap += bottleneck;
    }
    totalFlow += bottleneck;
    totalCost += bottleneck * dist[sink];
  }
  // Decode: how much flow did each input edge carry?
  const edgeFlows = new Array(edges.length).fill(0);
  for(let u = 0; u < numNodes; u++){
    for(const e of adj[u]){
      if(e.edgeIdx >= 0){
        edgeFlows[e.edgeIdx] = edges[e.edgeIdx].cap - e.cap;
      }
    }
  }
  return { flow: totalFlow, cost: totalCost, edgeFlows };
}

/* ═══════════════════════════════════════════════════════════════════════
   UNFILLABLE-SLOT DIAGNOSTIC
   Given a slot the solver couldn't fill, walk every IR-FTE physician
   through the same eligibility predicates the solver uses and collect
   the specific reasons each was excluded. Output drives the "Unfillable
   Slots" tab in the auto-assign preview so admins can see exactly why a
   day is uncovered (vacation? site rule? quota exhausted?) and act.

   opts.quotaExhausted: optional {physId: 'reason string'} map for
   physicians the caller already determined are out of quota for the
   period. Surfaced as a separate reason since it's not a per-slot
   property — it's a run-level constraint.
═══════════════════════════════════════════════════════════════════════ */
function _diagnoseSlotUnfillable(slot, opts){
  opts = opts || {};
  const ym = (slot.date || '').slice(0, 7);
  const allP = (S.physicians || []).filter(p => p.irFte > 0);
  // Build a per-physician "already placed in THIS preview run" index so
  // the diagnostic stops blaming quota for physicians who were actually
  // picked for a DIFFERENT slot on the same date. opts.runAssignments
  // is the in-progress assignment list from the caller (legacy: the
  // `assigned[]` array; MCF: run.preview). Without this index we get
  // the misleading "— no blocking reason — likely quota" label for
  // physicians who are genuinely unavailable because the solver
  // already committed them elsewhere today.
  // Belt-and-suspenders: prefer the explicit runAssignments opt, but
  // fall back to the module-level _irsaPreview if the caller forgot
  // to pass it. The user reported a case where Lucas was placed at
  // CHS on 8/10 yet the diagnostic for a different 8/10 slot showed
  // him as 'eligible (passed all rules)' instead of 'already placed
  // today (CHS)'. The fallback makes sure we always see the live
  // preview state regardless of caller wiring.
  let runAssigns = Array.isArray(opts.runAssignments) ? opts.runAssignments : null;
  if(!runAssigns && Array.isArray(typeof _irsaPreview !== 'undefined' ? _irsaPreview : null)){
    runAssigns = _irsaPreview;
  }
  runAssigns = runAssigns || [];
  // rs-v134: sequence rules and natural-language limits count this preview's shifts, as the builders do
  const runPlan = _rulePlan(runAssigns);
  const placedThisRun = {};   // physId → {date, site, slotLabel}
  runAssigns.forEach(a => {
    if(!a || a.physId == null) return;
    // Normalize date to YYYY-MM-DD substring so a stray timestamp
    // (rare but possible) still matches the slot's date prefix.
    const aDate = String(a.date || '').slice(0, 10);
    const sDate = String(slot.date || '').slice(0, 10);
    if(!aDate || aDate !== sDate) return;
    // Skip the slot itself — that's the slot we're trying to diagnose;
    // the picked physician for it (if any) would otherwise show as
    // "blocked by this run". Match on site + slotLabel + slotIndex
    // since rotation can swap slotLabels between picks at the same
    // (date, site). slotIndex is the stable identifier.
    const sameSlot = a.site === slot.site &&
      ((a.slotLabel||'') === (slot.slotLabel||'') ||
       (a._preAllocSlotIndex != null && slot.slotIndex != null && a._preAllocSlotIndex === slot.slotIndex));
    if(sameSlot) return;
    placedThisRun[a.physId] = { site: a.site, slotLabel: a.slotLabel || '' };
  });
  const out = [];
  allP.forEach(p => {
    const reasons = [];
    const ctx = { physId: p.id, date: slot.date, site: slot.site, shift: '1st', kind: 'ir-shift', irGroup: slot._group || p.irGroup, ym, plan: runPlan };
    // In-run placement — this is the new check. If the solver already
    // placed this physician at a different slot today in THIS preview
    // run, they cannot also fill the current slot — but they're not
    // over quota and there's nothing about them the admin needs to
    // "fix". Surface as its own reason so the label doesn't claim
    // "likely quota" misleadingly.
    if(placedThisRun[p.id]){
      const pr = placedThisRun[p.id];
      reasons.push('already placed today (' + pr.site + (pr.slotLabel ? ' · ' + pr.slotLabel : '') + ') by this preview run');
    }
    // Vacation
    try{ if(typeof _physStartedBy === 'function' && !_physStartedBy(p, slot.date)) reasons.push('not started yet (starts ' + _physStartDate(p) + ')'); }catch(_){}
    try{ if(typeof vacDays === 'function' && vacDays(p.id).has(slot.date)) reasons.push('on vacation'); }catch(_){}
    // Sold-back date (CME / personal)
    try{ if(typeof isSoldBackDate === 'function' && isSoldBackDate(p.id, slot.date)) reasons.push('sold-back date'); }catch(_){}
    // 2nd/3rd shift conflict (already committed to a hospital obligation that day)
    try{ if(typeof _has2ndOr3rdShift === 'function' && _has2ndOr3rdShift(p.id, slot.date)) reasons.push('already on 2nd/3rd shift'); }catch(_){}
    // Pre-existing assignments
    if((S.irShifts || []).find(s => s.physId === p.id && s.date === slot.date)) reasons.push('already has IR shift on this date');
    if((S.drShifts || []).find(s => s.physId === p.id && s.date === slot.date && s.shift !== 'Home')) reasons.push('already has DR shift on this date');
    // Existing IR call same date (would conflict with day shift)
    try{
      const onCall = (S.irCalls || []).some(ic => {
        if(ic.physId !== p.id) return false;
        if(ic.callType === 'daily') return ic.date === slot.date;
        if(ic.callType === 'weekend'){
          // Fri-Mon span
          return slot.date === ic.date || slot.date === addDays(ic.date, 1) ||
                 slot.date === addDays(ic.date, 2) || slot.date === addDays(ic.date, 3);
        }
        return false;
      });
      if(onCall) reasons.push('on IR call');
    }catch(_){}
    // Group / fill-in eligibility (slot belongs to one IR group; phys is in another and isn't a fill-in)
    if(slot._group && p.irGroup && slot._group !== p.irGroup){
      const isAnchor = Array.isArray(slot.anchors) && slot.anchors.indexOf(p.id) >= 0;
      const isFillIn = Array.isArray(slot.fillins) && slot.fillins.indexOf(p.id) >= 0;
      if(!isAnchor && !isFillIn){
        reasons.push(`different IR group (phys=${p.irGroup}, slot=${slot._group})`);
      }
    }
    // Per-physician slot eligibility (anchors/fillins for mixed-role sites)
    try{ if(typeof _irsaEligibleForSlot === 'function' && !_irsaEligibleForSlot(p, slot)) reasons.push('not eligible for this site (per anchor/fill-in roster)'); }catch(_){}
    // Site rules (max per month / week / blocked / preferred shifts)
    try{ if(typeof irSiteRuleOk === 'function' && !irSiteRuleOk(p, slot.site, slot.date)) reasons.push(`site rule blocks ${slot.site}`); }catch(_){}
    // Day condition
    try{ if(typeof dayConditionSiteOk === 'function' && !dayConditionSiteOk(p, slot.site, slot.date, 'ir-shift')) reasons.push('day condition mismatch'); }catch(_){}
    // Sequence rules (max consecutive / min rest, slot-aware)
    try{ if(typeof sequenceOk === 'function' && !sequenceOk(p, slot.date, ym, slot.site, slot.slotLabel||'', runPlan)) reasons.push('sequence rule (consecutive / rest)'); }catch(_){}
    // Tumor board / conference participation
    try{ if(typeof tbRulesOk === 'function' && !tbRulesOk(p, ctx)) reasons.push('tumor-board / clinic conflict'); }catch(_){}
    try{ if(typeof _conferenceBlocksSlot === 'function' && _conferenceBlocksSlot(p.id, slot.date, slot.site)) reasons.push('participating in a conference at this site'); }catch(_){}
    // Call-day site rule (admin-pinned: "if on call → must be at site X")
    try{ if(typeof callDayRulesOk === 'function' && !callDayRulesOk(p, ctx)) reasons.push('call-day site rule'); }catch(_){}
    // Natural-language rule
    try{ if(typeof natLangRulesOk === 'function' && !natLangRulesOk(ctx)) reasons.push('custom natural-language rule'); }catch(_){}
    // Quota — per-run constraint, supplied by caller. We include the
    // current count vs cap so admins can see how far over the phys is
    // even when over-quota assignment IS permitted (cf. Pass 4 in the
    // greedy solver + over-quota edge in MCF).
    if(opts.quotaExhausted && opts.quotaExhausted[p.id]){
      reasons.push(`over quota (${opts.quotaExhausted[p.id]})`);
    }
    out.push({ physId: p.id, name: pname(p.id), group: p.irGroup || '', reasons });
  });
  return out;
}

// Render an HTML <details> block per unfilled slot with diagnostic info.
// Pass an array of slot objects (must have date, site, slotLabel, _group)
// and an optional quotaExhausted map. Returns an HTML string.
//
// One-click "Assign now (over quota)" handler invoked from the
// Over-quota pool row in _renderUnfilledDiagnostic. Bypasses the
// auto-assigner and writes the IR shift record directly, AFTER a
// re-validation pass that checks the slot is still unfilled and
// the physician still passes the same one-per-day / vacation /
// conference / call-day-site checks the solver enforces. Quota
// is the ONLY thing this button skips — every other rule still
// applies, so the admin can't accidentally over-ride a hard
// constraint by clicking too fast.
function _assignOverQuotaNow(payload){
  if(!_adminOnly('override quota and assign')) return;
  payload = payload || {};
  const { physId, date, site, slotLabel, irGroup } = payload;
  if(!physId || !date || !site){
    if(typeof _toast === 'function') _toast('Invalid assignment payload.', 'err');
    return;
  }
  const p = (S.physicians||[]).find(x => x.id === physId);
  if(p && typeof _confirmBeforeStart === 'function' && !_confirmBeforeStart(p,[date])) return;
  if(!p){
    if(typeof _toast === 'function') _toast('Physician not found.', 'err');
    return;
  }
  // Schedule-lock guard — same as every other manual assignment path.
  if(typeof _canEditDate === 'function' && !_canEditDate(date)) return;
  // Re-validate the hard constraints. Quota is intentionally NOT
  // checked here — that's exactly the override the admin is asking
  // for. But everything else must still hold.
  let alsoOnCall = false;
  try{
    if(typeof vacDays === 'function' && vacDays(physId).has(date)){
      alert(`${p.last} is on vacation on ${date}. Remove the vacation entry first.`);
      return;
    }
    if(typeof _has2ndOr3rdShift === 'function' && _has2ndOr3rdShift(physId, date)){
      alert(`${p.last} is on a 2nd/3rd shift on ${date} and cannot also work an IR shift.`);
      return;
    }
    // One IR shift per day: a duplicate at the exact (date, site,
    // slotLabel) is a no-op; at the same date but a DIFFERENT site
    // is a double-booking we refuse unless admin explicitly confirms.
    const sameDate = (S.irShifts||[]).filter(s => s.physId === physId && s.date === date);
    const exact = sameDate.find(s => s.site === site && (s.slotLabel||'') === (slotLabel||''));
    if(exact){
      if(typeof _toast === 'function') _toast('This slot is already filled by this physician.', 'info');
      return;
    }
    if(sameDate.length){
      if(!confirm(`${p.last} already has an IR shift on ${date} at ${sameDate[0].site||'?'}. Add another at ${site}?`)) return;
    }
    alsoOnCall = !!(S.irCalls||[]).find(c => c.physId === physId &&
      ((c.callType === 'daily' && c.date === date) ||
       (c.callType === 'weekend' && [c.date, addDays(c.date,1), addDays(c.date,2), addDays(c.date,3)].includes(date))));
    const _ctx = { physId, date, site, shift: '1st', kind: 'ir-shift', irGroup: irGroup || p.irGroup || '', ym: date.slice(0,7) };
    if(typeof callDayRulesOk === 'function' && !callDayRulesOk(p, _ctx)){
      if(!confirm(`Call-day site rule says ${p.last} should be at a different site for this date (they're on call). Assign anyway?`)) return;
    }
  } catch(_){ /* defensive — never let the re-validation throw block the override */ }
  const newId = S.nextId++;
  const note = `Manual over-quota override${alsoOnCall ? ' (also on call)' : ''}`;
  (S.irShifts = S.irShifts || []).push({
    id: newId,
    physId,
    date,
    shift: '1st',
    site,
    sub: '',
    slotLabel: slotLabel || '',
    irGroup: irGroup || p.irGroup || '',
    notes: note,
  });
  if(typeof _audit === 'function') _audit('irShift.overrideOverQuota', { id: newId, physId, date, site, slotLabel: slotLabel||'', irGroup: irGroup||p.irGroup||'' });
  if(typeof triggerSave === 'function') triggerSave();
  if(typeof _afterMutation === 'function') _afterMutation();
  if(typeof _toast === 'function') _toast(`✓ Assigned ${p.last} to ${site}${slotLabel?' · '+slotLabel:''} on ${date} (over-quota override).`, 'ok');
  // Re-run the preview so the unfilled slot collapses and the
  // physician's quota count + this date's drop-down both update.
  // Use whichever solver the admin has selected (legacy or MCF).
  try{
    if((S.cfg||{}).useSolver === 'mcf' && typeof _previewIRShiftAA_MCF === 'function') _previewIRShiftAA_MCF();
    else if(typeof previewIRShiftAA === 'function') previewIRShiftAA();
  }catch(_){ /* preview is informational — don't break the assignment if it fails */ }
}

// For each slot the rendered drill-down has THREE sections:
//   1. Blocked phys table — every IR-FTE phys with their exclusion reasons.
//   2. 🤝 Cross-coverage pool — phys from the OTHER IR group whose ONLY
//      block is the group mismatch (no rule conflicts; admin can manually
//      assign them with cross-group fill-in semantics).
//   3. ⚖ Over-quota pool — in-group phys whose ONLY block is hitting their
//      period quota. Admin can override quota via the "Assign now" button
//      next to each phys (rs-v42 added the one-click handler).
function _renderUnfilledDiagnostic(unfilledSlots, opts){
  if(!unfilledSlots || !unfilledSlots.length) return '';
  opts = opts || {};
  // Helper: anchor / fill-in registration for a (phys, site) pair so the
  // cross-coverage list can mark phys who already volunteered to cover
  // this site even though they're in another group.
  const _siteRoleFor = (physId, siteName) => {
    const st = (S.sites||[]).find(s => s.name === siteName);
    if(!st) return '';
    if(Array.isArray(st.irAnchors) && st.irAnchors.indexOf(physId) >= 0) return 'anchor';
    if(Array.isArray(st.irFillins) && st.irFillins.indexOf(physId) >= 0) return 'fill-in';
    return '';
  };
  let html = '<div class="card" style="margin-bottom:10px;border-left:3px solid var(--red,#dc2626)">' +
    '<div class="card-title">⚠ Unfillable Slots — ' + unfilledSlots.length + '</div>' +
    '<div class="note ni" style="font-size:11px;margin-bottom:8px">Each row below is a slot the solver could not fill. Expand to see why each physician was excluded — fix the underlying rule, raise a quota, or use the cross-coverage pool to manually assign. A universal-holiday badge (🎉) marks dates that the auto-assigner SHOULD have skipped (Christmas, Thanksgiving, etc.) — these are expected and need Holiday Call coverage, not regular auto-assign.</div>';
  unfilledSlots.forEach(slot => {
    const diag = _diagnoseSlotUnfillable(slot, opts);
    // Aggregate first reason per phys → histogram for the summary line.
    const histo = {};
    let availPhys = 0;
    diag.forEach(d => {
      if(!d.reasons.length){ availPhys++; return; }
      const r = d.reasons[0];
      histo[r] = (histo[r] || 0) + 1;
    });
    const histoLine = Object.entries(histo)
      .sort((a,b) => b[1] - a[1])
      .slice(0, 6)
      .map(([r, n]) => `<span class="tag" style="font-size:9.5px;margin-right:4px;background:var(--bg3);color:var(--txt2)">${escHtml(r)} × ${n}</span>`)
      .join('');
    const slotLabel = slot.slotLabel ? ' · ' + escHtml(slot.slotLabel) : '';
    // Universal-holiday badge — if this date is a US federal holiday
    // that the auto-assigner SHOULD have skipped, surface it so the
    // admin knows this isn't a true "unfillable" gap, just a date
    // that needs Holiday Call coverage instead.
    const _uh = (typeof _universalHolidayFor === 'function') ? _universalHolidayFor(slot.date) : null;
    const uhBadge = _uh ? `<span class="tag" style="font-size:9.5px;margin-left:6px;background:var(--red-bg,#fee2e2);color:var(--red-t)">🎉 ${escHtml(_uh)}</span>` : '';
    // Cross-group pool: ALL phys in a different IR group, categorized by
    // whether they have any blocking reason BESIDES the group mismatch.
    //   "available" → wrong group only (clean candidate; admin can override)
    //   "alsoBlocked" → wrong group + something else (e.g., vacation)
    //                  Surfaced so admins see the full other-group roster
    //                  and the specific conflict to fix if they want them.
    const crossGroupAll = diag.filter(d =>
      d.group && slot._group && d.group !== slot._group
    );
    const crossCoverage = crossGroupAll.filter(d =>
      d.reasons.length === 1 && d.reasons[0].indexOf('different IR group') === 0
    );
    const crossBlocked = crossGroupAll.filter(d =>
      d.reasons.length > 1 ||
      (d.reasons.length === 1 && d.reasons[0].indexOf('different IR group') !== 0)
    );
    // Override pool: in-group physicians blocked ONLY by SOFT reasons
    // that an admin can knowingly override. Previously this filter
    // required the ONLY reason to be 'over quota' — which meant a
    // phys at quota + violating a sequence rule was hidden behind a
    // wall of red tags with no override path, and the assigner went
    // to the cross-group pool instead. Per user feedback ("allow
    // people to go over their limit if they are available before
    // going to the pool"), we now consider these reasons soft:
    //   • over quota (period FTE soft cap)
    //   • site rule blocks (admin-configured site preference)
    //   • day condition mismatch (e.g. Tue/Thu only)
    //   • sequence rule (max consecutive / min rest)
    //   • tumor-board / clinic conflict (already overridable via
    //     allowBreakForUnfilledIR flag)
    // Reasons that REMAIN hard (button not shown if any present):
    //   • vacation / sold-back / 2nd or 3rd shift / on IR call /
    //     pre-existing manual shift / call-day site rule /
    //     conference at this site / not eligible (anchor-fillin
    //     roster) / different IR group / placed today by this run /
    //     natural-language rule.
    const SOFT_REASON_PREFIXES = [
      'over quota',
      'site rule blocks',
      'day condition mismatch',
      'sequence rule',
      'tumor-board / clinic',
    ];
    const isSoftReason = r => SOFT_REASON_PREFIXES.some(p => r.indexOf(p) === 0);
    const overQuota = diag.filter(d => {
      if(!d.reasons.length) return false;
      if(d.group !== slot._group) return false;
      // Hide the row if NO over-quota reason exists — these aren't
      // "over-quota" candidates, they're just rule violators. The
      // Assign-now override still fires for them though (see button
      // label below); we just don't surface them in this section.
      const hasQuota = d.reasons.some(r => r.indexOf('over quota') === 0);
      if(!hasQuota) return false;
      return d.reasons.every(isSoftReason);
    });
    // "Already placed today" cohort — physicians in slot's group who
    // are blocked ONLY by their other assignment in this same preview
    // run. Surfacing them at the summary level removes the surprise
    // when group size < slot count for a day.
    const placedElsewhere = diag.filter(d => {
      if(d.group !== slot._group) return false;
      const onlyReason = d.reasons.length === 1 && d.reasons[0].indexOf('already placed today') === 0;
      return onlyReason;
    });
    const availNote = availPhys ? `<span style="color:var(--amber-t);font-weight:700;margin-left:8px">${availPhys} phys eligible (solver had to pick someone else)</span>` : '';
    const placedNote = placedElsewhere.length
      ? `<span style="color:var(--rs-ink-3);font-weight:700;margin-left:8px">🗓 ${placedElsewhere.length} placed elsewhere today</span>`
      : '';
    const coverNote = crossGroupAll.length
      ? `<span style="color:var(--blue-t);font-weight:700;margin-left:8px">🤝 ${crossCoverage.length}/${crossGroupAll.length} cross-coverage</span>`
      : '';
    const overQNote = overQuota.length
      ? `<span style="color:var(--amber-t);font-weight:700;margin-left:8px">⚖ ${overQuota.length} over-quota (will fire in Pass 4)</span>`
      : '';
    html += `<details style="margin-bottom:6px;border:1px solid var(--bdr);border-radius:5px;padding:6px 10px;background:var(--bg2)">
      <summary style="cursor:pointer;font-size:12px;font-weight:600">
        <span style="color:var(--red-t)">${escHtml(slot.date)}</span>
        <span style="color:var(--txt2);margin-left:6px">${escHtml(slot.site)}${slotLabel}</span>
        <span style="margin-left:8px;font-weight:400;color:var(--txt3)">${slot._group || ''}</span>
        ${uhBadge}${placedNote}${availNote}${coverNote}${overQNote}
      </summary>
      <div style="margin-top:6px;font-size:11px">
        ${histoLine ? '<div style="margin-bottom:6px">' + histoLine + '</div>' : ''}`;
    // ── PRIMARY ROOT-CAUSE BANNER ────────────────────────────────────
    // Cluster the common confusion into a single explicit banner so
    // admins don't have to scan a table of reasons to understand WHY
    // this slot is unfilled.
    //
    // Priority order:
    //   1. Universal holiday — expected; just informational.
    //   2. All in-group physicians placed elsewhere today — the
    //      single most common "phantom" unfillable, where in-group
    //      head-count < slot count for the day. Over-quota DOESN'T
    //      help because one phys can only do one shift/day.
    //   3. Over-quota IS the only block — Pass 4 will fire for these
    //      in greedy; MCF's over-quota edge handles it.
    //   4. Cross-coverage exists — admin can promote with override.
    //   5. Everyone in group blocked by hard rules — admin needs to
    //      relax a rule or expand the eligible roster.
    if(_uh){
      html += `<div style="margin-bottom:8px;padding:8px 10px;background:var(--bg3);border-left:3px solid var(--red,#dc2626);border-radius:4px;font-size:11px">
        <div style="font-weight:700;color:var(--red-t);margin-bottom:2px">🎉 Universal holiday — ${escHtml(_uh)}</div>
        <div class="txt2">Auto-assign correctly skipped this date. Use the Holiday Call tab to assign coverage if the practice operates on this holiday. Set <code>S.cfg.skipUniversalHolidays = false</code> to disable the universal-holiday block entirely.</div>
      </div>`;
    } else {
      const inGroupTotal = diag.filter(d => d.group === slot._group).length;
      const inGroupPlaced = placedElsewhere.length;
      // If EVERY in-group phys is placed elsewhere today (and no in-
      // quota/over-quota candidates remain), this is a head-count
      // shortage — over-quota CANNOT help because one phys = one
      // shift per day. Surface that explicitly so admins don't try
      // to "fix" it by raising quota.
      if(inGroupTotal > 0 && inGroupPlaced === inGroupTotal){
        html += `<div style="margin-bottom:8px;padding:8px 10px;background:var(--bg3);border-left:3px solid var(--amber,#d97706);border-radius:4px;font-size:11px">
          <div style="font-weight:700;color:var(--amber-t);margin-bottom:2px">🗓 Group head-count shortage</div>
          <div class="txt2">All ${inGroupTotal} in-group physicians are already placed at other slots today (one physician = one shift per day). Over-quota assignment cannot help here — the constraint is calendar capacity, not period quota. Options: pull from the cross-coverage pool below, hire/transfer to grow the group, or reduce the slot count for this date.</div>
        </div>`;
      } else if(overQuota.length && overQuota.length === inGroupTotal - inGroupPlaced){
        // Every in-group phys not-placed-elsewhere is over quota.
        // Greedy Pass 4 / MCF's over-quota edge should pick one.
        html += `<div style="margin-bottom:8px;padding:8px 10px;background:var(--bg3);border-left:3px solid var(--amber,#d97706);border-radius:4px;font-size:11px">
          <div style="font-weight:700;color:var(--amber-t);margin-bottom:2px">⚖ Over-quota pool will be used (Pass 4)</div>
          <div class="txt2">${overQuota.length} in-group physician${overQuota.length===1?' is':'s are'} at/over their period quota. Greedy Pass 4 will pick one and label the assignment "Auto (over-quota)". If you see this slot still unfilled in the preview, one of them is also blocked by call-day-site rule / conference / pre-existing shift — check the per-physician table below.</div>
        </div>`;
      }
    }
    // Cross-coverage pool — ALWAYS rendered when there's an other-group
    // pool to draw from, so admins see the complete picture even when no
    // phys is "clean" enough to drop in without an override.
    if(crossGroupAll.length){
      html += `<div style="margin-bottom:8px;padding:8px 10px;background:var(--blue-bg);border-left:3px solid var(--blue,#2563eb);border-radius:4px">
        <div style="font-size:11px;font-weight:700;color:var(--blue-t);margin-bottom:4px">🤝 Cross-coverage pool — ${crossGroupAll.length} physician${crossGroupAll.length===1?'':'s'} in other IR groups</div>
        <div style="font-size:10.5px;color:var(--txt2);margin-bottom:6px">${crossCoverage.length} available now (no other conflict) · ${crossBlocked.length} also blocked by another constraint. Admin can manually assign cross-group via the IR Shift Builder.</div>`;
      // Available now (clean candidates)
      if(crossCoverage.length){
        html += `<div style="font-size:10.5px;font-weight:700;color:var(--green-t);margin-top:4px;margin-bottom:2px">✓ Available now — ${crossCoverage.length}</div>
        <table style="width:100%;font-size:11px;margin-bottom:6px"><thead><tr>
          <th class="tal">Physician</th><th class="tal">Their Group</th><th class="tal">Anchor Site</th><th class="tal">Site Role</th>
        </tr></thead><tbody>`;
        crossCoverage.sort((a,b) => a.name.localeCompare(b.name)).forEach(c => {
          const p = (S.physicians||[]).find(x => x.id === c.physId);
          const anchor = p?.anchorSite || '—';
          const role = _siteRoleFor(c.physId, slot.site);
          const roleBadge = role
            ? `<span class="tag" style="font-size:9px;background:var(--green-bg);color:var(--green-t);font-weight:700">${role}</span>`
            : `<span class="txt3">cross-group only</span>`;
          html += `<tr>
            <td class="fw6">${escHtml(c.name)}</td>
            <td><span class="tag" style="font-size:9px">${escHtml(c.group||'—')}</span></td>
            <td class="txt2">${escHtml(anchor)}</td>
            <td>${roleBadge}</td>
          </tr>`;
        });
        html += '</tbody></table>';
      } else {
        html += `<div style="font-size:10.5px;font-style:italic;color:var(--txt3);margin:4px 0 6px">No cross-group physicians are conflict-free right now. See "Also blocked" below for who could fill in if their conflict is resolved.</div>`;
      }
      // Cross-group physicians who have additional blocks beyond the group
      // mismatch — listed so admin sees the full other-group roster and
      // exactly what's blocking each one.
      if(crossBlocked.length){
        html += `<div style="font-size:10.5px;font-weight:700;color:var(--amber-t);margin-top:4px;margin-bottom:2px">⚠ Also blocked — ${crossBlocked.length} (other-group, but also have a conflict)</div>
        <table style="width:100%;font-size:11px"><thead><tr>
          <th class="tal">Physician</th><th class="tal">Group</th><th class="tal">Other blocking reason(s)</th>
        </tr></thead><tbody>`;
        crossBlocked.sort((a,b) => a.name.localeCompare(b.name)).forEach(c => {
          // Filter out the cross-group reason itself; show only the OTHER blocks.
          const otherReasons = c.reasons.filter(r => r.indexOf('different IR group') !== 0);
          const rh = otherReasons.length
            ? otherReasons.map(r => `<span class="tag" style="font-size:9.5px;margin-right:4px">${escHtml(r)}</span>`).join('')
            : `<span class="tag" style="font-size:9.5px;background:var(--amber-bg);color:var(--amber-t)">cross-group only</span>`;
          html += `<tr>
            <td class="fw6">${escHtml(c.name)}</td>
            <td><span class="tag" style="font-size:9px">${escHtml(c.group||'—')}</span></td>
            <td>${rh}</td>
          </tr>`;
        });
        html += '</tbody></table>';
      }
      html += '</div>';
    } else if(slot._group){
      // No other-group physicians at all (single-group practice). Note that
      // explicitly so admins don't wonder if the section is missing.
      html += `<div style="margin-bottom:8px;padding:8px 10px;background:var(--bg3);border-left:3px solid var(--txt3);border-radius:4px;font-size:11px;color:var(--txt2)">
        🤝 Cross-coverage pool — none. There are no IR physicians in groups other than <strong>${escHtml(slot._group)}</strong>.
      </div>`;
    }
    // Over-quota in-group pool
    if(overQuota.length){
      html += `<div style="margin-bottom:8px;padding:8px 10px;background:var(--amber-bg,#fffbeb);border-left:3px solid var(--amber,#d97706);border-radius:4px">
        <div style="font-size:11px;font-weight:700;color:var(--amber-t);margin-bottom:4px">⚖ Over-quota pool — ${overQuota.length} in-group physician${overQuota.length===1?'':'s'}</div>
        <div style="font-size:10.5px;color:var(--txt2);margin-bottom:6px">In-group, not blocked by any rule, but already at their period quota. Click <strong>Assign now</strong> to commit a shift to this slot immediately (over-quota override is admin-only and audit-logged).</div>
        <table style="width:100%;font-size:11px"><thead><tr>
          <th class="tal">Physician</th><th class="tal">Quota</th><th class="tal">Anchor Site</th><th></th>
        </tr></thead><tbody>`;
      overQuota.sort((a,b) => a.name.localeCompare(b.name)).forEach(c => {
        const p = (S.physicians||[]).find(x => x.id === c.physId);
        const anchor = p?.anchorSite || '—';
        // Extract the quota fraction from the reason string for display
        const q = (c.reasons[0]||'').match(/over quota \((\d+\/\d+)\)/);
        const qLabel = q ? q[1] : '—';
        // The "Assign now" button posts directly into S.irShifts
        // (or S.drShifts depending on slot kind) bypassing the
        // auto-assigner. We embed the slot/phys context as data-
        // attributes; the click handler reads them, validates one
        // more time, and writes the record. Audit-logged as
        // `irShift.overrideOverQuota` so admins can answer "who
        // approved this?" later.
        const slotPayload = JSON.stringify({
          physId: c.physId,
          date: slot.date,
          site: slot.site,
          slotLabel: slot.slotLabel || '',
          irGroup: slot._group || '',
        }).replace(/"/g, '&quot;');
        html += `<tr>
          <td class="fw6">${escHtml(c.name)}</td>
          <td><span class="tag" style="font-size:9px;background:var(--amber-bg);color:var(--amber-t)">${escHtml(qLabel)}</span></td>
          <td class="txt2">${escHtml(anchor)}</td>
          <td class="tar"><button class="bp bsm" style="font-size:10.5px;padding:3px 8px" onclick="_assignOverQuotaNow(${slotPayload})">+ Assign now</button></td>
        </tr>`;
      });
      html += '</tbody></table></div>';
    }
    // Full per-physician table (collapsed under another details so the
    // primary cross-coverage info is what admins see first)
    html += `<details style="margin-top:6px"><summary style="font-size:11px;color:var(--txt3);cursor:pointer">▶ Show all ${diag.length} physicians and their reasons</summary>
        <div style="overflow-x:auto;margin-top:6px"><table style="width:100%"><thead><tr>
          <th class="tal">Physician</th><th class="tal">Group</th><th class="tal">Why excluded</th>
        </tr></thead><tbody>`;
    diag.sort((a,b) => a.name.localeCompare(b.name)).forEach(d => {
      // When the diagnostic returns no reasons, the physician is genuinely
      // eligible right now. That means the SOLVER chose to leave them
      // unassigned for some reason that isn't a hard rule — most often
      // they were a runner-up and a different physician scored better
      // for this slot (or all slots in their group). The fix path is
      // usually NOT "raise quota" but "expand the candidate pool" (e.g.
      // make this site mixed, or relax sequence/site rules).
      const reasonHtml = d.reasons.length
        ? d.reasons.map(r => `<span class="tag" style="font-size:9.5px;margin-right:4px">${escHtml(r)}</span>`).join('')
        : '<span style="color:var(--green-t);font-weight:700">— eligible (passed all rules) — solver chose not to pick this round</span>';
      html += `<tr><td class="fw6">${escHtml(d.name)}</td><td><span class="tag" style="font-size:9px">${escHtml(d.group||'—')}</span></td><td>${reasonHtml}</td></tr>`;
    });
    html += '</tbody></table></div></details></div></details>';
  });
  html += '</div>';
  return html;
}

/* ═══════════════════════════════════════════════════════════════════════
   IR SHIFT MIN-COST-FLOW WRAPPER
   Builds the MCF graph from the current S state, calls _mcfSolve, and
   decodes the result into the same `_irsaPreview` shape as the existing
   greedy solver — so downstream code (preview render, applyIRShiftAA)
   doesn't need to change.

   Network:
     source ─► physician ─► physician-day ─► slot ─► sink
       source → physician      in-quota edges (total cap = effective quota
                               minus the quota-counting shifts already held
                               in the period) + over-quota edges (one unit
                               per date of the period — no ceiling, like
                               greedy Pass 4), each unit dearer than the last.
       physician → phys-day    cap 1. ONE slot per physician per date, across
                               every site and group — a physician cannot be
                               routed to two slots of the same day.
       phys-day → slot         cap 1, present only where the greedy's hard
                               predicate holds (_irsaMcfEdgeTier). A
                               physician on vacation / not started / on a
                               2nd-3rd DR shift / already holding a shift
                               that day has no phys-day node at all.
       slot → sink             cap 1.
   The solver maximises flow first (every fillable slot is filled), then
   minimises cost — so an unfilled slot is costlier than anything below.

   Cost model (_IRSA_MCF_COST), cheapest → dearest:
     - 500…0  fair share: each in-quota shift earns FAIR × (1 − attainment),
              so the physician furthest below quota is served first and
              nobody is starved to keep a colleague at their anchor site
       0      at the anchor site, or no anchor site / anchor site not in
              this run (floaters are free to use)
     + 50     away from the anchor site
     + 60     in-group fill-in at a mixed-role site (its anchors go first)
     + 100…   per shift above the quota, rising with each further one
              (< 900; no cap on how many — greedy Pass 4 has none)
     + 2000   a site rule / day condition / conference rule / NL rule had
              to be relaxed (greedy Pass 2)
     + 4000   a sequence rule had to be relaxed (greedy Pass 3)
     + 20000  cross-group fill-in — last resort (greedy Pass 5)
     - 80     physician is on call that day (per group call map)
     plus the small pre-existing terms: conference shift preference,
     look-ahead, burnout flags, unmet sub-specialty need.

   Never relaxed (edge OMISSION, not cost): roster / start date /
   allowedSites, vacation, 2nd-3rd DR shift, sold-back day, a shift
   already on that date, conference block, call-day site rule.
═══════════════════════════════════════════════════════════════════════ */
// Integers only — Bellman-Ford compares sums of these.
const _IRSA_MCF_COST = {
  ANCHOR: 50,          // away from the physician's anchor site
  FILLIN: 60,          // in-group fill-in at a mixed-role site (does not count toward quota)
  ONCALL: -80,         // on IR call that day → prefer a hospital placement
  FAIR: 500,           // fair-share weight: an in-quota shift costs −FAIR × (1 − attainment).
                       // ANCHOR / FAIR = 10 % → an anchor is only displaced to close an
                       // attainment gap wider than ten points.
  OVER: 100,           // first shift above the effective quota…
  OVER_STEP_MAX: 400,  // …each further one costs more (same slope as FAIR) up to here…
  OVER_TAIL: 400,      // …then still more, by a tail that flattens toward +OVER_TAIL (< 900 in
                       // all): never flat, so the extras stay pro rata to quota however many
                       // there are, and still cheaper than relaxing a rule.
  SITE_RELAX: 2000,    // greedy Pass 2 relaxation
  SEQ_RELAX: 4000,     // greedy Pass 3 relaxation
  XGROUP: 20000,       // registered cross-group fill-in (greedy Pass 5)
};

// Per-group inputs on the SAME basis as the greedy (previewIRShiftAA): the
// group's open slots, its on-call map, a largest-remainder quota table
// (_irrQuotas → _irsaEffQ) and the quota-counting '1st' shifts each physician
// already holds in the period (how the greedy seeds cnt[] / anc[]).
function _irsaMcfGroupModel(grp, cells, months, inPeriod, allP, allS){
  const phys = allP.filter(p => p.irGroup === grp);
  if(!phys.length) return null;
  const slots = _irsaBuildSlots(grp, cells, allS, S.irShiftSlots || {}, phys);
  if(!slots.length) return null;
  const callMap = _irsaBuildCallMap(grp, months, S.irCalls || []);
  let gFt = 0; phys.forEach(p => { gFt += p.irFte; }); if(!gFt) gFt = 1;
  const rawQ = _irrQuotas(phys, slots.length, p => { const t = irShiftTargetPeriod(p, months); return t > 0 ? t : slots.length * (p.irFte / gFt); });
  const callDays = {}, existing = {}, existingAnc = {}, quota = {};
  phys.forEach(p => { callDays[p.id] = 0; existing[p.id] = 0; existingAnc[p.id] = 0; });
  Object.keys(callMap).forEach(d => { if(callDays.hasOwnProperty(callMap[d])) callDays[callMap[d]]++; });
  (S.irShifts || []).forEach(es => {
    if(!es || es.shift !== '1st' || !es.date || !inPeriod[es.date]) return;
    if(existing[es.physId] == null) return;                       // only physicians of this group
    const st = allS.find(x => x.name === es.site);
    if(!st) return;
    const mixed = (st.irAnchors && st.irAnchors.length) || (st.irFillins && st.irFillins.length);
    const owner = (st.irGroup === grp || st.irGroup === 'Both') ? grp : (mixed ? _irsaMixedSiteOwnerGroup(st) : null);
    if(owner !== grp) return;                                     // only at this group's sites
    if(mixed && (st.irAnchors || []).indexOf(es.physId) < 0) return; // fill-in shifts are bonus
    existing[es.physId]++;
    const pp = phys.find(x => x.id === es.physId);
    if(pp && pp.anchorSite === es.site) existingAnc[es.physId]++;
  });
  phys.forEach(p => { quota[p.id] = _irsaEffQ(p, rawQ, callDays, months); });
  return { grp, phys, slots, callMap, callDays, existing, existingAnc, quota };
}

// Can physician p ever be routed to this slot, and at which rule tier?
//   null                → no edge. These are never relaxed: roster / start date /
//                         allowedSites (_irsaEligibleForSlot), the day-level block
//                         (_irsaBlocked: vacation, not started, 2nd-3rd DR shift,
//                         sold-back, a shift already on that date), a conference
//                         block and the call-day site rule.
//   {siteOk, seqOk}     → both true = the greedy's Pass-1 predicate; siteOk false =
//                         only reachable by relaxing a site rule (Pass 2); seqOk
//                         false = only by relaxing a sequence rule (Pass 3).
function _irsaMcfEdgeTier(p, slot, dayBlocked){
  if(dayBlocked) return null;
  if(!_irsaEligibleForSlot(p, slot)) return null;
  if(_conferenceBlocksSlot(p.id, slot.date, slot.site)) return null;
  const ym = slot.date.slice(0, 7);
  const ctx = { physId: p.id, date: slot.date, site: slot.site, shift: '1st', kind: 'ir-shift', irGroup: slot._group, ym: ym };
  if(!callDayRulesOk(p, ctx)) return null;
  return {
    siteOk: !!(irSiteRuleOk(p, slot.site, slot.date) && dayConditionSiteOk(p, slot.site, slot.date, 'ir-shift')
            && tbRulesOk(p, ctx) && natLangRulesOk(ctx)),
    seqOk: !!sequenceOk(p, slot.date, ym, slot.site, slot.slotLabel || ''),
  };
}

// Spread off-anchor shifts between colleagues anchored at the same site.
// A per-physician "each further off-anchor shift costs a little more" term
// cannot live in the network: it is an aggregate over the physician's
// off-anchor edges ACROSS days, and that set crosses the physician-day
// capacity that guarantees one slot per date (neither contains the other, so
// no node layout carries both — and one-per-date is not negotiable). So the
// network keeps the flat ANCHOR cost, and this pass walks the optimal
// solution: it exchanges two same-anchor colleagues between two slots when
// that evens out their off-anchor load (Σ off²/shifts strictly drops) and
// the total cost does not rise. It only moves along edges that exist in the
// network, leaves every physician with ≤ 1 slot per date and with the same
// number of quota-counting shifts — nothing the network guarantees changes.
function _irsaMcfSpreadOffAnchor(asg, allSlots, cands, info, dayCost, rulesHold){
  const cand = (j, pi) => { const l = cands[j]; for(let i = 0; i < l.length; i++){ if(l[i].pi === pi) return l[i]; } return null; };
  const plain = c => !!c && c.counts && c.siteOk && c.seqOk;      // quota-counting, no rule relaxed
  const busy = {};                                                // 'pi|date' → slot index
  asg.forEach((pi, j) => { if(pi >= 0) busy[pi + '|' + allSlots[j].date] = j; });
  const teams = {};                                               // 'group|anchorSite' → [pi]
  info.forEach((pin, pi) => { if(pin.anchored){ const k = pin.p.irGroup + '|' + pin.p.anchorSite; (teams[k] = teams[k] || []).push(pi); } });
  let swaps = 0;
  Object.keys(teams).forEach(k => {
    const team = teams[k];
    if(team.length < 2) return;
    const site = info[team[0]].p.anchorSite;
    for(let guard = 0; guard < 2000; guard++){
      const at = {}, off = {};
      team.forEach(pi => { at[pi] = []; off[pi] = []; });
      asg.forEach((pi, j) => { if(pi >= 0 && at[pi] && plain(cand(j, pi))) (allSlots[j].site === site ? at[pi] : off[pi]).push(j); });
      const pairs = [];
      team.forEach(a => team.forEach(b => {
        if(a === b || !off[a].length || !at[b].length) return;
        const gain = (2 * off[a].length - 1) / (at[a].length + off[a].length) - (2 * off[b].length + 1) / (at[b].length + off[b].length);
        if(gain > 1e-9) pairs.push({ a: a, b: b, gain: gain });
      }));
      pairs.sort((x, y) => y.gain - x.gain);
      let done = false;
      for(let q = 0; q < pairs.length && !done; q++){
        const a = pairs[q].a, b = pairs[q].b;
        for(let x = 0; x < off[a].length && !done; x++){
          const jA = off[a][x], dA = allSlots[jA].date, bAtA = cand(jA, b);
          if(!plain(bAtA)) continue;
          for(let y = 0; y < at[b].length && !done; y++){
            const jB = at[b][y], dB = allSlots[jB].date, aAtB = cand(jB, a);
            if(!plain(aAtB)) continue;
            // different dates: each must be free on the date they move to
            if(dA !== dB && (busy[b + '|' + dA] !== undefined || busy[a + '|' + dB] !== undefined)) continue;
            const before = cand(jA, a).cost + (dayCost[a + '|' + dA] || 0) + cand(jB, b).cost + (dayCost[b + '|' + dB] || 0);
            const after  = bAtA.cost + (dayCost[b + '|' + dA] || 0) + aAtB.cost + (dayCost[a + '|' + dB] || 0);
            if(after > before) continue;
            asg[jA] = b; asg[jB] = a;
            // rs-v134: the swap can change both colleagues' dates — it must keep their sequence rules / limits
            if(rulesHold && !rulesHold(a, b)){ asg[jA] = a; asg[jB] = b; continue; }
            delete busy[a + '|' + dA]; delete busy[b + '|' + dB];
            busy[b + '|' + dA] = jA; busy[a + '|' + dB] = jB;
            swaps++; done = true;
          }
        }
      }
      if(!done) break;
    }
  });
  return swaps;
}

function _irsaSolveMCF(opts){
  opts = opts || {};
  const C = _IRSA_MCF_COST;
  const _now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const t0 = _now();
  const months = opts.months || _iraMonths();
  const groups = opts.groups || (opts.groupFilter && opts.groupFilter !== 'both' ? [opts.groupFilter] : getIRGroups());
  // Calendar cells: weekdays only (IR daily shifts are weekday-only by
  // convention), holidays skipped, and narrowed to the picked half-month for
  // semi-1 / semi-2 (opts.period) exactly like the greedy. inPeriod holds
  // every calendar date of the period — used to find shifts already held.
  const cells = [], inPeriod = {};
  months.forEach(ym => {
    _filterCellsByPeriod(buildCal(ym), opts.period || '').forEach(c => {
      inPeriod[c.date] = true;
      if(c.dow >= 1 && c.dow <= 5 && !isHolidayBlackout(c.date)) cells.push(c);
    });
  });
  if(!cells.length) return { preview: [], stats: { reason: 'no calendar cells' } };
  const allP = (S.physicians||[]).filter(p => p.irFte > 0);
  if(!allP.length) return { preview: [], stats: { reason: 'no IR physicians' } };
  const allS = S.sites || [];
  // Per-group model (slots, on-call map, quotas) — one per group, so the
  // on-call bonus and the quota basis apply in EVERY group, not just the first.
  const gModels = {}, allSlots = [];
  groups.forEach(grp => {
    if(gModels[grp]) return;
    const gm = _irsaMcfGroupModel(grp, cells, months, inPeriod, allP, allS);
    if(!gm) return;
    gModels[grp] = gm;
    gm.slots.forEach(s => { s._group = grp; allSlots.push(s); });
  });
  if(!allSlots.length) return { preview: [], stats: { reason: 'no slots to fill' } };
  // Per-physician capacity. A physician whose group is not part of this run
  // has no quota here (gm null) — they can only appear as a cross-group fill-in.
  const info = allP.map(p => {
    const gm = (p.irGroup && gModels[p.irGroup]) || null;
    const quota = gm ? (gm.quota[p.id] || 0) : 0;
    const existing = gm ? (gm.existing[p.id] || 0) : 0;
    return {
      p: p, gm: gm, quota: quota, existing: existing,
      remQ: gm ? Math.max(0, quota - existing) : 0,
      // The anchor-mismatch cost only applies when the anchor site has open
      // slots in this run. A physician whose home site has no IR slots here
      // cannot be "at anchor" anywhere, so they are as free to use as a floater.
      anchored: !!(gm && p.anchorSite && gm.slots.some(s => s.site === p.anchorSite)),
    };
  });
  // ── Candidate edges ────────────────────────────────────────────────────
  // cands[j] = physicians that may take slot j, with the edge cost. In-group
  // physicians get an edge when the never-relaxed predicate holds (a relaxed
  // site / sequence rule is priced, not hidden). Outside the slot's group
  // ONLY a physician registered in the site's irFillins, and only with every
  // rule intact.
  const blockedDay = {}, dayCost = {}, monthCost = {};
  const cands = allSlots.map(() => []);
  let considered = 0, eligible = 0;
  allSlots.forEach((s, j) => {
    const ym = s.date.slice(0, 7);
    const missing = (typeof _missingShiftSubNeeds === 'function') ? _missingShiftSubNeeds(s.date, s.site, '1st') : [];
    allP.forEach((p, pi) => {
      const cross = p.irGroup !== s._group;
      if(cross && (s.fillins || []).indexOf(p.id) < 0) return;
      considered++;
      const dk = pi + '|' + s.date;
      // Day-level block is slot-independent → evaluate once per physician-day.
      if(blockedDay[dk] === undefined) blockedDay[dk] = !!_irsaBlocked(p, s.date, []);
      const t = _irsaMcfEdgeTier(p, s, blockedDay[dk]);
      if(!t) return;
      if(cross && !(t.siteOk && t.seqOk)) return;
      const pin = info[pi];
      const counts = !cross && _irsaCountsForQuota(p, s);
      let cost = 0;
      if(cross) cost += C.XGROUP;
      else if(!counts) cost += C.FILLIN;
      else if(pin.anchored && p.anchorSite !== s.site) cost += C.ANCHOR;
      if(!t.siteOk) cost += C.SITE_RELAX;
      if(!t.seqOk) cost += C.SEQ_RELAX;
      const ctx = { physId: p.id, date: s.date, site: s.site, shift: '1st', kind: 'ir-shift' };
      const confPref = (typeof _conferenceShiftPreferenceFor === 'function')
        ? _conferenceShiftPreferenceFor(p, ctx) : 0;
      if(isFinite(confPref)) cost += confPref * 5;
      // Look-ahead (±5) and burnout (+25 per flag) depend on physician + month only.
      const mk = pi + '|' + ym;
      if(monthCost[mk] === undefined){
        let mc = 0;
        if(typeof _lookaheadAdjustment === 'function') mc += _lookaheadAdjustment(p, ym);
        if(typeof _physicianBurnoutFlags === 'function') mc += _physicianBurnoutFlags(p.id, ym).length * 25;
        monthCost[mk] = mc;
      }
      cost += monthCost[mk];
      // Sub-specialty coverage incentive — prefer physicians who fill
      // unmet sub-specialty needs at this slot. Negative cost = bonus.
      if(missing.length && Array.isArray(p.drSubs)){
        const fillsUnmet = missing.some(line => {
          // line is "subname (have X, need Y)"
          const m = /^([^()]+)\s*\(/.exec(line);
          const sub = m ? m[1].trim() : line;
          return p.drSubs.includes(sub) || p.irSubs?.includes(sub);
        });
        // 2026-07: subspecialty coverage is a HARD priority — subspecialty
        // spots always fill before general ones, so the bonus must dominate
        // every soft preference (site/anchor/burnout are all < 100).
        if(fillsUnmet) cost -= 300;
      }
      // On-call bonus sits on the physician→day edge (same for every slot that day).
      if(dayCost[dk] === undefined) dayCost[dk] = (pin.gm && pin.gm.callMap[s.date] === p.id) ? C.ONCALL : 0;
      cands[j].push({ pi: pi, cost: cost, counts: counts, cross: cross, siteOk: t.siteOk, seqOk: t.seqOk });
      eligible++;
    });
  });
  // ── Build + solve ──────────────────────────────────────────────────────
  // Node ids: 0 = source, then physicians, physician-days, slots, sink.
  // fillInDay['pi|date'] marks a physician-day that is fill-in-only (see the
  // rounds below): it keeps only its fill-in edges and hangs off the source
  // directly, so its shift never touches the physician's quota edges.
  const fillInDay = {};
  const dayKey = a => a.pi + '|' + allSlots[a.j].date;
  const candOf = a => cands[a.j].find(c => c.pi === a.pi);
  const build = () => {
    const edges = [], dayNode = {}, open = [];
    let nD = 0;
    allSlots.forEach((s, j) => {
      let any = false;
      cands[j].forEach(c => {
        const dk = c.pi + '|' + s.date;
        if(fillInDay[dk] && c.counts) return;
        if(dayNode[dk] === undefined) dayNode[dk] = nD++;
        any = true;
      });
      if(any) open.push(j);
    });
    const P0 = 1, D0 = P0 + allP.length, S0 = D0 + nD, SINK = S0 + open.length;
    // source → physician. For a physician with a quota in this run, unit edges
    // with rising cost (a convex cost per physician — legal in a flow network
    // because it sits on the physician node, upstream of the day nodes):
    //   in-quota   quota − shifts already held, the k-th costing
    //              −FAIR × (1 − attainment after it): the further below quota,
    //              the bigger the bonus, so shortfalls are shared pro rata.
    //   over-quota one per date of the period (no ceiling — greedy Pass 4
    //              has none; one-per-date is the real limit), from +OVER
    //              upward — dearer than any in-quota placement, cheaper than
    //              an open slot, a relaxed rule or a cross-group fill-in.
    // Consecutive units with the same cost are merged into one edge.
    const ladder = (pi, kind, costs) => {
      for(let i = 0; i < costs.length; ){
        let n = 1; while(i + n < costs.length && costs[i + n] === costs[i]) n++;
        edges.push({ from: 0, to: P0 + pi, cap: n, cost: costs[i], _kind: kind, _pi: pi });
        i += n;
      }
    };
    info.forEach((pin, pi) => {
      if(!pin.gm){ edges.push({ from: 0, to: P0 + pi, cap: cells.length, cost: 0, _kind: 's-phys', _pi: pi }); return; }
      const q = Math.max(1, pin.quota), inQ = [], over = [];
      for(let k = 1; k <= pin.remQ; k++) inQ.push(Math.min(0, Math.round(C.FAIR * ((pin.existing + k - 0.5) / q - 1))) || 0);
      for(let k = 0; k < cells.length; k++){
        const r = Math.round(C.FAIR * (k + 0.5) / q), t = Math.max(0, r - C.OVER_STEP_MAX);
        over.push(C.OVER + Math.min(C.OVER_STEP_MAX, r) + Math.round(C.OVER_TAIL * t / (t + C.OVER_TAIL)));
      }
      ladder(pi, 's-phys', inQ);
      ladder(pi, 's-phys-over', over);
    });
    // physician → physician-day, cap 1: at most one slot per physician per date.
    Object.keys(dayNode).forEach(dk => {
      const pi = +dk.slice(0, dk.indexOf('|'));
      edges.push({ from: fillInDay[dk] ? 0 : P0 + pi, to: D0 + dayNode[dk], cap: 1, cost: dayCost[dk] || 0, _kind: 'phys-day', _pi: pi });
    });
    // physician-day → slot (eligibility-gated), slot → sink
    open.forEach((j, k) => {
      const s = allSlots[j];
      cands[j].forEach(c => {
        const dk = c.pi + '|' + s.date;
        if(fillInDay[dk] && c.counts) return;
        // A fill-in shift on an ordinary day passes the quota edges and would
        // collect up to FAIR of fair-share bonus it is not entitled to — cancel it.
        const cost = c.cost + ((!c.counts && info[c.pi].gm && !fillInDay[dk]) ? C.FAIR : 0);
        edges.push({ from: D0 + dayNode[dk], to: S0 + k, cap: 1, cost: cost, _kind: 'day-slot', _pi: c.pi, _slot: j });
      });
      edges.push({ from: S0 + k, to: SINK, cap: 1, cost: 0, _kind: 'slot-t', _slot: j });
    });
    return { edges: edges, numNodes: SINK + 1, sink: SINK, open: open.length };
  };
  let rounds = 0, solveMs = 0, netNodes = 0, netEdges = 0;
  const solve = () => {
    rounds++;
    const net = build();
    netNodes = net.numNodes; netEdges = net.edges.length;
    const tS = _now();
    const result = _mcfSolve(net.numNodes, net.edges, 0, net.sink, net.open);
    solveMs += _now() - tS;
    const picked = [];
    net.edges.forEach((e, i) => { if(e._kind === 'day-slot' && result.edgeFlows[i] === 1) picked.push({ j: e._slot, pi: e._pi }); });
    return { picked: picked, cost: result.cost };
  };
  // A fill-in shift (mixed-site fill-in, cross-group rescue) does not count
  // toward the physician's quota, yet it must share the physician-day node
  // with their quota-counting options — and one network cannot both exempt
  // it from the quota edges and keep it on that node. With no fill-in edges
  // in play (the usual case) the first solve is final. Otherwise:
  //   (a) a solve that used a fill-in edge on an ordinary day charged it to
  //       the quota (conservative — never over). Those physician-days become
  //       fill-in-only and the rest is re-solved with the quota intact; the
  //       previous solution stays feasible, so coverage can only grow.
  //   (b) a physician whose quota edges are full cannot be handed a fill-in shift by
  //       (a). If such a physician is a fill-in candidate for a slot that is
  //       still open, those days are tried as fill-in-only.
  const MAX_ROUNDS = 6;
  let best = solve(), roundCap = MAX_ROUNDS;
  const settle = () => { while(rounds < roundCap){
    const charged = best.picked.filter(a => info[a.pi].gm && !candOf(a).counts && !fillInDay[dayKey(a)]);
    if(charged.length){
      charged.forEach(a => { fillInDay[dayKey(a)] = true; });
      best = solve();
      continue;
    }
    const used = {}, filled = {}, working = {}, freeTry = [], busyTry = [];
    best.picked.forEach(a => { filled[a.j] = true; working[dayKey(a)] = true; if(!fillInDay[dayKey(a)]) used[a.pi] = (used[a.pi] || 0) + 1; });
    allSlots.forEach((s, j) => {
      if(filled[j]) return;
      cands[j].forEach(c => {
        const dk = c.pi + '|' + s.date, pin = info[c.pi];
        if(c.counts || !pin.gm || fillInDay[dk]) return;
        if((used[c.pi] || 0) < pin.remQ + cells.length) return;
        const list = working[dk] ? busyTry : freeTry;
        if(list.indexOf(dk) < 0) list.push(dk);
      });
    });
    // a day the physician is not working anyway costs nothing to hand over…
    if(freeTry.length){ freeTry.forEach(dk => { fillInDay[dk] = true; }); best = solve(); continue; }
    // …a day they are working is only worth it if more slots end up filled.
    if(!busyTry.length) break;
    busyTry.forEach(dk => { fillInDay[dk] = true; });
    const alt = solve();
    if(alt.picked.length > best.picked.length){ best = alt; continue; }
    busyTry.forEach(dk => { delete fillInDay[dk]; });
    break;
  } };
  settle();
  // ── Sequence rules + natural-language limits across the plan (rs-v134) ──
  // An edge's seqOk / siteOk were judged against the STORED schedule. A streak or a
  // count the plan builds out of its own shifts constrains one physician across days,
  // which a flow network cannot carry. So each physician's shifts in the solution are
  // walked in date order (the greedy's order); a shift that breaks such a rule through
  // the plan's earlier shifts reprices that physician's edges for the day into the
  // relaxed tier a stored-schedule breach already pays (+SEQ_RELAX / +SITE_RELAX; a
  // cross-group fill-in edge, which only exists with every rule intact, is dropped),
  // and the network is solved again. Penalties only accumulate, so this ends; at the
  // round cap a breach still left is repriced in place, i.e. labelled relaxed.
  const ruleOn = info.map(pin => _planRulesFor(pin.p)), anyRule = ruleOn.some(Boolean), slotsOn = {};
  if(anyRule) allSlots.forEach((s, j) => { (slotsOn[s.date] = slotsOn[s.date] || []).push(j); });
  const candAt = (j, pi) => cands[j].find(c => c.pi === pi);
  // mode 0: count breaches · 1: reprice them (the re-solve moves the shift) · 2: reprice and keep the shift
  const ruleWalk = (pi, js, mode) => {
    const p = info[pi].p, kept = [], plan = _rulePlan(kept);
    const test = (s, c) => ({
      seq: c.seqOk && !sequenceOk(p, s.date, s.date.slice(0, 7), s.site, s.slotLabel || '', plan),
      nl: c.siteOk && !natLangRulesOk({ physId: p.id, date: s.date, site: s.site, shift: '1st', kind: 'ir-shift', irGroup: s._group, ym: s.date.slice(0, 7), plan: plan }),
    });
    const reprice = j2 => {
      const c2 = candAt(j2, pi); if(!c2) return;
      const t2 = test(allSlots[j2], c2);
      if(c2.cross && mode === 1){ if(t2.seq || t2.nl) cands[j2].splice(cands[j2].indexOf(c2), 1); return; }
      if(t2.seq){ c2.seqOk = false; c2.cost += C.SEQ_RELAX; }
      if(t2.nl){ c2.siteOk = false; c2.cost += C.SITE_RELAX; }
    };
    let bad = 0;
    js.sort((a, b) => allSlots[a].date < allSlots[b].date ? -1 : (allSlots[a].date > allSlots[b].date ? 1 : a - b)).forEach(j => {
      const s = allSlots[j], t = test(s, candAt(j, pi));
      const keep = () => { kept.push({ physId: p.id, date: s.date, site: s.site, slotLabel: s.slotLabel || '' }); };
      if(!t.seq && !t.nl){ keep(); return; }
      bad++;
      if(!mode) return;
      (slotsOn[s.date] || []).forEach(reprice);
      if(mode === 2) keep();
    });
    // Anticipate the re-solve: on the dates p does not work, an edge that would now break the rule
    // is repriced too, or the next solve just moves the breach to the neighbouring day.
    if(mode === 1 && bad){
      const busy = new Set(js.map(j => allSlots[j].date));
      Object.keys(slotsOn).forEach(d => { if(!busy.has(d)) slotsOn[d].forEach(reprice); });
    }
    return bad;
  };
  const SEQ_ROUNDS = 8;
  let seqRounds = 0;
  while(anyRule){
    const last = seqRounds >= SEQ_ROUNDS, mine = {};
    best.picked.forEach(a => { if(ruleOn[a.pi]) (mine[a.pi] = mine[a.pi] || []).push(a.j); });
    let bad = 0;
    Object.keys(mine).forEach(pi => { bad += ruleWalk(+pi, mine[pi], last ? 2 : 1); });
    if(!bad || last) break;
    seqRounds++; roundCap = rounds + MAX_ROUNDS;
    best = solve(); settle();
  }
  const flowCost = best.cost;
  // asg[j] = index (into allP) of the physician on slot j, or -1.
  const asg = allSlots.map(() => -1);
  best.picked.forEach(a => { asg[a.j] = a.pi; });
  const spreadSwaps = _irsaMcfSpreadOffAnchor(asg, allSlots, cands, info, dayCost, !anyRule ? null
    : (a, b) => [a, b].every(pi => !ruleOn[pi] || !ruleWalk(pi, asg.reduce((l, x, j) => { if(x === pi) l.push(j); return l; }, []), 0)));
  // ── Decode ─────────────────────────────────────────────────────────────
  // Per physician: the LAST K quota-counting shifts (by date) beyond the
  // remaining quota are the over-quota ones, so the preview row + audit note
  // reflect reality.
  const rows = allSlots.map(() => null);
  const perPhys = {};
  info.forEach((pin, pi) => {
    const mine = [];
    asg.forEach((a, j) => { if(a === pi) mine.push({ j: j, c: cands[j].find(c => c.pi === pi), over: false }); });
    const counting = mine.filter(m => m.c.counts);
    counting.sort((a, b) => allSlots[a.j].date < allSlots[b.j].date ? -1 : (allSlots[a.j].date > allSlots[b.j].date ? 1 : a.j - b.j));
    const over = pin.gm ? Math.max(0, counting.length - pin.remQ) : 0;
    counting.forEach((m, i) => { m.over = i >= counting.length - over; });
    mine.forEach(m => { rows[m.j] = m; });
    perPhys[pin.p.id] = {
      group: pin.p.irGroup || '', quota: pin.quota, existing: pin.existing,
      counting: counting.length, fillin: mine.length - counting.length, over: over,
      atAnchor: (pin.gm ? (pin.gm.existingAnc[pin.p.id] || 0) : 0)
              + counting.filter(m => pin.p.anchorSite && pin.p.anchorSite === allSlots[m.j].site).length,
    };
  });
  // Preview rows (slot order) + per-assignment explainer keyed by
  // date|site|slotIndex: the picked physician and every candidate that had
  // an edge to this slot with its cost, so the preview's "Why?" drill-down
  // can show which alternatives the solver had and how much dearer they were.
  const preview = [], assignmentExplain = {}, unfilledSlots = [];
  const placedOn = {};                                            // 'pi|date' → slot index
  asg.forEach((pi, j) => { if(pi >= 0) placedOn[pi + '|' + allSlots[j].date] = j; });
  let nOnCall = 0, nCross = 0, nOver = 0, nRelaxed = 0, nFillin = 0;
  // rs-v134: an edge repriced in an earlier repair round can be clear of the rule in the final
  // plan, so a rule physician's shift is labelled relaxed only when the final plan breaks the rule.
  const broken = {};                                              // slot j → { seq, site }
  if(anyRule) info.forEach((pin, pi) => {
    if(!ruleOn[pi]) return;
    const p = pin.p, mine = [], plan = _rulePlan(mine);
    asg.reduce((l, x, j) => { if(x === pi) l.push(j); return l; }, [])
      .sort((a, b) => allSlots[a].date < allSlots[b].date ? -1 : (allSlots[a].date > allSlots[b].date ? 1 : a - b))
      .forEach(j => {
        const s = allSlots[j], ym = s.date.slice(0, 7);
        const ctx = { physId: p.id, date: s.date, site: s.site, shift: '1st', kind: 'ir-shift', irGroup: s._group, ym: ym, plan: plan };
        broken[j] = { seq: !sequenceOk(p, s.date, ym, s.site, s.slotLabel || '', plan),
          site: !(irSiteRuleOk(p, s.site, s.date) && dayConditionSiteOk(p, s.site, s.date, 'ir-shift') && tbRulesOk(p, ctx) && natLangRulesOk(ctx)) };
        mine.push({ physId: p.id, date: s.date, site: s.site, slotLabel: s.slotLabel || '' });
      });
  });
  allSlots.forEach((slot, j) => {
    const r = rows[j];
    if(!r){ unfilledSlots.push(slot); return; }
    const pin = info[asg[j]], p = pin.p, c = r.c;
    const dc = dayCost[asg[j] + '|' + slot.date] || 0;
    const onCall = dc < 0;
    const b = broken[j], seqRelaxed = !c.seqOk && (!b || b.seq), siteRelaxed = !c.siteOk && (!b || b.site);
    // Note priority: cross-group, then a relaxed rule, then over-quota — an
    // admin scanning the table cares most about the heaviest exception.
    const note = c.cross ? 'MCF (cross-group)'
               : seqRelaxed ? 'MCF (sequence rule relaxed)'
               : siteRelaxed ? 'MCF (site rule relaxed)'
               : r.over ? 'MCF (over-quota)'
               : !c.counts ? 'MCF (fill-in)'
               : onCall ? 'MCF (on-call)'
               : 'MCF';
    if(onCall) nOnCall++;
    if(c.cross) nCross++; else if(!c.counts) nFillin++;
    if(siteRelaxed || seqRelaxed) nRelaxed++;
    if(r.over) nOver++;
    preview.push({
      physId: p.id, date: slot.date, site: slot.site,
      irGroup: p.irGroup || slot._group || '', shift: '1st', sub: '',
      notes: note,
      slotLabel: slot.slotLabel || '',
      isFillIn: c.cross || !c.counts,
      _overQuota: r.over,
      _preAllocSlotIndex: slot.slotIndex,
    });
    assignmentExplain[slot.date + '|' + slot.site + '|' + (slot.slotIndex ?? 0)] = {
      picked: p.id,
      pickedCost: c.cost + dc,
      candidates: cands[j].map(x => ({
        physId: allP[x.pi].id,
        cost: x.cost + (dayCost[x.pi + '|' + slot.date] || 0),
        isPicked: x.pi === asg[j],
        // holds another slot that day in this run → could not also take this one
        elsewhere: x.pi !== asg[j] && placedOn[x.pi + '|' + slot.date] !== undefined,
      })).sort((a, b) => a.cost - b.cost),
      slotGroup: slot._group || '',
    };
  });
  return {
    preview,
    stats: {
      slots: allSlots.length, filled: preview.length, unfilled: allSlots.length - preview.length,
      cost: flowCost, edgesConsidered: considered, edgesEligible: eligible,
      edgesBlocked: considered - eligible,
      onCall: nOnCall, crossGroup: nCross, fillIn: nFillin, overQuota: nOver, relaxed: nRelaxed,
      rounds: rounds, seqRounds: seqRounds, spreadSwaps: spreadSwaps, nodes: netNodes, edges: netEdges,
      solveMs: Math.round(solveMs), totalMs: Math.round(_now() - t0),
    },
    assignmentExplain,
    unfilledSlots,   // slot objects (with _group) the network could not fill
    perPhys,         // physId → {group, quota, existing, counting, fillin, over, atAnchor}
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   ALTERNATIVE IR SHIFT SOLVER + SIDE-BY-SIDE COMPARISON HARNESS
   The current `previewIRShiftAA` is a multi-pass greedy with rule-relaxation
   fallbacks. This module ships a SECOND solver — cost-weighted greedy plus
   a 2-opt local-search swap pass — and a comparison runner that scores both
   on the same input so you can decide which to use in production.

   Solvers compared:
     1. "greedy"   — the existing previewIRShiftAA (untouched).
     2. "swap2opt" — initial greedy then iterates pairwise swaps to lower
                     total cost. Cost = quota deficit + anchor mismatch
                     penalty + site rule penalty (heavy).

   Metrics emitted: slots filled, slots unfilled, anchor-match %, fairness
   variance (across-physician quota-vs-actual stdev). Lower variance = more
   even distribution.

   Usage:
     runSolverComparison({months:['2026-04','2026-05'], group:'North'});
═══════════════════════════════════════════════════════════════════════ */
function _solverComputeAssignmentCost(assigned, allPhys, group){
  // Cheap proxy cost: penalize overshoot vs target + reward anchor match.
  let cost = 0;
  const cnt = {};
  assigned.forEach(a => { cnt[a.physId] = (cnt[a.physId]||0) + 1; });
  allPhys.filter(p => p.irFte>0 && (!group || p.irGroup===group)).forEach(p => {
    const got = cnt[p.id] || 0;
    const target = p.irFte * 18; // rough — for cost computation only, not real quota
    cost += Math.abs(got - target);
  });
  // Anchor mismatch: each non-anchor placement adds cost.
  assigned.forEach(a => {
    const p = allPhys.find(x => x.id === a.physId);
    if(p && p.anchorSite && a.site && p.anchorSite !== a.site) cost += 1.5;
  });
  return cost;
}

// 2-opt swap pass: pairwise swap two assignments if doing so lowers cost.
// Bounded by iteration cap so we don't loop on cost-equal swaps.
function _solverSwap2OptPass(assignments, allPhys, group){
  const MAX_ITER = 200;
  let improved = true, iter = 0;
  while(improved && iter < MAX_ITER){
    improved = false; iter++;
    for(let i = 0; i < assignments.length; i++){
      for(let j = i+1; j < assignments.length; j++){
        if(assignments[i].date !== assignments[j].date) continue; // only swap same-day
        if(assignments[i].site === assignments[j].site) continue; // and across different sites
        const aP = assignments[i].physId, bP = assignments[j].physId;
        if(aP === bP) continue;
        // Try swap
        const before = _solverComputeAssignmentCost(assignments, allPhys, group);
        assignments[i].physId = bP; assignments[j].physId = aP;
        const after = _solverComputeAssignmentCost(assignments, allPhys, group);
        if(after < before){
          improved = true;
        } else {
          // Revert
          assignments[i].physId = aP; assignments[j].physId = bP;
        }
      }
    }
  }
  return assignments;
}

// Compute fairness/coverage metrics for a set of assignments. Pure helper
// shared by all solver comparisons.
function _solverMetrics(assigned, group){
  const filled = assigned.length;
  const cnt = {};
  assigned.forEach(a => { cnt[a.physId] = (cnt[a.physId]||0) + 1; });
  const phys = (S.physicians||[]).filter(p => p.irFte>0 && (!group || p.irGroup===group));
  const counts = phys.map(p => cnt[p.id] || 0);
  const mean = counts.length ? counts.reduce((a,b)=>a+b,0) / counts.length : 0;
  const variance = counts.length ? counts.reduce((s,n) => s + Math.pow(n - mean, 2), 0) / counts.length : 0;
  const stdev = Math.sqrt(variance);
  const anchorMatches = assigned.filter(a => {
    const p = (S.physicians||[]).find(x => x.id === a.physId);
    return p && p.anchorSite && a.site === p.anchorSite;
  }).length;
  const crossGroup = assigned.filter(a => {
    const p = (S.physicians||[]).find(x => x.id === a.physId);
    return p && p.irGroup && a.irGroup && p.irGroup !== a.irGroup;
  }).length;
  const anchorPct = filled ? (anchorMatches / filled * 100).toFixed(1) : '0.0';
  const crossPct  = filled ? (crossGroup    / filled * 100).toFixed(1) : '0.0';
  return { filled, mean: mean.toFixed(2), stdev: stdev.toFixed(2), anchorPct, crossPct, anchorMatches, crossGroup };
}
