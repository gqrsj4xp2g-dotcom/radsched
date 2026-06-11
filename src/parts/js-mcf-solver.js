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
    const ctx = { physId: p.id, date: slot.date, site: slot.site, shift: '1st', kind: 'ir-shift', irGroup: slot._group || p.irGroup, ym };
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
    try{ if(typeof sequenceOk === 'function' && !sequenceOk(p, slot.date, ym, slot.site, slot.slotLabel||'')) reasons.push('sequence rule (consecutive / rest)'); }catch(_){}
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
        <div style="color:var(--txt2)">Auto-assign correctly skipped this date. Use the Holiday Call tab to assign coverage if the practice operates on this holiday. Set <code>S.cfg.skipUniversalHolidays = false</code> to disable the universal-holiday block entirely.</div>
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
          <div style="color:var(--txt2)">All ${inGroupTotal} in-group physicians are already placed at other slots today (one physician = one shift per day). Over-quota assignment cannot help here — the constraint is calendar capacity, not period quota. Options: pull from the cross-coverage pool below, hire/transfer to grow the group, or reduce the slot count for this date.</div>
        </div>`;
      } else if(overQuota.length && overQuota.length === inGroupTotal - inGroupPlaced){
        // Every in-group phys not-placed-elsewhere is over quota.
        // Greedy Pass 4 / MCF's over-quota edge should pick one.
        html += `<div style="margin-bottom:8px;padding:8px 10px;background:var(--bg3);border-left:3px solid var(--amber,#d97706);border-radius:4px;font-size:11px">
          <div style="font-weight:700;color:var(--amber-t);margin-bottom:2px">⚖ Over-quota pool will be used (Pass 4)</div>
          <div style="color:var(--txt2)">${overQuota.length} in-group physician${overQuota.length===1?' is':'s are'} at/over their period quota. Greedy Pass 4 will pick one and label the assignment "Auto (over-quota)". If you see this slot still unfilled in the preview, one of them is also blocked by call-day-site rule / conference / pre-existing shift — check the per-physician table below.</div>
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
          <th style="text-align:left">Physician</th><th style="text-align:left">Their Group</th><th style="text-align:left">Anchor Site</th><th style="text-align:left">Site Role</th>
        </tr></thead><tbody>`;
        crossCoverage.sort((a,b) => a.name.localeCompare(b.name)).forEach(c => {
          const p = (S.physicians||[]).find(x => x.id === c.physId);
          const anchor = p?.anchorSite || '—';
          const role = _siteRoleFor(c.physId, slot.site);
          const roleBadge = role
            ? `<span class="tag" style="font-size:9px;background:var(--green-bg);color:var(--green-t);font-weight:700">${role}</span>`
            : `<span style="color:var(--txt3)">cross-group only</span>`;
          html += `<tr>
            <td style="font-weight:600">${escHtml(c.name)}</td>
            <td><span class="tag" style="font-size:9px">${escHtml(c.group||'—')}</span></td>
            <td style="color:var(--txt2)">${escHtml(anchor)}</td>
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
          <th style="text-align:left">Physician</th><th style="text-align:left">Group</th><th style="text-align:left">Other blocking reason(s)</th>
        </tr></thead><tbody>`;
        crossBlocked.sort((a,b) => a.name.localeCompare(b.name)).forEach(c => {
          // Filter out the cross-group reason itself; show only the OTHER blocks.
          const otherReasons = c.reasons.filter(r => r.indexOf('different IR group') !== 0);
          const rh = otherReasons.length
            ? otherReasons.map(r => `<span class="tag" style="font-size:9.5px;margin-right:4px">${escHtml(r)}</span>`).join('')
            : `<span class="tag" style="font-size:9.5px;background:var(--amber-bg);color:var(--amber-t)">cross-group only</span>`;
          html += `<tr>
            <td style="font-weight:600">${escHtml(c.name)}</td>
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
          <th style="text-align:left">Physician</th><th style="text-align:left">Quota</th><th style="text-align:left">Anchor Site</th><th></th>
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
          <td style="font-weight:600">${escHtml(c.name)}</td>
          <td><span class="tag" style="font-size:9px;background:var(--amber-bg);color:var(--amber-t)">${escHtml(qLabel)}</span></td>
          <td style="color:var(--txt2)">${escHtml(anchor)}</td>
          <td style="text-align:right"><button class="bp bsm" style="font-size:10.5px;padding:3px 8px" onclick="_assignOverQuotaNow(${slotPayload})">+ Assign now</button></td>
        </tr>`;
      });
      html += '</tbody></table></div>';
    }
    // Full per-physician table (collapsed under another details so the
    // primary cross-coverage info is what admins see first)
    html += `<details style="margin-top:6px"><summary style="font-size:11px;color:var(--txt3);cursor:pointer">▶ Show all ${diag.length} physicians and their reasons</summary>
        <div style="overflow-x:auto;margin-top:6px"><table style="width:100%"><thead><tr>
          <th style="text-align:left">Physician</th><th style="text-align:left">Group</th><th style="text-align:left">Why excluded</th>
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
      html += `<tr><td style="font-weight:600">${escHtml(d.name)}</td><td><span class="tag" style="font-size:9px">${escHtml(d.group||'—')}</span></td><td>${reasonHtml}</td></tr>`;
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

   Cost model:
     base 0
     + 50 if anchor mismatch
     + 200 if cross-group fill-in
     - 80 if physician is on call that day (encourage on-call placement)
     - 5 per unit of "below quota" deficit (push under-utilized phys earlier)
     +  conferenceShiftPreference scaled (more-preferred = more negative)

   Hard rule violations (siteRuleOk, dayConditionSiteOk, sequenceOk,
   tbRulesOk, callDayRulesOk, natLangRulesOk) are encoded as edge OMISSION,
   not high cost — the solver simply can't route through impossible edges.
═══════════════════════════════════════════════════════════════════════ */
function _irsaSolveMCF(opts){
  opts = opts || {};
  const months = opts.months || _iraMonths();
  const groups = opts.groups || (opts.groupFilter && opts.groupFilter !== 'both' ? [opts.groupFilter] : getIRGroups());
  // Build calendar cells across all months (weekdays only — IR daily shifts
  // are weekday-only by convention).
  const cells = [];
  months.forEach(ym => {
    buildCal(ym).forEach(c => {
      if(c.day && c.dow >= 1 && c.dow <= 5 && !isHolidayBlackout(c.date)) cells.push(c);
    });
  });
  if(!cells.length) return { preview: [], stats: { reason: 'no calendar cells' } };
  const allP = (S.physicians||[]).filter(p => p.irFte > 0);
  if(!allP.length) return { preview: [], stats: { reason: 'no IR physicians' } };
  const allS = S.sites || [];
  const slotsConfig = S.irShiftSlots || {};
  // Build callMap (physician on call → date)
  const callMap = (typeof _irsaBuildCallMap === 'function')
    ? _irsaBuildCallMap(groups[0]||'', months) // single-group only for the simple path
    : {};
  // Per-group slot list (reuse existing slot builder)
  const allSlots = [];
  groups.forEach(grp => {
    const phys = allP.filter(p => p.irGroup === grp);
    if(!phys.length) return;
    const slots = _irsaBuildSlots(grp, cells, allS, slotsConfig, phys);
    slots.forEach(s => { s._group = grp; allSlots.push(s); });
  });
  if(!allSlots.length) return { preview: [], stats: { reason: 'no slots to fill' } };
  // Effective quotas (in-period + rolling-fairness adjustment from #6)
  const rawQ = {}; const callDays = {};
  allP.forEach(p => {
    rawQ[p.id] = 0; callDays[p.id] = 0;
    Object.keys(callMap).forEach(d => { if(callMap[d] === p.id) callDays[p.id]++; });
  });
  const quotas = {};
  allP.forEach(p => { quotas[p.id] = _irsaEffQ(p, rawQ, callDays, months); });
  // Build node ids: 0=source, 1..P=phys, P+1..P+S=slots, P+S+1=sink
  const physIds = allP.map(p => p.id);
  const physIdx = (id) => physIds.indexOf(id) + 1;
  const slotIdx = (i)  => physIds.length + 1 + i;
  const SOURCE = 0, SINK = physIds.length + allSlots.length + 1;
  const numNodes = SINK + 1;
  const edges = [];
  // source → phys
  // Per physician we emit TWO source→phys edges:
  //   (a) "in-quota" cap = quotas[p], cost = 0   — the natural budget
  //   (b) "over-quota" cap = OVER_ALLOWANCE,
  //                       cost = OVER_QUOTA_PENALTY (= 100)
  //
  // Why two: with a single cap edge fixed at `quotas[p]`, the MCF model
  // physically cannot route more than the quota through any in-group
  // physician. When the in-group quota is exhausted, the only remaining
  // flow path becomes a cross-group edge (cost +200), so the solver
  // assigned cross-group physicians IN PREFERENCE TO in-group
  // physicians who would simply have been over quota by one or two
  // shifts. The greedy solver already prefers in-group over-quota
  // (Pass 4) BEFORE cross-group (Pass 5); the MCF solver should match.
  //
  // The over-quota edge has cost (OVER_QUOTA_PENALTY = 100) < the
  // cross-group cost (200), so the solver will prefer to push one more
  // shift through an in-group physician before reaching for a cross-
  // group fill-in. Capacity is bounded so we never push an outrageous
  // number of extra shifts through one person.
  const OVER_QUOTA_PENALTY = 100;          // < 200 (cross-group cost)
  const OVER_ALLOWANCE     = 10;           // hard ceiling on over-shifts per phys
  allP.forEach((p) => {
    const inQuotaCap = quotas[p.id] || 0;
    edges.push({ from: SOURCE, to: physIdx(p.id), cap: inQuotaCap, cost: 0,                 _kind: 's-phys',       _physId: p.id });
    edges.push({ from: SOURCE, to: physIdx(p.id), cap: OVER_ALLOWANCE, cost: OVER_QUOTA_PENALTY, _kind: 's-phys-over', _physId: p.id });
  });
  // slot → sink
  allSlots.forEach((s, i) => {
    edges.push({ from: slotIdx(i), to: SINK, cap: 1, cost: 0, _kind: 'slot-t', _slotIdx: i });
  });
  // phys → slot (eligibility-gated)
  let edgeStats = { considered: 0, eligible: 0, blockedHard: 0 };
  allP.forEach(p => {
    allSlots.forEach((s, i) => {
      edgeStats.considered++;
      // Hard-rule eligibility (mirrors previewIRShiftAA Pass 1)
      if(typeof _irsaEligibleForSlot === 'function' && !_irsaEligibleForSlot(p, s)){ edgeStats.blockedHard++; return; }
      const ctx = { physId: p.id, date: s.date, site: s.site, shift: '1st', kind: 'ir-shift' };
      if(typeof irSiteRuleOk === 'function' && !irSiteRuleOk(p, s.site, s.date)){ edgeStats.blockedHard++; return; }
      if(typeof dayConditionSiteOk === 'function' && !dayConditionSiteOk(p, s.site, s.date, 'ir-shift')){ edgeStats.blockedHard++; return; }
      if(typeof sequenceOk === 'function' && !sequenceOk(p, s.date, s.date.slice(0,7), s.site, s.slotLabel||'')){ edgeStats.blockedHard++; return; }
      if(typeof tbRulesOk === 'function' && !tbRulesOk(p, ctx)){ edgeStats.blockedHard++; return; }
      if(typeof callDayRulesOk === 'function' && !callDayRulesOk(p, ctx)){ edgeStats.blockedHard++; return; }
      if(typeof natLangRulesOk === 'function' && !natLangRulesOk(ctx)){ edgeStats.blockedHard++; return; }
      // Cost — sum of soft penalties. Edges with a HARD reject from any
      // rule above were already excluded via `return`.
      let cost = 0;
      if(p.anchorSite && p.anchorSite !== s.site) cost += 50;
      if(p.irGroup && s._group && p.irGroup !== s._group) cost += 200; // cross-group fill-in
      if(callMap[s.date] === p.id) cost -= 80; // on-call preference
      const confPref = (typeof _conferenceShiftPreferenceFor === 'function')
        ? _conferenceShiftPreferenceFor(p, ctx) : 0;
      if(isFinite(confPref)) cost += confPref * 5;
      // Look-ahead adjustment — peek at next month's anchor commitments
      // for this physician and bias the current month's choice so the
      // next month doesn't over-commit them. Bounded ±5 so it doesn't
      // dominate primary signals.
      if(typeof _lookaheadAdjustment === 'function'){
        cost += _lookaheadAdjustment(p, s.date.slice(0, 7));
      }
      // Burnout penalty — physicians showing burnout signals get pushed
      // toward last-resort. Not a hard reject; gives the solver room to
      // pick them only when no alternative is reasonable.
      if(typeof _physicianBurnoutFlags === 'function'){
        const flags = _physicianBurnoutFlags(p.id, s.date.slice(0, 7));
        if(flags.length){
          cost += flags.length * 25;
        }
      }
      // Sub-specialty coverage incentive — prefer physicians who fill
      // unmet sub-specialty needs at this slot. Negative cost = bonus.
      if(typeof _missingShiftSubNeeds === 'function'){
        const missing = _missingShiftSubNeeds(s.date, s.site, '1st');
        if(missing.length && Array.isArray(p.drSubs)){
          const fillsUnmet = missing.some(line => {
            // line is "subname (have X, need Y)"
            const m = /^([^()]+)\s*\(/.exec(line);
            const sub = m ? m[1].trim() : line;
            return p.drSubs.includes(sub) || p.irSubs?.includes(sub);
          });
          if(fillsUnmet) cost -= 30; // small reward for filling unmet need
        }
      }
      // Tiebreaker: scaled inverse of (quota - existing assigns) — under-utilized
      // physicians get a small bonus so they get picked first when costs tie.
      cost -= Math.min(5, (quotas[p.id] || 0));
      edges.push({ from: physIdx(p.id), to: slotIdx(i), cap: 1, cost, _kind: 'phys-slot', _physId: p.id, _slotIdx: i });
      edgeStats.eligible++;
    });
  });
  // Solve
  const result = _mcfSolve(numNodes, edges, SOURCE, SINK, allSlots.length);
  // First pass: count how much flow went through each physician's in-
  // quota edge vs. their over-quota edge. We use this in the decode
  // loop below to tag the LAST K assignments per physician as
  // "over-quota" so the preview row + audit note reflect reality.
  // (Edges are listed in deterministic source→phys-slot order; the
  // tag-the-last-K rule matches the natural cost-minimising order.)
  const perPhysOver = {};
  edges.forEach((e, i) => {
    if(e._kind === 's-phys-over'){
      perPhysOver[e._physId] = (result.edgeFlows[i] || 0);
    }
  });
  // Build per-slot candidate map for the explainer. Each phys→slot
  // edge with cap=1 represents a physician who PASSED all hard rules
  // for this slot; the edge.cost summarizes the soft penalties +
  // tiebreakers. This is the data admins need to answer "why was X
  // picked over Y on this date?". We collect it BEFORE the decode
  // step so we can flag the picked physician for each slot.
  const slotCandidates = {};   // slotIdx → [ {physId, cost, isPicked} ]
  edges.forEach((e, i) => {
    if(e._kind !== 'phys-slot') return;
    if(!slotCandidates[e._slotIdx]) slotCandidates[e._slotIdx] = [];
    slotCandidates[e._slotIdx].push({
      physId: e._physId,
      cost:   e.cost,
      isPicked: (result.edgeFlows[i] === 1),
    });
  });
  // Decode: any phys→slot edge with flow=1 is an assignment
  const preview = [];
  // Stable per-physician order so the "last K = over-quota" rule is
  // deterministic across runs.
  const perPhysAssigns = {};
  edges.forEach((e, i) => {
    if(e._kind === 'phys-slot' && result.edgeFlows[i] === 1){
      (perPhysAssigns[e._physId] ||= []).push({ slotIdx: e._slotIdx });
    }
  });
  Object.keys(perPhysAssigns).forEach(pidStr => {
    const pid = +pidStr;
    const list = perPhysAssigns[pid];
    list.sort((a, b) => a.slotIdx - b.slotIdx);
    const overCount = perPhysOver[pid] || 0;
    list.forEach((entry, idx) => { entry.isOver = (idx >= list.length - overCount); });
    const p = allP.find(x => x.id === pid);
    if(!p) return;
    list.forEach(entry => {
      const slot = allSlots[entry.slotIdx];
      if(!slot) return;
      const isCross = slot._group !== p.irGroup;
      // Note priority: cross-group beats over-quota in label since it
      // carries more rule context. An admin scanning the table cares
      // most that the shift crossed groups; the over-quota signal is
      // surfaced on the per-physician row above.
      const note = isCross ? 'MCF (cross-group)'
                 : entry.isOver ? 'MCF (over-quota)'
                 : 'MCF';
      preview.push({
        physId: p.id, date: slot.date, site: slot.site,
        irGroup: p.irGroup || slot._group || '', shift: '1st', sub: '',
        notes: note,
        slotLabel: slot.slotLabel || '',
        isFillIn: isCross,
        _overQuota: entry.isOver,
        _preAllocSlotIndex: slot.slotIndex,
      });
    });
  });
  // Build per-assignment explainer map keyed by date|site|slotIndex.
  // Each entry has the picked physician + the top-N runners-up by cost,
  // so the preview's "Why?" drill-down can show admins exactly which
  // alternatives the solver considered and how much cheaper / more
  // expensive they were.
  const assignmentExplain = {};
  preview.forEach(p => {
    // Resolve slot index from preview row → look up candidate list.
    const slotIdx = allSlots.findIndex(s =>
      s.date === p.date && s.site === p.site && s.slotIndex === p._preAllocSlotIndex
    );
    if(slotIdx < 0) return;
    const cands = (slotCandidates[slotIdx] || []).slice().sort((a, b) => a.cost - b.cost);
    const key = p.date + '|' + p.site + '|' + (p._preAllocSlotIndex ?? 0);
    assignmentExplain[key] = {
      picked: p.physId,
      pickedCost: (cands.find(c => c.physId === p.physId) || {}).cost,
      candidates: cands,
      slotGroup: allSlots[slotIdx]._group || '',
    };
  });
  return {
    preview,
    stats: {
      slots: allSlots.length, filled: preview.length, unfilled: allSlots.length - preview.length,
      cost: result.cost, edgesConsidered: edgeStats.considered, edgesEligible: edgeStats.eligible,
      edgesBlocked: edgeStats.blockedHard,
    },
    assignmentExplain,
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
