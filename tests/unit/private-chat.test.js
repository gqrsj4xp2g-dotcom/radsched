const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const html = readFileSync(require.resolve('../../index.html'), 'utf8');
const chat = html.slice(html.indexOf('let _chatContext = null;'), html.indexOf('async function _toggleChatPin('));
const lifecycle = chat.slice(0, chat.indexOf('function renderChat()'));
const filters = chat.slice(chat.indexOf('function _getContextMessages(){'), chat.indexOf('/* ─── SWAPS'));
const run = (context, code) => runInNewContext(code, context);

function fixture(read) {
  const context = {
    CU: { id:'a', practiceId:'alpha' }, _ROW_ID:'alpha',
    S: { chatGroups:[] }, document:{ getElementById:()=>null },
    _showChatPlaceholder(){}, _renderChatGroupList(){}, _renderChatDMList(){},
    clearInterval(){},
    client: { from(table) {
      assert.equal(table,'rs_chat_messages');
      let after, practice;
      const q = {
        select(){return q;}, eq(field,value){assert.equal(field,'practice_id'); practice=value; return q;},
        gt(field,value){assert.equal(field,'id'); after=value; return q;},
        order(){return q;}, limit(){return read(practice,after);}
      };
      return q;
    }}
  };
  run(context, lifecycle + filters + '\n_chatSession.scope=_chatScope(); _chatSession.client=client;');
  return context;
}
const row=(id,user,recipient,body)=>({id,sender_id:user,recipient_id:recipient,body,sent_at:'2026-11-24'});

test('private inbox pages by id, shows each conversation and excludes all messages and pins from schedule exports',async()=>{
  const records=[row(1,'a','b','first'),row(2,'c','a','second')];
  const c=fixture((practice,after)=>{
    assert.equal(practice,'alpha');
    return {data:records.filter(r=>r.id>after).slice(0,1)};
  });
  await run(c,'_refreshPrivateChat()');
  const selected=run(c,"_chatContext={type:'dm',id:'a::b',toUserId:'b'}; _getContextMessages().map(m=>m.text).join(',')");
  assert.equal(selected,'first');
  assert.equal(run(c,"_countUnread('dm','a::c')"),1);
  const manifest=html.slice(html.indexOf('const _PERSISTED_KEYS = ['),html.indexOf('function _buildPersistedPayload('));
  assert.doesNotMatch(manifest,/key:'chat(?:Messages|Pins)'/);
  assert.deepEqual(c.S,{chatGroups:[]});
});

test('an in-flight response cannot repopulate chat after a practice switch or logout',async()=>{
  let deliver;
  const c=fixture(()=>new Promise(resolve=>{deliver=resolve;}));
  const pending=run(c,'_refreshPrivateChat()');
  run(c,"_clearPrivateChat(); _ROW_ID='beta'; CU=null;");
  deliver({data:[row(1,'a','b','stale')]});
  await pending;
  assert.equal(run(c,'_chatSession.messages.length'),0);
  assert.equal(run(c,'_chatContext'),null);
});

test('failed refresh discards cached content and prior local snapshots retain only schedule fields', async()=>{
  const c=fixture(()=>({data:null,error:new Error('offline')}));
  run(c,"_chatSession.messages=[{text:'old'}];");
  await run(c,'_refreshPrivateChat()');
  assert.equal(run(c,'_chatSession.messages.length'),0);
  assert.match(run(c,'_chatSession.status'),/unavailable/);
  const items=new Map([['rs.snap.123',JSON.stringify({data:JSON.stringify({sites:[1],chatMessages:[{text:'old'}],chatPins:{}})})],['other','chatMessages']]);
  c.storage={length:items.size,key:n=>[...items.keys()][n],getItem:key=>items.get(key),setItem:(key,v)=>items.set(key,v),removeItem:key=>items.delete(key)};
  run(c,'_scrubLegacyChatSnapshots(storage)');
  assert.deepEqual(JSON.parse(JSON.parse(items.get('rs.snap.123')).data),{sites:[1]});
  assert.equal(items.get('other'),'chatMessages');
});
