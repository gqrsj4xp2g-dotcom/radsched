let _dateIdxVersion = 0;
let _dateIdxBuilt   = -1;
let _dateIdx        = null; // {dr, ir, irc, wkn, vac} maps date → array

// Bumped on every triggerSave so the next read rebuilds the index from
// fresh state. Cheap (just an integer increment); the rebuild itself only
// runs when something actually reads after a mutation.
function _markDateIdxDirty(){ _dateIdxVersion++; }

// ── Long-lived interval registry ─────────────────────────────────────
// Audit pass 3 finding: 7 module-level setInterval calls (notif dot,
// save dot, sticky-bar apply, last-saved age, net badge, stale-save
// badge, on-call reminder scheduler) never get cleared on logout.
// On a long-lived tab that switches practices or logs out + back in,
// duplicate timers accumulate forever. New API:
//   _rsRegisterInterval('name', handle, opts)
//   _rsClearAllIntervals()  — called from doLogout
// Pass `keepOnLogout: true` for genuinely user-scoped timers (e.g.
// theme-pref refresh) so they survive a sign-out + sign-in cycle.
const _rsIntervals = new Map();
function _rsRegisterInterval(name, handle, opts){
  if(!handle) return handle;
  // Clear any prior handle registered under the same name so callers
  // can re-register without leaking the previous one.
  const prev = _rsIntervals.get(name);
  if(prev){
    try{ clearInterval(prev.handle); }catch(_){}
  }
  _rsIntervals.set(name, { handle, keepOnLogout: !!(opts && opts.keepOnLogout) });
  return handle;
}
function _rsClearAllIntervals(opts){
  const includeKeep = !!(opts && opts.includeKeepOnLogout);
  _rsIntervals.forEach((entry, name) => {
    if(!includeKeep && entry.keepOnLogout) return;
    try{ clearInterval(entry.handle); }catch(_){}
    _rsIntervals.delete(name);
  });
}

function _rebuildDateIdx(){
  const idx = { dr:{}, ir:{}, irc:{}, wkn:{}, vac:{} };
  const push = (m, k, v) => { (m[k] = m[k] || []).push(v); };
  (S.drShifts    || []).forEach(s => { if(s.date) push(idx.dr,  s.date, s); });
  (S.irShifts    || []).forEach(s => { if(s.date) push(idx.ir,  s.date, s); });
  (S.irCalls     || []).forEach(c => {
    if(!c.date) return;
    if(c.callType === 'daily'){ push(idx.irc, c.date, c); return; }
    // Weekend IR call covers 4 days starting Friday; index all 4 so a single
    // O(1) lookup tells you whether the date is covered.
    if(c.callType === 'weekend'){
      push(idx.irc, c.date, c);
      try{ push(idx.irc, addDays(c.date, 1), c); }catch(_){}
      try{ push(idx.irc, addDays(c.date, 2), c); }catch(_){}
      try{ push(idx.irc, addDays(c.date, 3), c); }catch(_){}
    }
  });
  (S.weekendCalls || []).forEach(w => {
    const sat = w.satDate || w.date;
    if(sat) push(idx.wkn, sat, w);
    if(w.sunDate) push(idx.wkn, w.sunDate, w);
  });
  (S.vacations || []).forEach(v => {
    if(!v.start) return;
    try{
      let cur = parseDateLocal(v.start);
      const end = parseDateLocal(v.end || v.start);
      while(cur <= end){
        push(idx.vac, fmtDate(cur), v);
        cur.setDate(cur.getDate() + 1);
      }
    }catch(_){}
  });
  _dateIdx = idx;
}

// Public read API. Returns the cached array for the (kind, date) pair;
// returns an empty array (not undefined) so callers can safely `.filter`.
function _shiftsOnDate(kind, date){
  if(!date) return [];
  if(_dateIdxBuilt !== _dateIdxVersion){
    try{
      _rebuildDateIdx();
      _dateIdxBuilt = _dateIdxVersion;
    }catch(e){
      _logError('_rebuildDateIdx', 'Date index rebuild failed', e);
      return []; // fall back to empty so render doesn't crash
    }
  }
  return (_dateIdx[kind] && _dateIdx[kind][date]) || [];
}

// ── Physician lookup index ────────────────────────────────────────────────
// `S.physicians.find(x => x.id === id)` is called 200+ times across render
// loops, auto-assigners, and rule evaluators. Each is O(N) over the roster
// (usually 30–60 physicians) and runs inside hot paths like calendar render
// (one find per cell × cell count). On a 6-month rebalance preview we'd
// re-scan the array thousands of times.
//
// Cache as a Map<id, physician>. Invalidated by triggerSave (which already
// bumps _dateIdxVersion); we re-use the same dirty counter so the cache
// rebuilds at the same moment the date index does.
let _physByIdMap = null;
let _physByIdBuilt = -1;
function _physById(id){
  if(id == null) return null;
  if(_physByIdBuilt !== _dateIdxVersion){
    try{
      const m = new Map();
      (S.physicians || []).forEach(p => { if(p && p.id != null) m.set(p.id, p); });
      _physByIdMap = m;
      _physByIdBuilt = _dateIdxVersion;
    }catch(e){
      _logError('_physById', 'Physician index rebuild failed', e);
      // Fall back to a linear scan. Slow but correct; better than crashing
      // every render after a state-shape change in S.physicians.
      return (S.physicians || []).find(p => p && p.id === id) || null;
    }
  }
  return _physByIdMap.get(id) || null;
}
