function renderFTE(){
  const mo=document.getElementById('fte-mo');
  if(!mo) return;
  if(!mo.value){const now=new Date();mo.value=fmtDate(new Date(now.getFullYear(),now.getMonth(),1)).slice(0,7);}
  const ym=mo.value;
  const [y,m]=ym.split('-').map(Number);
  const monthLabel=new Date(y,m-1,1).toLocaleString('default',{month:'long',year:'numeric'});
  const wdDays=buildCal(ym).filter(c=>c.day&&!c.isWknd&&!isHolidayBlackout(c.date)).length;
  const wkWknd=buildCal(ym).filter(c=>c.day&&c.dow===6).length;

  let html=`<div style="font-size:11px;color:var(--txt3);margin-bottom:10px">Showing ${monthLabel} · ${wdDays} weekdays · ${wkWknd} weekends</div>`;

  // ── DR physicians ──
  const drPs=S.physicians.filter(p=>p.drFte>0&&p.role!=='IR');
  if(drPs.length){
    html+=`<div class="card" style="margin-bottom:12px"><div class="card-title">Diagnostic Radiology — FTE Utilization</div>
      <div style="overflow-x:auto"><table><thead><tr>
        <th>Physician</th><th>DR FTE</th>
        <th>Weekday Shifts</th><th>Target</th><th>Utilization</th>
        <th>Weekend Calls</th><th>Target</th><th>Utilization</th>
        <th>Anchor %</th><th>Status</th>
      </tr></thead><tbody>`;
    drPs.forEach(p=>{
      const wdUsed=drCnt(p.id,ym);
      const wdMax=maxDR(p,'wd');
      const wkUsed=wkCnt(p.id,ym);
      const wkMax=maxDR(p,'wk');
      const wdPct=wdMax?Math.round(wdUsed/wdMax*100):0;
      const wkPct=wkMax?Math.round(wkUsed/wkMax*100):0;
      const anc=ancComp(p.id,ym);
      const ancTxt=anc&&!anc.noData?anc.pct+'%':'—';
      const ancCls=anc&&!anc.noData?(anc.ok?'color:var(--green-t)':'color:var(--red-t)'):'color:var(--txt3)';
      const wdCls=wdPct>105?'color:var(--red-t)':wdPct>=90?'color:var(--green-t)':wdPct>=60?'color:var(--amber,#d97706)':'color:var(--txt3)';
      const wkCls=wkPct>105?'color:var(--red-t)':wkPct>=90?'color:var(--green-t)':wkPct>=60?'color:var(--amber,#d97706)':'color:var(--txt3)';
      const overAll=wdPct>110||wkPct>110?'⚠ Over':'';
      const underAll=wdPct<50&&wkPct<50?'Under-utilized':'';
      const statusCls=overAll?'color:var(--red-t)':underAll?'color:var(--amber,#d97706)':'color:var(--green-t)';
      const statusTxt=overAll||underAll||(wdPct>=80?'✓ On track':'Low');
      html+=`<tr>
        <td style="font-weight:600">${pnameHtml(p.id)}</td>
        <td style="text-align:center">${p.drFte}</td>
        <td style="text-align:center">${wdUsed}</td>
        <td style="text-align:center;color:var(--txt3)">${wdMax}</td>
        <td style="text-align:center"><span style="${wdCls};font-weight:700">${wdPct}%</span></td>
        <td style="text-align:center">${wkUsed}</td>
        <td style="text-align:center;color:var(--txt3)">${wkMax}</td>
        <td style="text-align:center"><span style="${wkCls};font-weight:700">${wkPct}%</span></td>
        <td style="text-align:center;${ancCls};font-weight:700">${ancTxt}</td>
        <td style="${statusCls};font-weight:700">${statusTxt}</td>
      </tr>`;
    });
    html+=`</tbody></table></div></div>`;
  }

  // ── IR physicians ──
  const irPs=S.physicians.filter(p=>p.irFte>0);
  if(irPs.length){
    html+=`<div class="card"><div class="card-title">Interventional Radiology — FTE Utilization
      <span style="font-size:11px;font-weight:400;color:var(--txt3);margin-left:8px">Targets = finite slots in month ÷ group FTE × physician FTE</span>
    </div>
      <div style="overflow-x:auto"><table><thead><tr>
        <th>Physician</th><th>IR FTE</th><th>Group</th>
        <th>Daily Calls</th><th>Daily Target</th><th>Daily Util%</th>
        <th>Weekend Calls</th><th>Wknd Target</th><th>Wknd Util%</th>
        <th>Proc Shifts</th><th>Shift Target</th><th>Shift Util%</th>
        <th>Status</th>
      </tr></thead><tbody>`;
    irPs.forEach(p=>{
      const dailyCalls=irDailyCnt(p.id,ym);
      const wkndCalls=irWkndCnt(p.id,ym);
      const procShifts=irProcShiftCnt(p.id,ym);
      const dailyTgt=irDailyTargetMonth(p,ym);
      const wkndTgt=irWkndTargetMonth(p,ym);
      const shiftTgt=irShiftTargetMonth(p,ym);
      const dailyPct=dailyTgt>0?Math.round(dailyCalls/dailyTgt*100):0;
      const wkndPct=wkndTgt>0?Math.round(wkndCalls/wkndTgt*100):0;
      const shiftPct=shiftTgt>0?Math.round(procShifts/shiftTgt*100):0;
      const dCls=dailyPct>110?'color:var(--red-t)':dailyPct>=90?'color:var(--green-t)':dailyPct>=60?'color:var(--amber,#d97706)':'color:var(--txt3)';
      const wCls=wkndPct>110?'color:var(--red-t)':wkndPct>=90?'color:var(--green-t)':wkndPct>=60?'color:var(--amber,#d97706)':'color:var(--txt3)';
      const sCls=shiftPct>110?'color:var(--red-t)':shiftPct>=90?'color:var(--green-t)':shiftPct>=60?'color:var(--amber,#d97706)':shiftTgt>0?'color:var(--txt3)':'color:var(--txt3)';
      const over=dailyPct>115||wkndPct>115||shiftPct>115;
      const statusTxt=over?'⚠ Over':(dailyPct>=80&&wkndPct>=80&&(shiftTgt===0||shiftPct>=80))?'✓ On track':'Low';
      const statusCls=over?'color:var(--red-t)':(dailyPct>=80&&wkndPct>=80&&(shiftTgt===0||shiftPct>=80))?'color:var(--green-t)':'color:var(--amber,#d97706)';
      html+=`<tr>
        <td style="font-weight:600">${pnameHtml(p.id)}</td>
        <td style="text-align:center">${p.irFte}</td>
        <td><span class="tag ${irGroupColorClass(p.irGroup)}">${p.irGroup||'—'}</span></td>
        <td style="text-align:center;font-weight:700">${dailyCalls}</td>
        <td style="text-align:center;color:var(--txt3)">${dailyTgt.toFixed(1)}</td>
        <td style="text-align:center"><span style="${dCls};font-weight:700">${dailyPct}%</span></td>
        <td style="text-align:center;font-weight:700">${wkndCalls}</td>
        <td style="text-align:center;color:var(--txt3)">${wkndTgt.toFixed(1)}</td>
        <td style="text-align:center"><span style="${wCls};font-weight:700">${wkndPct}%</span></td>
        <td style="text-align:center;font-weight:700">${procShifts}</td>
        <td style="text-align:center;color:var(--txt3)">${shiftTgt>0?shiftTgt.toFixed(1):'—'}</td>
        <td style="text-align:center">${shiftTgt>0?`<span style="${sCls};font-weight:700">${shiftPct}%</span>`:'—'}</td>
        <td style="${statusCls};font-weight:700">${statusTxt}</td>
      </tr>`;
    });
    html+=`</tbody></table></div></div>`;
  }

  const el=document.getElementById('fte-content');
  if(el) el.innerHTML=html||'<div class="note ni">No physicians configured.</div>';
}
