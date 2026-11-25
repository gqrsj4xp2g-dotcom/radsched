const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('index.html','utf8');
const switchSource = source.slice(source.indexOf('let _practiceSwitchPending'),source.indexOf('/* ─── ANCHOR COMPLIANCE'));
const fixture=()=>({
  _ROW_ID:'A', _PRACTICE_ID:'A', S:{drShifts:[{id:'draft'}]}, CU:{id:1}, _saveConflict:null, _isSaving:false,
  _dirtySeq:1, _hasUnsavedChanges:false, _superuserOnly:()=>true, confirm:()=>true, _isRestoring:false,
  document:{getElementById:()=>({style:{}})},_toast(){}, alert(){}, console,
});
for(const failure of ['save','destination','intervening edit']){
  test('practice switch retains the current draft after '+failure,async()=>{
    const ctx=fixture();
    ctx._hasUnsavedChanges=failure==='save';
    ctx._pushToSupabase=async()=>false;
    ctx._pullFromSupabase=async(id)=>{
      assert.equal(id,'B'); assert.equal(ctx._ROW_ID,'A');
      if(failure==='intervening edit'){ctx._dirtySeq++;return {physicians:[],sites:[]};}
      return null;
    };
    const ok=await vm.runInNewContext(switchSource+"\nswitchPractice('B','Second')",ctx);
    assert.equal(ok,false);
    assert.equal(ctx._ROW_ID,'A');
    assert.equal(ctx.S.drShifts[0].id,'draft');
  });
}

test('a newer unsolicited remote delivery cannot erase an unsaved draft or advance its baseline',()=>{
  const start=source.indexOf('function _applyRemoteData(');
  const fn=source.slice(start,source.indexOf('\n}',start)+2);
  const prior='2025-10-01T00:00:00Z', next='2025-10-01T00:01:00Z';
  const draft={id:'A draft'}, conflicts=[];
  const ctx={S:{drShifts:[draft],_remoteSavedAt:prior},_hasUnsavedChanges:true,_userEditPending:true,
    _saveConflict:null,_isSaving:false,_sameInstant:(a,b)=>a===b,
    _validateRemotePayload:()=>({ok:true,problems:[]}),_onSaveConflict:(stamp,where)=>conflicts.push({stamp,where}),
    remote:{drShifts:[{id:'B committed'}],_dbSavedAt:next}};
  assert.equal(vm.runInNewContext(fn+'\n_applyRemoteData(remote)',ctx),false);
  assert.equal(ctx.S.drShifts[0],draft); assert.equal(ctx.S._remoteSavedAt,prior);
  assert.deepEqual(conflicts,[{stamp:next,where:'remote-update'}]);
});

function savingFixture(){
  let ack;
  const callbacks=[];
  const ctx=Object.assign(fixture(),{
    _saveAttemptId:0,_hasUnsavedChanges:true,_isSaving:false,_followUpRequested:false,
    _saveWatchdog:null,_saveTimeout:null,_SAVE_TIMEOUT_MS:25000,
    _TAB_ID:'writer-A',_SCHEMA_VERSION:1,_myPushStamps:[],_casStampRetried:false,
    _userEditPending:true,_consecutiveSaveFails:0,
    S:{physicians:[{}],drShifts:[{id:'A'}],_remoteSavedAt:null,_lastLocalChange:100},
    USERS:[],_buildPersistedPayload:()=>({}),_initSupabase:()=>true,_updateSaveUI(){},
    clearTimeout(){},setTimeout(fn,ms){callbacks.push({fn,ms});return callbacks.length;},
    _supabase:{rpc:()=>new Promise(resolve=>{ack=()=>resolve({data:{ok:true,saved_at:'revision-A'}});})}
  });
  const begin=source.indexOf('async function _pushToSupabase(');
  const fn=source.slice(begin,source.indexOf('\n}',begin)+2);
  const sandbox=vm.createContext(ctx);
  vm.runInContext(fn+'\n'+switchSource,sandbox);
  return {ctx,invoke:(statement)=>vm.runInContext(statement,sandbox),ack:()=>ack(),captureAck:()=>ack,callbacks};
}
test('a save in flight blocks switching and acknowledges only the revision sent',async()=>{
  const {ctx,invoke,ack,callbacks}=savingFixture();
  const first=invoke('_pushToSupabase()');
  assert.equal(ctx._isSaving,true); assert.equal(ctx._hasUnsavedChanges,true);
  assert.equal(await invoke("switchPractice('B','B')"),false);
  ctx._dirtySeq++; ctx.S._lastLocalChange=200;
  ack(); assert.equal(await first,true);
  assert.equal(ctx._hasUnsavedChanges,true); assert.equal(ctx.S._lastLocalChange,200);
  assert.equal(ctx._ROW_ID,'A');
  assert.ok(callbacks.some(x=>x.ms===250));
  const second=invoke('_pushToSupabase()'); ack(); assert.equal(await second,true);
  assert.equal(ctx._hasUnsavedChanges,false);
});
test('an unconfigured save retains the draft and an expired request cannot clear a newer save lock',async()=>{
  const {ctx,invoke,ack,captureAck,callbacks}=savingFixture();
  ctx._initSupabase=()=>false;
  assert.equal(await invoke('_pushToSupabase()'),false);
  assert.equal(ctx._hasUnsavedChanges,true);
  ctx._initSupabase=()=>true;
  const expired=invoke('_pushToSupabase()');
  const finishExpired=captureAck();
  callbacks.findLast(x=>x.ms===ctx._SAVE_TIMEOUT_MS).fn();
  // Once a server request times out, its late acknowledgement cannot mark the tab clean.
  const current=invoke('_pushToSupabase()');
  finishExpired(); assert.equal(await expired,false);
  assert.equal(ctx._isSaving,true);
  assert.equal(ctx._hasUnsavedChanges,true); assert.equal(ctx.S._remoteSavedAt,null);
  ack(); assert.equal(await current,true); assert.equal(ctx._hasUnsavedChanges,false);
});

test('a successful switch loads the staged target and clears actor-scoped state only at commit',async()=>{
  const ctx=fixture();
  const order=[];
  const dest={sites:[],physicians:[],drShifts:[{id:'B saved'}]};
  Object.assign(ctx,{
    _hasUnsavedChanges:true,USERS:[],_recentlyAddedUsers:[{id:'prior'}],_knownTabs:new Set(),_bc:null,
    _leaderHbTimer:null,_leaderCheckTimer:null,localStorage:{length:0,setItem(){}},
    _pushToSupabase:async()=>{order.push('save A');ctx._hasUnsavedChanges=false;return true;},
    _pullFromSupabase:async id=>{assert.equal(ctx._ROW_ID,'A');order.push('load '+id);return dest;},
    _stopRealtimeAndPoll(){},_clearSaveConflict(){},_fsDetach(){},_clearPrivateChat(){order.push('clear A chat');},
    _resetPersistedState(){}, _applyRemoteData(d){assert.equal(ctx._ROW_ID,'B');ctx.S.drShifts=d.drShifts;},
    _initLeaderElection(){},fsTryRestoreAutosave(){},renderDash(){}
  });
  assert.equal(await vm.runInNewContext(switchSource+"\nswitchPractice('B','Second')",ctx),true);
  assert.deepEqual(order,['save A','load B','clear A chat']);
  assert.equal(ctx.S.drShifts[0].id,'B saved'); assert.equal(ctx._recentlyAddedUsers.length,0);
});
