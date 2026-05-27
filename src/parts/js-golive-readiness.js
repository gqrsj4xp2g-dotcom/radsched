// ── Go-live readiness checklist ─────────────────────────────────────
// Launch-day checklist that combines browser-detectable readiness with
// the external operator actions that cannot be checked safely from a
// public client, such as Supabase password-breach protection.
function _goLiveStatus(status, label, detail){
  return { status, label, detail };
}
async function _goLiveAuditSideTableItem(sb){
  if(!sb || !_ROW_ID) return _goLiveStatus('warn', 'Audit side table', 'Sign in to a practice before checking audit side-table reachability.');
  try{
    const { error } = await sb.from('radscheduler_audit').select('ts').eq('practice_id', String(_ROW_ID)).limit(1);
    return _goLiveStatus(!error ? 'ok' : 'warn', 'Audit side table', !error ? 'Reachable for the active practice.' : (error?.message || 'Could not query radscheduler_audit.'));
  }catch(e){
    return _goLiveStatus('warn', 'Audit side table', e?.message || String(e));
  }
}
async function _goLiveBackupItem(sb){
  if(!sb || !_ROW_ID) return _goLiveStatus('warn', 'Backup restore confidence', 'Sign in to a practice before checking backup inventory.');
  try{
    const { data, error } = await sb.from(_BACKUP_TABLE).select('id, created_at').eq('practice_id', String(_ROW_ID)).order('created_at', { ascending:false }).limit(3);
    if(error) return _goLiveStatus('warn', 'Backup restore confidence', error.message || 'Could not read backup inventory.');
    const count = Array.isArray(data) ? data.length : 0;
    return _goLiveStatus(count ? 'ok' : 'warn', 'Backup restore confidence', count ? `${count} recent backup${count === 1 ? '' : 's'} visible; automated restore drill is covered by E2E.` : 'No backup rows visible yet. Let the daily backup run, then run the restore drill.');
  }catch(e){
    return _goLiveStatus('warn', 'Backup restore confidence', e?.message || String(e));
  }
}
async function _goLiveEdgeFunctionsItem(cfgUrl){
  if(!cfgUrl) return _goLiveStatus('warn', 'Edge function monitoring', 'Supabase URL is missing, so edge function probes cannot run.');
  const expectedStatuses = new Set([200, 400, 401, 403, 405]);
  const names = ['create-user','send-notification','widget-data','calendar-feed'];
  const results = [];
  for(const fn of names){
    try{
      const method = fn === 'widget-data' || fn === 'calendar-feed' ? 'GET' : 'POST';
      const res = await fetch(`${cfgUrl.replace(/\/$/,'')}/functions/v1/${fn}`, {
        method,
        headers: { 'Content-Type':'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      results.push({ fn, status: res.status, ok: expectedStatuses.has(res.status) });
    }catch(e){
      results.push({ fn, status: 0, ok:false, error:e?.message || String(e) });
    }
  }
  const bad = results.filter(r => !r.ok);
  return _goLiveStatus(bad.length ? 'warn' : 'ok',
    'Edge function monitoring',
    results.map(r => `${r.fn}: ${r.status || r.error || 'failed'}`).join(', '));
}
async function _goLiveManifestItem(){
  try{
    const [sw, manifest] = await Promise.all([
      _healthFetchText('/sw.js'),
      _healthFetchText('/manifest.webmanifest'),
    ]);
    const expected = (typeof _RS_HTML_BUILD !== 'undefined') ? _RS_HTML_BUILD : '';
    const liveSw = (/CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(sw.text || '') || [])[1] || '';
    const parsed = JSON.parse(manifest.text || '{}');
    const iconCount = Array.isArray(parsed.icons) ? parsed.icons.length : 0;
    const ok = sw.ok && manifest.ok && expected && liveSw === expected && iconCount > 0;
    return _goLiveStatus(ok ? 'ok' : 'warn', 'PWA assets', `HTML ${expected || 'unknown'}, sw.js ${liveSw || 'unknown'}, ${iconCount} icon(s).`);
  }catch(e){
    return _goLiveStatus('warn', 'PWA assets', e?.message || String(e));
  }
}
async function renderGoLiveChecklist(){
  if(!_isAdminOrSU || !_isAdminOrSU()) return;
  const host = document.getElementById('golive-result');
  if(!host) return;
  _healthRender(host, [{ status:'pending', label:'Go-live readiness', detail:'Checking browser, Supabase, backups, edge functions, and launch-day guardrails...' }], 'Go-live readiness');

  const cfgUrl = (typeof _getUrl === 'function') ? _getUrl() : '';
  const cfgKey = (typeof _getKey === 'function') ? _getKey() : '';
  const sb = cfgUrl && cfgKey
    ? (typeof _initAuthClient === 'function' ? _initAuthClient() : (typeof _initSupabase === 'function' ? _initSupabase() : null))
    : null;
  let session = null;
  try{ session = sb?.auth ? (await sb.auth.getSession())?.data?.session : null; }catch(_){}

  const expected = (typeof _RS_HTML_BUILD !== 'undefined') ? _RS_HTML_BUILD : '';
  const htmlSw = (typeof _SW_VERSION !== 'undefined') ? _SW_VERSION : '';
  const errCount = (typeof _errorLog !== 'undefined' && Array.isArray(_errorLog)) ? _errorLog.length : 0;
  const unsaved = !!(typeof _hasUnsavedChanges !== 'undefined' && _hasUnsavedChanges);

  const items = [
    _goLiveStatus(expected && expected === htmlSw ? 'ok' : 'fail', 'Build/version alignment', expected ? `HTML ${expected}; expected service worker ${htmlSw || 'missing'}.` : 'Missing app build marker.'),
    _goLiveStatus(cfgUrl && cfgKey ? 'ok' : 'fail', 'Supabase configuration', cfgUrl && cfgKey ? `Configured for ${cfgUrl.replace(/^https?:\/\//,'')}.` : 'Missing Supabase project URL or anon key.'),
    _goLiveStatus(session ? 'ok' : 'warn', 'Authenticated health test', session ? `Signed in as ${session.user?.email || 'current user'}.` : 'Run npm run test:e2e:live with RAD_E2E_EMAIL and RAD_E2E_PASSWORD before launch.'),
    _goLiveStatus('warn', 'Supabase leaked-password protection', 'Verify Auth > Security > Leaked password protection is enabled in the Supabase dashboard; public clients cannot introspect this setting.'),
    _goLiveStatus('ok', 'Migration drift guard', 'CI runs npm run test:migration-drift to catch missing hardening policies before deploy.'),
    _goLiveStatus(unsaved ? 'warn' : 'ok', 'Save queue', unsaved ? 'Unsaved changes are queued; wait for save/sync before launch.' : 'No unsaved browser edits are queued.'),
    _goLiveStatus(errCount ? 'warn' : 'ok', 'Runtime error log', errCount ? `${errCount} captured entr${errCount === 1 ? 'y' : 'ies'}; review Tools > Error log.` : 'No captured runtime errors.'),
  ];

  items.push(await _goLiveManifestItem());
  items.push(await _goLiveAuditSideTableItem(sb));
  items.push(await _goLiveBackupItem(sb));
  items.push(await _goLiveEdgeFunctionsItem(cfgUrl));
  try{ localStorage.setItem('rs.golive.lastRun', new Date().toISOString()); }catch(_){}
  _healthRender(host, items, 'Go-live readiness');
}
