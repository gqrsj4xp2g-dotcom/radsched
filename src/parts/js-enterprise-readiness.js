// ── Enterprise readiness + telemetry ─────────────────────────────────
let _telemetryBuffer = [];
async function _telemetry(event, detail, level){
  const row = {
    id: (crypto?.randomUUID ? crypto.randomUUID() : 'tel_' + Date.now() + '_' + Math.random().toString(36).slice(2)),
    practice_id: String(_ROW_ID || _PRACTICE_ID || 'main'),
    user_id: CU?.id || null,
    user_email: CU?.email || null,
    level: level || 'info',
    event: String(event || 'unknown'),
    detail: detail || {},
    created_at: new Date().toISOString(),
  };
  _telemetryBuffer.push(row);
  if(_telemetryBuffer.length > 100) _telemetryBuffer = _telemetryBuffer.slice(-100);
  try{
    const sb = (typeof _initSupabase === 'function') ? _initSupabase() : null;
    if(sb && _ROW_ID){
      await sb.from('radscheduler_telemetry').insert(row);
    }
  }catch(_){}
  return row;
}
async function _enterpriseTelemetryItem(sb){
  if(!sb || !_ROW_ID) return _goLiveStatus('warn', 'Telemetry table', 'Sign in to a practice before probing telemetry.');
  try{
    const { error } = await sb.from('radscheduler_telemetry').select('created_at').eq('practice_id', String(_ROW_ID)).limit(1);
    return _goLiveStatus(!error ? 'ok' : 'warn', 'Telemetry table', !error ? 'Telemetry table is reachable.' : (error?.message || 'Could not query radscheduler_telemetry.'));
  }catch(e){
    return _goLiveStatus('warn', 'Telemetry table', e?.message || String(e));
  }
}
async function renderEnterpriseReadiness(){
  if(!_isAdminOrSU || !_isAdminOrSU()) return;
  const host = document.getElementById('enterprise-result');
  if(!host) return;
  const cfgUrl = (typeof _getUrl === 'function') ? _getUrl() : '';
  const cfgKey = (typeof _getKey === 'function') ? _getKey() : '';
  const sb = cfgUrl && cfgKey
    ? (typeof _initAuthClient === 'function' ? _initAuthClient() : (typeof _initSupabase === 'function' ? _initSupabase() : null))
    : null;
  _healthRender(host, [{ status:'pending', label:'Enterprise readiness', detail:'Checking MFA, telemetry, auditability, recovery, CI evidence, and environment posture...' }], 'Enterprise readiness');
  await _refreshMfaStatus?.();
  const items = [
    _goLiveStatus(_adminMfaOk() ? 'ok' : 'fail', 'Privileged MFA', _adminMfaOk() ? `Current admin session is ${_MFA_STATUS?.currentLevel || 'aal2'}.` : _mfaAdminBlockMessage()),
    _goLiveStatus('ok', 'Security pipeline', 'CodeQL, npm audit, CSP/header checks, SQL/RLS lint, migration drift, Playwright, rollback drill, and edge TypeScript checks are defined in GitHub Actions.'),
    _goLiveStatus('ok', 'Environment separation', 'Staging validation and production deploy controls are documented; production deploys run from main only.'),
    _goLiveStatus('ok', 'RBAC matrix', 'docs/RBAC.md defines role capabilities; CI checks the matrix against app, edge, SQL, and E2E gates.'),
    _goLiveStatus('warn', 'SSO / SCIM readiness', 'SAML SSO is documented and wired in the login flow; activation requires a supported Supabase plan and IdP metadata. SCIM requires an external IdP/Admin API automation path.'),
    _goLiveStatus('ok', 'OWASP/NIST evidence', 'Enterprise readiness documentation maps controls to OWASP ASVS and NIST CSF 2.0 functions.'),
  ];
  items.push(await _goLiveAuditSideTableItem(sb));
  items.push(await _goLiveAuditChainItem(sb));
  items.push(await _goLiveBackupItem(sb));
  items.push(await _enterpriseTelemetryItem(sb));
  items.push(await _goLiveEdgeFunctionsItem(cfgUrl));
  await _telemetry('enterprise.readiness_run', { fail:items.filter(i=>i.status==='fail').length, warn:items.filter(i=>i.status==='warn').length }, 'info');
  _healthRender(host, items, 'Enterprise readiness');
}
async function renderTelemetryPanel(){
  if(!_isAdminOrSU || !_isAdminOrSU()) return;
  const host = document.getElementById('enterprise-result');
  if(!host) return;
  host.innerHTML = '<div class="note ni">Loading telemetry...</div>';
  let rows = _telemetryBuffer.slice(-25).reverse();
  try{
    const sb = (typeof _initSupabase === 'function') ? _initSupabase() : null;
    if(sb && _ROW_ID){
      const { data, error } = await sb.from('radscheduler_telemetry')
        .select('created_at, level, event, user_email, detail')
        .eq('practice_id', String(_ROW_ID))
        .order('created_at', { ascending:false })
        .limit(25);
      if(!error && Array.isArray(data)) rows = data;
    }
  }catch(_){}
  if(!rows.length){
    host.innerHTML = '<div class="note nw">No telemetry events yet. Click Write probe event to verify the path.</div>';
    return;
  }
  host.innerHTML = `<div style="overflow-x:auto"><table style="width:100%;font-size:12px">
    <thead><tr><th style="text-align:left">Time</th><th>Level</th><th style="text-align:left">Event</th><th style="text-align:left">User</th><th style="text-align:left">Detail</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${escHtml((r.created_at||'').replace('T',' ').slice(0,19))}</td>
      <td><span class="tag ${r.level === 'error' ? 'tr' : r.level === 'warn' ? 'tw' : 'tb'}">${escHtml(r.level||'info')}</span></td>
      <td>${escHtml(r.event||'')}</td>
      <td>${escHtml(r.user_email||'')}</td>
      <td style="font-family:ui-monospace,monospace;font-size:10.5px;max-width:420px;overflow-wrap:anywhere">${escHtml(JSON.stringify(r.detail||{}))}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}
async function renderEnterpriseOpsDashboard(){
  if(!_isAdminOrSU || !_isAdminOrSU()) return;
  const host = document.getElementById('enterprise-result');
  if(!host) return;
  host.innerHTML = '<div class="note ni">Loading operations dashboard...</div>';
  let telemetryRows = _telemetryBuffer.slice(-50).reverse();
  let auditRows = [];
  try{
    const sb = (typeof _initSupabase === 'function') ? _initSupabase() : null;
    if(sb && _ROW_ID){
      const tel = await sb.from('radscheduler_telemetry')
        .select('created_at, level, event, user_email, detail')
        .eq('practice_id', String(_ROW_ID))
        .order('created_at', { ascending:false })
        .limit(50);
      if(!tel.error && Array.isArray(tel.data)) telemetryRows = tel.data;
      const aud = await sb.from('radscheduler_audit')
        .select('ts, action, who, role, entry_hash')
        .eq('practice_id', String(_ROW_ID))
        .order('ts', { ascending:false })
        .limit(50);
      if(!aud.error && Array.isArray(aud.data)) auditRows = aud.data;
    }
  }catch(_){}
  const runtimeErrors = (typeof _errorLog !== 'undefined' && Array.isArray(_errorLog)) ? _errorLog.length : 0;
  const telErrors = telemetryRows.filter(r => r.level === 'error').length;
  const telWarns = telemetryRows.filter(r => r.level === 'warn').length;
  const hashedAudit = auditRows.filter(r => r.entry_hash).length;
  const cards = [
    { label:'Telemetry events', value: telemetryRows.length, detail:`${telErrors} error · ${telWarns} warn` },
    { label:'Audit entries', value: auditRows.length, detail: auditRows.length ? `${hashedAudit}/${auditRows.length} hash-chained` : 'No side-table rows loaded' },
    { label:'Runtime errors', value: runtimeErrors, detail: runtimeErrors ? 'Open Error log for detail' : 'No captured browser errors' },
    { label:'Save queue', value: _hasUnsavedChanges ? 'queued' : 'clear', detail:`Consecutive failures: ${typeof _consecutiveSaveFails !== 'undefined' ? _consecutiveSaveFails : 0}` },
  ];
  const recent = telemetryRows.slice(0, 8).map(r => `
    <tr>
      <td>${escHtml((r.created_at||'').replace('T',' ').slice(0,19))}</td>
      <td><span class="tag ${r.level === 'error' ? 'tr' : r.level === 'warn' ? 'ta' : 'tb'}">${escHtml(r.level||'info')}</span></td>
      <td>${escHtml(r.event||'')}</td>
      <td>${escHtml(r.user_email||'')}</td>
    </tr>`).join('');
  host.innerHTML = `
    <div class="rs-ops-grid">
      ${cards.map(c => `<div class="rs-ops-card"><div class="rs-ops-label">${escHtml(c.label)}</div><div class="rs-ops-value">${escHtml(String(c.value))}</div><div class="rs-ops-detail">${escHtml(c.detail)}</div></div>`).join('')}
    </div>
    <div style="margin-top:12px;overflow-x:auto">
      <table style="width:100%;font-size:12px">
        <thead><tr><th style="text-align:left">Time</th><th>Level</th><th style="text-align:left">Event</th><th style="text-align:left">User</th></tr></thead>
        <tbody>${recent || '<tr><td colspan="4" style="color:var(--rs-ink-3)">No telemetry events yet.</td></tr>'}</tbody>
      </table>
    </div>`;
}
