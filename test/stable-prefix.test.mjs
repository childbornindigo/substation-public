import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import(process.env.STABLE_PREFIX_TEST_SOURCE || '../src/index.js');
const source=[{role:'system',content:'caller stable system'},{role:'user',content:'Find item'},{role:'assistant',content:null,tool_calls:[{id:'call-a',function:{name:'lookup',arguments:'{"a":1}'}}]},{role:'tool',tool_call_id:'call-a',name:'lookup',content:'found'}];
test('fresh continuation retains identical prior blocks without promoting previous tail',()=>{
 const first=mod.formatStableMessagesForSDK(source.slice(0,2));const next=mod.formatStableMessagesForSDK(source);
 const strip=x=>x.map(({cache_control,...b})=>b);
 assert.deepEqual(strip(next.slice(0,first.length)),strip(first));assert.equal(next.filter(b=>b.cache_control).length,1);assert.deepEqual(next.at(-1).cache_control,{type:'ephemeral',ttl:'5m'});
});
test('stable blocks retain caller system and paired completed tool IDs/status',()=>{
 const blocks=mod.formatStableMessagesForSDK(source);const text=blocks.map(b=>b.text).join('\n');assert.match(text,/caller stable system/);assert.match(text,/tool_call id="call-a" name="lookup"/);assert.match(text,/tool_result id="call-a" name="lookup" status=ok]: found/);assert.match(text,/\[user\]: Find item/);
});
test('tool choice nudge is a separate final block and cannot mutate historical cache prefix',()=>{
 const a=mod.formatStableMessagesForSDK(source);const b=mod.formatStableMessagesForSDK(source,'You MUST call lookup.');const strip=x=>x.map(({cache_control,...b})=>b);assert.deepEqual(strip(b.slice(0,a.length)),strip(a));assert.equal(b.at(-1).text,'You MUST call lookup.');assert.equal(b.filter(x=>x.cache_control).length,1);
});
test('sdk prompt iterator submits one composed user message retaining blocks',async()=>{
 const blocks=mod.formatStableMessagesForSDK(source);const rows=[];for await(const r of mod.sdkPromptFromBlocks(blocks))rows.push(r);assert.equal(rows.length,1);assert.equal(rows[0].client_composed,undefined);assert.deepEqual(rows[0].message,{role:'user',content:blocks});assert.equal(rows[0].parent_tool_use_id,null);
});
