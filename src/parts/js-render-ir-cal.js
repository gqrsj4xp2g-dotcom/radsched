/* ─── IR CALENDAR ─── */
function renderIRCal(){
  const ym=document.getElementById('irc-mo').value||new Date().toISOString().slice(0,7);
  const fg=document.getElementById('irc-grp')?.value||'';
  const fpid=+document.getElementById('irc-phys')?.value||0;
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
      S.irCalls.filter(ic=>(!fg||ic.irGroup===fg)&&(!fpid||ic.physId===fpid)).forEach(ic=>{
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
      _shiftsOnDate('ir', c.date).filter(s=>(!fg||s.irGroup===fg)&&(!fpid||s.physId===fpid)).forEach(s=>{
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
