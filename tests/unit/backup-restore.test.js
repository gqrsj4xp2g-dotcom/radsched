const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const html = fs.readFileSync('index.html','utf8');
const restoreSource = html.slice(html.indexOf('const _pendingBackupRestores ='), html.indexOf('async function previewBackupRestore('));

function fixture() {
  const requests = [], applied = [], alerts = [], conflicts = [];
  const session = new Map();
  const backup = {practice_id:'A',id:'picked',data:JSON.stringify({physicians:[],drShifts:[{id:1}]})};
  function newTab() {
    const ctx = {
      _adminOnly: () => true, _ROW_ID:'A', CU:{id:'actor'}, _BACKUP_TABLE:'radscheduler_backups',
      S:{_remoteSavedAt:'2026-01-01T00:00:00Z'}, _dirtySeq:0, _hasUnsavedChanges:false, _isSaving:false, _saveConflict:null,
      confirm:()=>true, alert:msg=>alerts.push(msg), _clearSaveConflict(){}, _onSaveConflict:(stamp)=>conflicts.push(stamp),
      _applyRemoteData:payload=>applied.push(payload), crypto:{randomUUID}, console:{error(){},warn(){}},
      sessionStorage:{getItem:k=>session.get(k) || null,setItem:(k,v)=>session.set(k,v),removeItem:k=>session.delete(k)},
      _supabase:{from(table){
        assert.equal(table,'radscheduler_backups');
        const filters = {};
        return {select(){return this;},eq(k,v){filters[k]=v;return this;},single(){
          assert.deepEqual(filters,{practice_id:'A',id:'picked'});
          return {data:backup,error:null};
        }};
      }},
      _invokeEdgeFn:async(name,body)=>{
        assert.equal(name,'admin-ops');
        requests.push({...body});
        if(requests.length===1) throw new Error('The response was lost');
        return {ok:true,replayed:true,savedAt:'new',payload:{drShifts:[{id:3}],_dbSavedAt:'new'}};
      },
    };
    vm.createContext(ctx);
    vm.runInContext(restoreSource,ctx);
    return ctx;
  }
  return {requests,applied,alerts,conflicts,session,newTab};
}

test('restore retry after reload reuses the request and original version',async()=>{
  const state=fixture(), first=state.newTab();
  assert.equal(await first.restoreFromBackup('picked'),false);
  const next=state.newTab();
  next.S._remoteSavedAt='2026-03-01T00:00:00Z';
  assert.equal(await next.restoreFromBackup('picked'),true);
  assert.deepEqual(state.requests[0],state.requests[1]);
  assert.equal(state.requests[0].expectedSavedAt,'2026-01-01T00:00:00Z');
  assert.equal(state.applied[0].drShifts[0].id,3);
  assert.equal(state.session.size,0);
});

test('cancel and dirty local draft send no restore request',async()=>{
  const state=fixture(), tab=state.newTab();
  tab.confirm=()=>false;
  assert.equal(await tab.restoreFromBackup('picked'),false);
  tab.confirm=()=>true;
  tab._hasUnsavedChanges=true;
  assert.equal(await tab.restoreFromBackup('picked'),false);
  assert.equal(state.requests.length,0);
  assert.equal(state.session.size,0);
});

test('edits made while restore is committing survive for conflict review',async()=>{
  const state=fixture(), tab=state.newTab();
  tab._invokeEdgeFn=async()=>{
    tab._dirtySeq++;
    return {ok:true,savedAt:'new',payload:{drShifts:[{id:2}],_dbSavedAt:'new'}};
  };
  assert.equal(await tab.restoreFromBackup('picked'),true);
  assert.equal(state.applied.length,0);
  assert.deepEqual(state.conflicts,['new']);
});
