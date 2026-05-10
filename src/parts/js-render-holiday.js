/* ─── HOLIDAY COUNTER — MULTI-YEAR EQUITY ─── */

function renderHolCounter(){
  // Populate year dropdown dynamically — include all years with assignments,
  // all years with holiday definitions, and a few future years for planning.
  const yrEl=document.getElementById('hcy');
  if(yrEl){
    const curSel=yrEl.value;
    const defYears=(S.holidayDefs||[]).map(d=>d.year).filter(Boolean);
    const holYears=(S.holidays||[]).map(h=>h.year).filter(Boolean);
    const curYr=new Date().getFullYear();
    const allYrs=[...new Set([...defYears, ...holYears, curYr-1, curYr, curYr+1, curYr+2])]
      .filter(Boolean).sort((a,b)=>b-a); // newest first
    const expectedHTML='<option value="all">All Years (Career)</option>'+
      allYrs.map(y=>`<option value="${y}">${y}</option>`).join('');
    if(yrEl.innerHTML.replace(/\s/g,'') !== expectedHTML.replace(/\s/g,'')){
      yrEl.innerHTML=expectedHTML;
      // Restore prior selection if still valid
      if(curSel && [...yrEl.options].some(o=>o.value===curSel)) yrEl.value=curSel;
    }
  }
  const grp = document.getElementById('hcg')?.value || 'ALL';
  const yr  = document.getElementById('hcy')?.value || 'all';

  // All years present in data
  const allYears = [...new Set(S.holidays.map(h => h.year))].filter(Boolean).sort();
  const filtered = S.holidays.filter(h =>
    (grp === 'ALL' || h.group === grp) && (yr === 'all' || h.year === +yr));

  if(!filtered.length){
    document.getElementById('hol-counter').innerHTML =
      '<p style="color:var(--txt3);font-size:12px">No holiday call assignments yet.</p>';
    return;
  }

  // Physician pool by filter
  const physicians = S.physicians.filter(p => {
    if(grp === 'ALL')       return p.drFte > 0 || p.irFte > 0;
    if(grp === 'DR')        return p.drFte > 0 && p.role !== 'IR';
    // Generic IR-<groupName> match — e.g. "IR-North", "IR-Pediatric", etc.
    // Replaces the old hardcoded 'IR-North' / 'IR-South' conditions so any
    // admin-added IR group works here without code changes.
    const m = /^IR-(.+)$/.exec(grp);
    if(m) return p.irFte > 0 && p.irGroup === m[1];
    return false;
  });

  // Build data: physId → {total, byYear:{yr:N}, byHol:{name:N}, byGroup:{DR:N,'IR-X':N,...}}
  // Dynamically seed byGroup buckets for every known IR group so any admin-
  // added group (e.g. 'IR-East') gets counted without code changes.
  const _emptyByGroup = () => {
    const b = {DR:0, IR:0};
    getIRGroups().forEach(g => { b['IR-'+g] = 0; });
    return b;
  };
  const data = {};
  physicians.forEach(p => {
    data[p.id] = {total:0, byYear:{}, byHol:{}, byGroup:_emptyByGroup()};
  });
  // Deduplicate to blocks: name+year+group+physId = 1 assignment regardless of dates
  const seen=new Set();
  filtered.forEach(h => {
    const key=`${h.physId}|${h.name}|${h.year}|${h.group}`;
    if(seen.has(key)) return;
    seen.add(key);
    if(!data[h.physId]) data[h.physId] = {total:0, byYear:{}, byHol:{}, byGroup:_emptyByGroup()};
    const d = data[h.physId];
    d.total++;
    d.byYear[h.year] = (d.byYear[h.year]||0) + 1;
    d.byHol[h.name]  = (d.byHol[h.name]||0) + 1;
    // Unknown group? Init lazily so legacy data with unexpected group values doesn't crash
    if(d.byGroup[h.group] === undefined) d.byGroup[h.group] = 0;
    d.byGroup[h.group] = (d.byGroup[h.group]||0) + 1;
  });

  const sorted = Object.entries(data)
    .filter(([,v]) => v.total > 0)
    .sort((a,b) => b[1].total - a[1].total);

  const showYears = yr === 'all' && allYears.length > 1;
  const avgTotal  = sorted.length ? (sorted.reduce((s,[,v]) => s+v.total,0) / sorted.length).toFixed(1) : 0;
  const maxTotal  = sorted.length ? Math.max(...sorted.map(([,v]) => v.total)) : 0;
  const minTotal  = sorted.length ? Math.min(...sorted.map(([,v]) => v.total)) : 0;

  // Career fair-share balance per physician — cumulative actual vs FTE-weighted
  // fair share across all visible years. Positive = ahead of fair share,
  // negative = owed. Used to color-code long-run imbalance.
  const isCareer = yr === 'all';
  const fairByPhys = {};
  if(isCareer){
    // For each group and each year, compute total slots and per-physician fair share
    physicians.forEach(p=>{ fairByPhys[p.id]={actTot:0, fairTot:0, bal:0}; });
    const groupsToConsider = grp==='ALL'
      ? ['DR', ...getIRGroups().map(g => 'IR-'+g)]
      : [grp];
    groupsToConsider.forEach(g=>{
      const poolPhys = physicians.filter(p=>{
        if(g==='DR') return p.drFte>0 && p.role!=='IR';
        // Generic IR-<groupName> filter
        const mm = /^IR-(.+)$/.exec(g);
        if(mm) return p.irFte>0 && p.irGroup===mm[1];
        return false;
      });
      const gFteTot = poolPhys.reduce((s,p)=>s+(g==='DR'?p.drFte:p.irFte), 0) || 1;
      allYears.forEach(year=>{
        // Total slots for this group in this year = distinct (defName+physId) from S.holidays for that group/year
        const slotsThisYear = new Set(
          S.holidays.filter(h=>h.group===g && h.year===year).map(h=>`${h.name}|${h.physId}`)
        ).size;
        if(!slotsThisYear) return;
        poolPhys.forEach(p=>{
          const myFte = g==='DR' ? p.drFte : p.irFte;
          const fairShare = slotsThisYear * (myFte / gFteTot);
          const actual = (new Set(
            S.holidays.filter(h=>h.group===g && h.year===year && h.physId===p.id).map(h=>h.name)
          )).size;
          if(fairByPhys[p.id]){
            fairByPhys[p.id].actTot += actual;
            fairByPhys[p.id].fairTot += fairShare;
            fairByPhys[p.id].bal += (actual - fairShare);
          }
        });
      });
    });
  }

  let html = `<div class="g3" style="margin-bottom:12px">
    <div class="met"><div class="met-lbl">Total Assignments</div>
      <div class="met-val">${filtered.length}</div></div>
    <div class="met"><div class="met-lbl">Avg per Physician</div>
      <div class="met-val">${avgTotal}</div></div>
    <div class="met"><div class="met-lbl">Range (min–max)</div>
      <div class="met-val" style="font-size:16px">${minTotal}–${maxTotal}</div></div>
  </div>`;

  html += `<div style="overflow-x:auto"><table><thead><tr>
    <th>Physician</th>
    ${grp === 'ALL' ? '<th>DR</th><th>IR N</th><th>IR S</th>' : ''}
    ${showYears ? allYears.map(y => `<th style="text-align:center">${y}</th>`).join('') : ''}
    <th style="text-align:center;border-left:2px solid var(--bdr)">Total</th>
    ${isCareer ? '<th style="text-align:center" title="Actual minus FTE-weighted fair share across all visible years. Negative = owed more holidays, positive = ahead of fair share.">Balance</th>' : ''}
    <th style="min-width:200px">Holiday Breakdown</th>
  </tr></thead><tbody>`;

  sorted.forEach(([id, v]) => {
    const p = S.physicians.find(x => x.id === +id);
    const barW = maxTotal > 0 ? Math.round(v.total / maxTotal * 100) : 0;
    const barCol = v.total > avgTotal * 1.2 ? 'var(--amber,#d97706)' :
                   v.total < avgTotal * 0.8 ? 'var(--blue-t)' : 'var(--green-t)';
    const breakdown = Object.entries(v.byHol)
      .sort((a,b) => b[1]-a[1])
      .map(([n,c]) => `<span class="tag ta" style="font-size:9px">${n.split(' ')[0]}×${c}</span>`)
      .join(' ');

    // Combine legacy 'IR' into the matching IR group's cell — legacy entries
    // where physician's irGroup is set become part of that group's count.
    const legacyIR = v.byGroup['IR']||0;
    const irGroups = getIRGroups();
    // Per-group cell values: base count + legacy-IR if physician's group matches
    const perGroupCells = {};
    irGroups.forEach(g => {
      perGroupCells[g] = (v.byGroup['IR-'+g]||0) + ((p && p.irGroup===g) ? legacyIR : 0);
    });
    const cellDR = v.byGroup['DR']||0;

    // Career balance cell
    let balCell='';
    if(isCareer){
      const b = fairByPhys[+id]?.bal || 0;
      const balTxt = (b>0?'+':'')+b.toFixed(1);
      const balCol = b > 1.5 ? 'var(--amber,#d97706)' : b < -1.5 ? 'var(--blue-t)' : 'var(--green-t)';
      const fair = (fairByPhys[+id]?.fairTot || 0).toFixed(1);
      balCell = `<td style="text-align:center;font-weight:700;color:${balCol}" title="Fair share: ${fair}">${balTxt}</td>`;
    }

    // When grp==='ALL' show DR + one column per IR group (dynamic)
    const allCells = grp === 'ALL'
      ? `<td style="text-align:center">${cellDR}</td>` + irGroups.map(g => `<td style="text-align:center">${perGroupCells[g]}</td>`).join('')
      : '';

    html += `<tr>
      <td style="font-weight:600">${p ? pname(+id) : '?'}</td>
      ${allCells}
      ${showYears ? allYears.map(y => `<td style="text-align:center;color:var(--txt3)">${v.byYear[y]||'—'}</td>`).join('') : ''}
      <td style="text-align:center;font-weight:800;border-left:2px solid var(--bdr);font-size:16px">${v.total}</td>
      ${balCell}
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="flex:1;height:6px;background:var(--bg3);border-radius:3px;min-width:60px">
            <div style="width:${barW}%;height:100%;background:${barCol};border-radius:3px"></div>
          </div>
          <div style="flex-shrink:0">${breakdown}</div>
        </div>
      </td>
    </tr>`;
  });

  const zeroes = physicians.filter(p => !(data[p.id]?.total > 0));
  if(zeroes.length){
    const irGroups = getIRGroups();
    zeroes.forEach(p => {
      let zBal='';
      if(isCareer){
        const b = fairByPhys[p.id]?.bal || 0;
        const fair = (fairByPhys[p.id]?.fairTot || 0).toFixed(1);
        const balTxt = (b>0?'+':'')+b.toFixed(1);
        const balCol = b < -1.5 ? 'var(--blue-t)' : 'var(--txt3)';
        zBal = `<td style="text-align:center;font-weight:700;color:${balCol}" title="Fair share: ${fair}">${fair==='0.0'?'—':balTxt}</td>`;
      }
      const allDashes = grp === 'ALL'
        ? ('<td style="text-align:center">—</td>' + irGroups.map(() => '<td style="text-align:center">—</td>').join(''))
        : '';
      html += `<tr style="opacity:.5">
        <td style="font-weight:600">${pnameHtml(p.id)}</td>
        ${allDashes}
        ${showYears ? allYears.map(() => '<td>—</td>').join('') : ''}
        <td style="text-align:center;font-weight:800;border-left:2px solid var(--bdr);color:var(--txt3)">0</td>
        ${zBal}
        <td style="color:var(--txt3);font-size:11px">No assignments</td>
      </tr>`;
    });
  }

  html += `</tbody></table></div>`;

  if(showYears){
    html += `<div style="font-size:10px;color:var(--txt3);margin-top:8px">
      🟡 Above average &nbsp; 🔵 Below average &nbsp; 🟢 Near average
    </div>`;
  }

  document.getElementById('hol-counter').innerHTML = html;
}

/* ─── HOLIDAY SCHEDULE VIEW ───────────────────────────────────────────────
   Referenced by the Holidays page "Schedule" tab and by the year selector
   (#holsched-yr). Renders a chronological read-only view of all holiday
   assignments for the selected year, grouped by holiday name/date with
   per-pool (DR + one column per IR group) chips. Kept intentionally simple
   — it's a viewing surface, not a management one (edits happen on the
   Assignments tab).
*/
function renderHolSchedule(){
  const yrEl = document.getElementById('holsched-yr');
  const wrap = document.getElementById('hol-schedule-content');
  if(!wrap) return;
  // Populate year dropdown from the data present.
  if(yrEl){
    const curSel = yrEl.value;
    const defYears = (S.holidayDefs||[]).map(d=>d.year).filter(Boolean);
    const holYears = (S.holidays||[]).map(h=>h.year).filter(Boolean);
    const curYr = new Date().getFullYear();
    const allYrs = [...new Set([...defYears, ...holYears, curYr-1, curYr, curYr+1, curYr+2])]
      .filter(Boolean).sort((a,b)=>b-a);
    const expectedHTML = allYrs.map(y=>`<option value="${y}">${y}</option>`).join('');
    if(yrEl.innerHTML.replace(/\s/g,'') !== expectedHTML.replace(/\s/g,'')){
      yrEl.innerHTML = expectedHTML;
      if(curSel && [...yrEl.options].some(o=>o.value===curSel)) yrEl.value = curSel;
      else yrEl.value = String(curYr);
    }
  }
  const yr = +(yrEl?.value) || new Date().getFullYear();
  const escHtml = (s)=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // Join holiday assignments to definitions by (name, year) so we can list
  // even holidays that have zero assignments (helps spot coverage gaps).
  const defs = (S.holidayDefs||[]).filter(d => d.year === yr);
  const assignsByKey = {}; // key: `${name}|${date}|${group}`
  (S.holidays||[]).filter(h => h.year === yr).forEach(h => {
    const k = `${h.name}|${h.date}|${h.group}`;
    (assignsByKey[k] = assignsByKey[k] || []).push(h);
  });

  if(!defs.length && Object.keys(assignsByKey).length === 0){
    wrap.innerHTML = '<div class="note ni">No holidays defined or assigned for '+yr+'.</div>';
    return;
  }

  // Flatten to one row per (def, date) — holidays with multi-day dates (e.g.
  // Christmas Eve + Day) become separate rows so the schedule reads as a
  // chronological list.
  const rows = [];
  defs.forEach(def => {
    (def.dates||[]).forEach(dt => rows.push({def, date: dt}));
  });
  rows.sort((a,b) => a.date.localeCompare(b.date) || a.def.name.localeCompare(b.def.name));

  const physName = (id) => {
    const p = (S.physicians||[]).find(x=>x.id===id);
    return p ? `${p.last}, ${p.first}` : `#${id}`;
  };
  const pools = ['DR', ...getIRGroups().map(g => 'IR-'+g)];
  const poolLabel = (g) => g==='DR' ? 'DR' : 'IR '+g.slice(3);

  let html = '<div style="overflow-x:auto"><table><thead><tr>'+
    '<th>Date</th><th>Holiday</th>' +
    pools.map(p=>`<th>${escHtml(poolLabel(p))}</th>`).join('') +
    '</tr></thead><tbody>';

  rows.forEach(({def, date}) => {
    html += `<tr><td style="white-space:nowrap">${escHtml(date)}</td>`+
            `<td>${escHtml(def.name)}</td>`;
    pools.forEach(pool => {
      const list = (assignsByKey[`${def.name}|${date}|${pool}`] || [])
        .map(h => escHtml(physName(h.physId)));
      html += `<td>${list.length ? list.map(n=>`<span class="tag tb" style="font-size:10px;margin:1px">${n}</span>`).join('') : '<span style="color:var(--txt3)">—</span>'}</td>`;
    });
    html += '</tr>';
  });

  // Also surface any assignments whose (name,date) isn't in a current def —
  // typically orphans from a deleted def. Displayed below the main table.
  const defKeys = new Set();
  defs.forEach(d => (d.dates||[]).forEach(dt => defKeys.add(`${d.name}|${dt}`)));
  const orphanKeys = Object.keys(assignsByKey).filter(k => {
    const [n, dt] = k.split('|'); return !defKeys.has(`${n}|${dt}`);
  });
  html += '</tbody></table></div>';
  if(orphanKeys.length){
    html += '<div class="note nw" style="margin-top:10px;font-size:11px"><strong>Orphan assignments</strong> — these reference a holiday definition that no longer exists:';
    html += '<ul style="margin:6px 0 0 18px">';
    orphanKeys.sort().forEach(k => {
      const [n, dt, g] = k.split('|');
      const who = assignsByKey[k].map(h => escHtml(physName(h.physId))).join(', ');
      html += `<li>${escHtml(dt)} — ${escHtml(n)} [${escHtml(poolLabel(g))}]: ${who}</li>`;
    });
    html += '</ul></div>';
  }
  wrap.innerHTML = html;
}
