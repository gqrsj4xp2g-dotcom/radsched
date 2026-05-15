/* ─── IR CALENDAR ─── */
function renderIRCal(){
  const ym=document.getElementById('irc-mo').value||new Date().toISOString().slice(0,7);
  const fg=document.getElementById('irc-grp')?.value||'';
  const fpid=+document.getElementById('irc-phys')?.value||0;
  const fsite=document.getElementById('irc-site')?.value||'';
  const view=document.getElementById('irc-view')?.value||'both';

  // Populate physician filter on first call
  const physSel=document.getElementById('irc-phys');
  if(physSel&&physSel.options.length<2){
    S.physicians.filter(p=>p.irFte>0).forEach(p=>{
      const o=document.createElement('option');
      o.value=p.id;o.text=p.last+', '+p.first+' ['+p.irGroup+']';
      physSel.appendChild(o);
    });
  }
  // Populate hospital filter — sites configured + any site referenced
  // by IR shifts or IR calls.
  const siteSel=document.getElementById('irc-site');
  if(siteSel && siteSel.options.length<2){
    const sites = new Set();
    (S.sites || []).forEach(s => { if(s && s.name) sites.add(s.name); });
    (S.irShifts || []).forEach(s => { if(s.site) sites.add(s.site); });
    (S.irCalls || []).forEach(c => { if(c.site) sites.add(c.site); });
    [...sites].sort().forEach(name => {
      const o = document.createElement('option'); o.value = name; o.text = name; siteSel.appendChild(o);
    });
  }
  // Persist IR Calendar filters so navigating away + back doesn't
  // wipe the admin's filter selections.
  if(typeof _rsHydrateFilter === 'function'){
    _rsHydrateFilter(document.getElementById('irc-grp'),  'rs.irc.f.group');
    _rsHydrateFilter(physSel,                              'rs.irc.f.phys');
    _rsHydrateFilter(siteSel,                              'rs.irc.f.site');
    _rsHydrateFilter(document.getElementById('irc-view'), 'rs.irc.f.view');
  }
  // Predicates (one per record-kind, applied by the multi-view renders).
  function _matchIRCall(c){
    if(fg && c.irGroup !== fg) return false;
    if(fpid && c.physId !== fpid) return false;
    if(fsite && c.site !== fsite) return false;
    return true;
  }
  function _matchIRShift(s){
    if(fpid && s.physId !== fpid) return false;
    if(fsite && s.site !== fsite) return false;
    if(fg){
      // Group-filter the SHIFT path by the physician's irGroup since
      // shifts don't carry irGroup themselves.
      const p = _physById(s.physId);
      if(!p || p.irGroup !== fg) return false;
    }
    return true;
  }
  // View routing — Day / Week / Month / List.
  const ircView = (function(){ try{ return localStorage.getItem('rs.irc.view') || 'month'; }catch(_){ return 'month'; } })();
  const ircFocus = (function(){
    let v = ''; try{ v = localStorage.getItem('rs.irc.focusDate') || ''; }catch(_){}
    return v || fmtDate(new Date());
  })();
  const _ircIds = { day:'irc-day-section', week:'irc-week-section', month:'irc-month-section', list:'irc-list-section' };
  Object.entries(_ircIds).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if(el) el.style.display = (k === ircView) ? '' : 'none';
  });
  document.querySelectorAll('button[data-ircview]').forEach(b => {
    const on = b.getAttribute('data-ircview') === ircView;
    b.style.fontWeight = on ? '700' : '500';
    b.style.background = on ? 'var(--blue-bg)' : 'var(--bg3)';
    b.style.color      = on ? 'var(--blue-t)'  : 'var(--txt2)';
    b.style.border     = '1px solid ' + (on ? 'var(--blue-t)' : 'var(--bdr)');
  });
  const focusEl = document.getElementById('irc-focus');
  if(focusEl && focusEl.value !== ircFocus) focusEl.value = ircFocus;
  if(ircView === 'day')       _renderIRCalDayView(ircFocus,  _matchIRCall, _matchIRShift, view);
  else if(ircView === 'week') _renderIRCalWeekView(ircFocus, _matchIRCall, _matchIRShift, view);
  // List is scoped to the focus WEEK so it stays short. Step ‹ ›
  // moves by week (see ircStepFocus).
  else if(ircView === 'list') _renderIRCalListView(ircFocus, _matchIRCall, _matchIRShift, view);
  // Month view always populates (the existing render runs below).

  const vm=vacMap();
  const cells=buildCal(ym);
  const today=fmtDate(new Date());
  const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const irShifts=S.irShifts||[];

  document.getElementById('irc-head').innerHTML=DAYS.map(d=>`<div class="cal-hd">${d}</div>`).join('');
  document.getElementById('irc-body').innerHTML=cells.map(c=>{
    if(!c.day) return '<div class="cal-day other"></div>';
    let callEvs='', shiftEvs='';

    // ── CALL EVENTS ──
    if(view==='both'||view==='call'){
      S.irCalls.filter(_matchIRCall).forEach(ic=>{
        let show=false;
        if(ic.callType==='daily'&&ic.date===c.date) show=true;
        if(ic.callType==='weekend'){const mon=addDays(ic.date,3);if(c.date>=ic.date&&c.date<=mon)show=true;}
        if(!show)return;
        let ev;
        // Pick a CSS background/color combo for any IR group. North/South
        // keep their iconic blue/green; custom groups rotate through a stable
        // palette keyed by group name hash so the same group always gets the
        // same color throughout the app.
        const _irCalStyles = {
          'North': 'background:#eff6ff;color:#1e40af;border:1px solid #93c5fd',
          'South': 'background:#f0fdf4;color:#166534;border:1px solid #86efac',
        };
        const _irCalCustomPalette = [
          'background:#faf5ff;color:#6b21a8;border:1px solid #d8b4fe',  // purple
          'background:#fef3c7;color:#78350f;border:1px solid #fcd34d',  // amber
          'background:#fee2e2;color:#991b1b;border:1px solid #fca5a5',  // red
          'background:#ecfeff;color:#155e75;border:1px solid #67e8f9',  // cyan
        ];
        let grpColor = _irCalStyles[ic.irGroup];
        if(!grpColor){
          let _h = 0;
          for(let _i=0; _i<(ic.irGroup||'').length; _i++){ _h = ((_h<<5) - _h + ic.irGroup.charCodeAt(_i)) | 0; }
          grpColor = _irCalCustomPalette[Math.abs(_h) % _irCalCustomPalette.length];
        }
        const holNote=ic.notes?.includes('Holiday')?'🏖 ':'';
        if(ic.callType==='weekend'){
          const isStart=ic.date===c.date;
          const siteSh=(ic.site||'').split(' ')[0];
          ev=`<div class="ev" style="${grpColor}" title="${pnameHtml(ic.physId)} — Weekend Call (${ic.irGroup}) @ ${ic.site}${ic.notes?' · '+ic.notes:''}">
            <div style="font-weight:700;font-size:11px">${holNote}${pshort(ic.physId)}</div>
            <div style="font-size:9px;opacity:.85">${isStart?'▶ ':''}Wknd Call · ${ic.irGroup}</div>
            ${siteSh?`<div style="font-size:9px;opacity:.7">${siteSh}</div>`:''}
          </div>`;
        } else {
          // Daily (weekday) call covers the entire IR group. The chip is
          // the group-level representation; hospital is intentionally not
          // shown because daily-call ownership is group-wide, not
          // per-hospital. If a site happened to be stored on the call
          // record (it shouldn't be for daily, but defensively handle it),
          // that info stays on the physician's IR shift chip alongside
          // where it naturally belongs.
          ev=`<div class="ev" style="${grpColor}" title="${pnameHtml(ic.physId)} — Daily Call (${ic.irGroup})${ic.notes?' · '+ic.notes:''}">
            <div style="font-weight:700;font-size:11px">${holNote}${pshort(ic.physId)}</div>
            <div style="font-size:9px;opacity:.85">Daily Call · ${ic.irGroup}</div>
          </div>`;
        }
        callEvs+=ev;
      });
    }

    // ── DAILY SHIFT EVENTS ──
    if(view==='both'||view==='shifts'){
      _shiftsOnDate('ir', c.date).filter(_matchIRShift).forEach(s=>{
        let style;
        if(s.shift==='Home')        style='background:#fdf4ff;color:#6b21a8;border:1px dashed #d8b4fe';
        else if(s.shift==='1st')    style='background:#eff6ff;color:#1e40af;border:1px solid #93c5fd';
        else if(s.shift==='2nd')    style='background:#f0fdf4;color:#166534;border:1px solid #86efac';
        else                        style='background:#fefce8;color:#713f12;border:1px solid #fcd34d';
        const siteSh=(s.site||'').split(' ')[0];
        const subLbl=s.sub?` · ${s.sub.slice(0,6)}`:'';
        // Slot labels (e.g. "chn 1", "chn 2") let admins name distinct
        // positions within the same site/shift. Previously the calendar
        // rendered only the site short name ("CHN") so two positions at
        // the same site were visually indistinguishable. Now the slot
        // label appears after the site short. Falls back gracefully when
        // no slotLabel is configured.
        const slotLbl = s.slotLabel ? ` · ${s.slotLabel}` : '';
        const shiftLbl=s.shift==='1st'?'Day Shift':s.shift==='Home'?'Home':s.shift+' Shift';
        if(s.shift==='Home'){
          shiftEvs+=`<div class="ev" style="${style}" title="${pnameHtml(s.physId)} — Home @ ${s.site}">
            <div style="font-weight:700;font-size:11px">🏠 ${pshort(s.physId)}</div>
            <div style="font-size:9px;opacity:.8">Home</div>
          </div>`;
        } else {
          shiftEvs+=`<div class="ev" style="${style}" title="${pnameHtml(s.physId)} — ${shiftLbl} @ ${s.site}${s.slotLabel?' ['+s.slotLabel+']':''}${s.sub?' ('+s.sub+')':''}">
            <div style="font-weight:700;font-size:11px">${pshort(s.physId)}</div>
            <div style="font-size:9px;opacity:.85">${shiftLbl}</div>
            <div style="font-size:9px;opacity:.7">${siteSh}${slotLbl}${subLbl}${_driveTimeBadge(s.physId,s.site,s.shift,s.date,'IR')}</div>
          </div>`;
        }
      });
      // DR shifts for IR/MIXED physicians — any DR assignment (1st/2nd/3rd/Home,
      // whether autoHome or manually added) should appear on the IR calendar so
      // the physician and admin can see the complete day schedule for that person.
      // Previously this only surfaced autoHome shifts, hiding legitimate regular
      // DR assignments made via the Schedule Builder or import.
      _shiftsOnDate('dr', c.date).filter(s=>(!fpid||s.physId===fpid)).forEach(s=>{
        const p=S.physicians.find(x=>x.id===s.physId);
        if(!p||p.irFte===0)return;             // only IR-eligible physicians
        if(fg&&p.irGroup!==fg)return;          // respect IR group filter

        if(s.autoHome || s.shift==='Home'){
          const lbl = s.autoHome ? 'Auto-Home' : 'Home';
          const cls = s.autoHome ? 'e-home-auto' : 'ehome';
          shiftEvs+=`<div class="ev ${cls}" title="${pnameHtml(s.physId)} — ${lbl} (DR)">
            <div style="font-weight:700;font-size:11px">🏠 ${pshort(s.physId)}</div>
            <div style="font-size:9px;opacity:.8">${lbl} (DR)</div>
          </div>`;
        } else {
          // Regular DR shift (1st / 2nd / 3rd). Use a purple-tinged style so it's
          // visually distinct from IR shifts but still blends with the calendar.
          const drStyle = s.shift==='1st' ? 'background:#ede9fe;color:#5b21b6;border:1px solid #c4b5fd'
                        : s.shift==='2nd' ? 'background:#fae8ff;color:#6b21a8;border:1px solid #e9d5ff'
                        :                   'background:#fdf4ff;color:#7e22ce;border:1px solid #f0abfc';
          const siteSh = (s.site||'').split(' ')[0];
          const subLbl = s.sub ? ` · ${s.sub.slice(0,6)}` : '';
          // DR slot label — see comment in IR branch above; same pattern.
          const slotLbl = s.slotLabel ? ` · ${s.slotLabel}` : '';
          shiftEvs+=`<div class="ev" style="${drStyle}" title="${pnameHtml(s.physId)} — DR ${s.shift} Shift @ ${s.site}${s.slotLabel?' ['+s.slotLabel+']':''}${s.sub?' ('+s.sub+')':''}">
            <div style="font-weight:700;font-size:11px">${pshort(s.physId)}</div>
            <div style="font-size:9px;opacity:.85">DR ${s.shift}</div>
            <div style="font-size:9px;opacity:.7">${siteSh}${slotLbl}${subLbl}</div>
          </div>`;
        }
      });

      // ── TUMOR BOARDS & CLINICS ──
      // Recurring conferences render on the IR calendar when an IR-eligible
      // physician is assigned (via rotation slots or blanket allowedPhysIds).
      // Gating mirrors _emitRecurringEvents in the calendar feed so what
      // shows here matches what physicians see on their subscribed calendars:
      //   • Respect the phys filter — only show occurrences where the
      //     selected physician is an assigned participant.
      //   • Respect the group filter — only show when at least one assigned
      //     phys is in the selected IR group (or any IR group if 'both').
      //   • Fail-safe: when rotation is enabled but no assignment is stored
      //     yet (brand-new board, or date past the auto-assign window),
      //     treat the occurrence as ungated and surface it. Hiding in that
      //     case produced the "my clinics don't show up" symptom.
      const _emitRecur = (items, emoji, kindLabel, bgStyle) => {
        (items||[]).forEach(item => {
          if(!item.active && item.active !== undefined) return;
          const occs = _eventOccurrencesInRange(item, c.date, c.date);
          if(!occs.length || occs[0] !== c.date) return;
          const assignedIds = _rotationPhysIdsFor(item, c.date);
          let participantIds;
          if(item.rotation && item.rotation.enabled && assignedIds.length){
            participantIds = assignedIds;
          } else {
            participantIds = item.allowedPhysIds || [];
          }
          if(fpid && !participantIds.includes(fpid)) return;
          const irParticipants = participantIds.filter(pid => {
            const pp = S.physicians.find(x => x.id === pid);
            return pp && (pp.irFte > 0);
          });
          if(!irParticipants.length) return;
          if(fg){
            const hasGroupMatch = irParticipants.some(pid => {
              const pp = S.physicians.find(x => x.id === pid);
              return pp && pp.irGroup === fg;
            });
            if(!hasGroupMatch) return;
          }
          const namesShort = irParticipants.map(pid => pshort(pid)).join(', ');
          const namesFull  = irParticipants.map(pid => pname(pid)).join(', ');
          const time = item.time || '07:00';
          const dur  = item.durationMin || 60;
          shiftEvs += `<div class="ev" style="${bgStyle}" title="${emoji} ${(item.name||'').replace(/</g,'&lt;')} · ${time} (${dur}m) · ${namesFull}">
            <div style="font-weight:700;font-size:11px">${emoji} ${(item.name||'').slice(0,18).replace(/</g,'&lt;')}</div>
            <div style="font-size:9px;opacity:.85">${kindLabel} · ${time}</div>
            <div style="font-size:9px;opacity:.7">${namesShort}</div>
          </div>`;
        });
      };
      _emitRecur(S.tumorBoards, '🔬', 'Tumor Bd', 'background:#fef3c7;color:#78350f;border:1px solid #fbbf24');
      _emitRecur(S.clinics,     '🏥', 'Clinic',   'background:#cffafe;color:#155e75;border:1px solid #67e8f9');
    }

    // ── SEPARATOR between call and shifts ──
    const divider=(view==='both'&&callEvs&&shiftEvs)
      ?'<div style="height:1px;background:var(--bdr2);margin:2px 0"></div>':'';

    // ── HOLIDAYS & VACATIONS ──
    let metaEvs='';
    S.holidays.filter(h=>{
      if(h.date!==c.date) return false;
      // Accept legacy 'IR' plus any 'IR-<group>' — works for custom groups.
      if(h.group!=='IR' && !/^IR-/.test(h.group||'')) return false;
      if(fpid && h.physId!==fpid) return false;
      if(fg){
        // Filter by IR group: IR-<groupName> matches directly; legacy 'IR'
        // falls back to the physician's current irGroup.
        const _m = /^IR-(.+)$/.exec(h.group||'');
        if(_m) return _m[1] === fg;
        const ph=S.physicians.find(x=>x.id===h.physId);
        return ph?.irGroup===fg;
      }
      return true;
    }).forEach(h=>{
      metaEvs+=`<div class="ev ehol" title="${pnameHtml(h.physId)} — Holiday Call: ${h.name}">
        <div style="font-weight:700;font-size:11px">🏖 ${pshort(h.physId)}</div>
        <div style="font-size:9px;opacity:.85">Hol Call</div>
        <div style="font-size:9px;opacity:.7">${h.name.split(' ')[0]}</div>
      </div>`;
    });
    (vm[c.date]||[]).filter(pid=>{
      const p=S.physicians.find(x=>x.id===pid&&x.irFte>0);
      return p&&(!fg||p.irGroup===fg)&&(!fpid||pid===fpid);
    }).forEach(pid=>{
      metaEvs+=`<div class="ev evac" title="${pnameHtml(pid)} — Vacation/Time Off">
        <div style="font-weight:700;font-size:11px">${pshort(pid)}</div>
        <div style="font-size:9px;opacity:.8">Time Off</div>
      </div>`;
    });

    return `<div class="cal-day${c.date===today?' today':''}${c.isWknd?' wknd':''}" style="min-height:90px">
      <div class="cal-num">${c.day}</div>${callEvs}${divider}${shiftEvs}${metaEvs}</div>`;
  }).join('');
}

// ── IR calendar — Day / Week / List view renders ─────────────────
function _renderIRCalDayView(focusISO, matchCall, matchShift, view){
  const el = document.getElementById('irc-day-section');
  if(!el) return;
  const d = parseDateLocal(focusISO);
  const today = fmtDate(new Date());
  const dayLabel = d.toLocaleString('default', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  const isToday = focusISO === today;
  // Daily IR call that's active today (incl. weekend-call mon→fri tail)
  const calls = (S.irCalls || []).filter(c => {
    if(!matchCall(c)) return false;
    if(c.callType === 'daily') return c.date === focusISO;
    if(c.callType === 'weekend'){
      const mon = addDays(c.date, 3);
      return focusISO >= c.date && focusISO <= mon;
    }
    return false;
  });
  const shifts = (S.irShifts || []).filter(s => s.date === focusISO && matchShift(s));
  let html = `<div class="card" style="margin-bottom:12px">
    <div class="card-title" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span>${escHtml(dayLabel)}</span>
      ${isToday ? '<span class="tag tb" style="font-size:10px">TODAY</span>' : ''}
      <span class="tag tg" style="font-size:10px">${shifts.length} shift${shifts.length===1?'':'s'} · ${calls.length} call${calls.length===1?'':'s'}</span>
    </div>`;
  if(!calls.length && !shifts.length){
    html += '<div class="note ni" style="font-size:12px">No IR assignments match the current filters for this day.</div>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:14px">';
    if((view==='both'||view==='call') && calls.length){
      html += '<div><div style="font-weight:700;font-size:13px;margin-bottom:6px;color:var(--rs-ink-2);border-bottom:1px solid var(--bdr);padding-bottom:4px">📟 On Call</div>';
      calls.forEach(c => {
        const p = _physById(c.physId);
        const pn = p ? `${p.last}, ${p.first}` : `Phys#${c.physId}`;
        const cls = c.callType === 'weekend' ? 'tg' : 'tt';
        html += `<div style="margin-bottom:4px"><span class="tag ${cls}" style="font-size:10px;margin-right:6px">${escHtml(c.callType||'daily')}</span><span style="font-size:12px">${escHtml(pn)} <span style="color:var(--rs-ink-3);font-size:11px">· ${escHtml(c.irGroup||'')}${c.site ? ' · ' + escHtml(c.site) : ''}</span></span></div>`;
      });
      html += '</div>';
    }
    if((view==='both'||view==='shifts') && shifts.length){
      const groups = {};
      shifts.forEach(s => {
        const site = s.site || '—';
        if(!groups[site]) groups[site] = [];
        groups[site].push(s);
      });
      html += '<div><div style="font-weight:700;font-size:13px;margin-bottom:6px;color:var(--rs-ink-2);border-bottom:1px solid var(--bdr);padding-bottom:4px">🩺 IR Shifts</div>';
      Object.keys(groups).sort().forEach(site => {
        html += `<div style="margin-bottom:6px;font-size:12px"><span style="font-weight:600">${escHtml(site)}</span> ${groups[site].map(s => {
          const p = _physById(s.physId);
          const pn = p ? `${p.last}, ${p.first}` : `Phys#${s.physId}`;
          const cls = s.shift==='1st'?'tb':s.shift==='2nd'?'tg':s.shift==='3rd'?'ta':'tpk';
          const sub = s.sub ? `<span style="color:var(--rs-ink-3);font-size:11px"> · ${escHtml(s.sub)}</span>` : '';
          return `<span style="margin-left:10px"><span class="tag ${cls}" style="font-size:10px">${escHtml(s.shift||'')}</span> ${escHtml(pn)}${sub}</span>`;
        }).join('')}</div>`;
      });
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

function _renderIRCalWeekView(focusISO, matchCall, matchShift, view){
  const el = document.getElementById('irc-week-section');
  if(!el) return;
  const d = parseDateLocal(focusISO);
  const dow = d.getDay();
  const sunISO = addDays(focusISO, -dow);
  const today = fmtDate(new Date());
  const wkLabel = `${parseDateLocal(sunISO).toLocaleString('default',{month:'short',day:'numeric'})} – ${parseDateLocal(addDays(sunISO,6)).toLocaleString('default',{month:'short',day:'numeric',year:'numeric'})}`;
  let html = `<div class="card" style="margin-bottom:12px">
    <div class="card-title">Week of ${escHtml(wkLabel)}</div>
    <div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px">`;
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach((dn,i) => {
    const ds = addDays(sunISO, i);
    const dd = parseDateLocal(ds);
    const isToday = ds === today;
    const isWknd = i === 0 || i === 6;
    const calls = (S.irCalls || []).filter(c => {
      if(!matchCall(c)) return false;
      if(c.callType === 'daily') return c.date === ds;
      if(c.callType === 'weekend'){ const mon=addDays(c.date,3); return ds >= c.date && ds <= mon; }
      return false;
    });
    const shifts = (S.irShifts || []).filter(s => s.date === ds && matchShift(s));
    const items = [];
    if(view==='both'||view==='call') calls.slice(0,3).forEach(c => {
      const p = _physById(c.physId);
      items.push({txt: `📟 ${p?p.last:'?'}`, cls:'ewk'});
    });
    if(view==='both'||view==='shifts') shifts.slice(0,4).forEach(s => {
      const p = _physById(s.physId);
      const cls = s.shift==='Home'?'ehome':s.shift==='1st'?'eir':s.shift==='2nd'?'e2':'e3';
      items.push({txt: `${s.shift==='Home'?'🏠':s.shift} ${p?p.last:'?'}`, cls});
    });
    const totalShown = items.length;
    const totalAll = (view!=='shifts'?calls.length:0) + (view!=='call'?shifts.length:0);
    html += `<div class="cal-day${isToday?' today':''}${isWknd?' wknd':''}" style="min-height:96px;padding:6px;cursor:pointer" onclick="ircSetFocus('${ds}'); ircSetView('day')">
      <div style="font-size:10px;color:var(--rs-ink-3);text-transform:uppercase;letter-spacing:.04em">${dn}</div>
      <div style="font-size:18px;font-weight:700;line-height:1">${dd.getDate()}</div>
      <div style="margin-top:4px;display:flex;flex-direction:column;gap:2px">
        ${items.map(it => `<div class="ev ${it.cls}" style="font-size:9px;padding:2px 4px;font-weight:600">${escHtml(it.txt)}</div>`).join('') || '<div style="font-size:9px;color:var(--rs-ink-3);font-style:italic;margin-top:6px">—</div>'}
        ${totalAll > totalShown ? `<div style="font-size:9px;color:var(--rs-ink-3)">+${totalAll-totalShown} more</div>` : ''}
      </div>
    </div>`;
  });
  html += `</div>
    <div class="note ni" style="font-size:10.5px;margin-top:8px">Click any day to drill in to Day view.</div>
  </div>`;
  el.innerHTML = html;
}

function _renderIRCalListView(focusISO, matchCall, matchShift, view){
  const el = document.getElementById('irc-list-section');
  if(!el) return;
  // Scope to focus week (Sun → Sat) so list never balloons.
  const d = parseDateLocal(focusISO);
  const dow = d.getDay();
  const sunISO = addDays(focusISO, -dow);
  const satISO = addDays(sunISO, 6);
  const wkLabel = `${parseDateLocal(sunISO).toLocaleString('default',{month:'short',day:'numeric'})} – ${parseDateLocal(satISO).toLocaleString('default',{month:'short',day:'numeric',year:'numeric'})}`;
  const rows = [];
  if(view==='both'||view==='shifts'){
    (S.irShifts || []).forEach(s => {
      if(s.date && s.date >= sunISO && s.date <= satISO && matchShift(s)){
        rows.push({ kind:'IR shift', date:s.date, shift:s.shift||'', physId:s.physId, site:s.site||'', sub:s.sub||'', slot:s.slotLabel||'', notes:s.notes||'', sortKey:s.date+'A' });
      }
    });
  }
  if(view==='both'||view==='call'){
    (S.irCalls || []).forEach(c => {
      // Daily calls include only c.date itself; weekend calls span Fri→Mon
      // (c.date through +3). Filter to whether ANY day in the week is
      // covered by the call.
      if(!matchCall(c)) return;
      let touches = false;
      if(c.callType === 'daily'){
        if(c.date >= sunISO && c.date <= satISO) touches = true;
      } else if(c.callType === 'weekend'){
        const cEnd = addDays(c.date, 3);
        if(!(cEnd < sunISO || c.date > satISO)) touches = true;
      } else if(c.date >= sunISO && c.date <= satISO) touches = true;
      if(!touches) return;
      rows.push({ kind:`IR ${c.callType||'daily'} call`, date:c.date, shift:'', physId:c.physId, site:c.site||'', sub:c.irGroup||'', slot:'', notes:c.notes||'', sortKey:c.date+'B' });
    });
  }
  rows.sort((a,b) => a.sortKey.localeCompare(b.sortKey));
  if(!rows.length){
    el.innerHTML = `<div class="card"><div class="card-title">IR Assignments — Week of ${escHtml(wkLabel)}</div><div class="note ni">No IR assignments match the current filters for this week. Step ‹ › to browse other weeks.</div></div>`;
    return;
  }
  let html = `<div class="card"><div class="card-title">IR Assignments — Week of ${escHtml(wkLabel)} <span style="font-weight:400;color:var(--rs-ink-3);font-size:11px">· ${rows.length} row${rows.length===1?'':'s'}</span></div><div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Day</th><th>Kind</th><th>Shift</th><th>Physician</th><th>Hospital</th><th>Group/Sub</th><th>Slot</th><th>Notes</th></tr></thead><tbody>`;
  rows.forEach(r => {
    const p = _physById(r.physId);
    const pn = p ? `${p.last}, ${p.first}` : `Phys#${r.physId}`;
    const dowName = parseDateLocal(r.date).toLocaleString('default', {weekday:'short'});
    const cls = r.shift==='1st'?'tb':r.shift==='2nd'?'tg':r.shift==='3rd'?'ta':r.kind.includes('call')?'tt':'tpk';
    html += `<tr><td>${escHtml(r.date)}</td><td>${escHtml(dowName)}</td><td>${escHtml(r.kind)}</td><td>${r.shift?'<span class="tag '+cls+'">'+escHtml(r.shift)+'</span>':''}</td><td>${escHtml(pn)}</td><td>${escHtml(r.site)}</td><td>${escHtml(r.sub)}</td><td>${escHtml(r.slot)}</td><td style="color:var(--txt2);font-size:11px">${escHtml(r.notes)}</td></tr>`;
  });
  html += '</tbody></table></div></div>';
  el.innerHTML = html;
}

// ── IR calendar — view + focus controls ──────────────────────────
function ircSetView(v){
  if(!['day','week','month','list'].includes(v)) v = 'month';
  try{ localStorage.setItem('rs.irc.view', v); }catch(_){}
  if(typeof renderIRCal === 'function') renderIRCal();
}
function ircSetFocus(iso){
  if(!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
  try{ localStorage.setItem('rs.irc.focusDate', iso); }catch(_){}
  const moEl = document.getElementById('irc-mo');
  if(moEl) moEl.value = iso.slice(0, 7);
  if(typeof renderIRCal === 'function') renderIRCal();
}
function ircStepFocus(step){
  const view = (function(){ try{ return localStorage.getItem('rs.irc.view') || 'month'; }catch(_){ return 'month'; } })();
  if(step === 0){ ircSetFocus(fmtDate(new Date())); return; }
  const cur = (function(){ let v=''; try{v=localStorage.getItem('rs.irc.focusDate')||''}catch(_){} return v || fmtDate(new Date()); })();
  let next = cur;
  if(view === 'day')        next = addDays(cur, step);
  else if(view === 'week')  next = addDays(cur, 7 * step);
  else if(view === 'list')  next = addDays(cur, 7 * step);   // list is week-scoped → step by week
  else { const d = parseDateLocal(cur); d.setMonth(d.getMonth() + step); next = fmtDate(d); }
  ircSetFocus(next);
}
