const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {checkPublicShell} = require('../../tools/check-public-shell');
const html = fs.readFileSync('index.html','utf8');
const build = html.slice(html.indexOf('function _buildSaveHTML('), html.indexOf('\n}',html.indexOf('function _buildSaveHTML(')) + 2);
function exportFixture(shell=html) {
  const label = "O'Neil $& $1 <call> </script>";
  const context = { _SRC:shell, _ROW_ID:'unit-practice', USERS:[{id:1,first:label,password:'FORBIDDEN_TEST_CREDENTIAL'}],
    _buildPersistedPayload: () => ({drShifts:[{label}]}) };
  const file = vm.runInNewContext(build + '\n_buildSaveHTML()', context);
  const snapshot = JSON.parse(file.match(/<script id="rs-private-export" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(snapshot.state.drShifts[0].label,label);
  assert.equal(snapshot.users[0].first,label);
  assert.ok(!file.includes('FORBIDDEN_TEST_CREDENTIAL'));
  assert.ok(file.includes("form-action 'none'"));
  for(const [,attrs,script] of file.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    if(!attrs.includes('application/json') && !attrs.includes('src=')) new vm.Script(script);
  }
  return file;
}
test('private HTML round-trips arbitrary text and stays a private export on repeat', () => {
  const first=exportFixture();
  const second=exportFixture(first);
  assert.throws(()=>checkPublicShell(first));
  assert.throws(()=>checkPublicShell(second));
});
test('public artifact rejects populated boot state and legacy copies embedded in exporter source', () => {
  checkPublicShell(html);
  assert.throws(()=>checkPublicShell(html.replace(/(^let USERS = \/\*USERS_START\*\/)\[\]/m,'$1[{"id":1}]')));
  const seed=html.indexOf('let S=/*S_START*/');
  assert.throws(()=>checkPublicShell(html.slice(0,seed)+html.slice(seed).replace('physicians:[]','physicians:[{id:1}]')));
  assert.throws(()=>checkPublicShell(html+'\n/*S_START*/{"drShifts":[{}]}/*S_END*/'));
});

test('only a local private copy hydrates the membership and schedule that were exported',()=>{
  const file=exportFixture();
  const snapshot=file.match(/<script id="rs-private-export" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const start=html.indexOf("if(location.protocol === 'file:'){",html.indexOf('let S=/*S_START*/'));
  const boot=html.slice(start,html.indexOf('// _isRestoring and _dataRestored',start));
  for(const protocol of ['file:','https:']){
    const ctx={S:{drShifts:[]},USERS:[],location:{protocol},_PERSISTED_KEYS:[{key:'drShifts'}],
      document:{getElementById:()=>({textContent:snapshot}),addEventListener(){}}};
    vm.runInNewContext(boot,ctx);
    if(protocol==='file:'){
      assert.equal(ctx.USERS[0].first,"O'Neil $& $1 <call> </script>");
      assert.equal(ctx.S.drShifts[0].label,ctx.USERS[0].first);
    }else{ assert.equal(ctx.USERS.length,0); assert.equal(ctx.S.drShifts.length,0); }
  }
});
