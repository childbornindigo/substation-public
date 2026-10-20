import assert from 'node:assert/strict';
import test from 'node:test';
import {invokeClaudeSDK} from '../src/index.js';
const model={modelId:'claude-plain-usage-regression'};
const deps=querySDK=>({querySDK,tokens:[{id:'private-account',token:'MOCK_ONLY',activeRequests:0}]});
test('plain Claude SDK returns authoritative terminal measured usage',async()=>{
 async function* querySDK(){
  yield {type:'system',subtype:'init',model:model.modelId};
  yield {type:'assistant',message:{id:'plain-measured',model:'claude-opus-5-5',usage:{input_tokens:0,cache_creation_input_tokens:700,cache_read_input_tokens:900,output_tokens:1},content:[{type:'text',text:'reply'}]}};
  yield {type:'result',usage:{input_tokens:0,cache_creation_input_tokens:700,cache_read_input_tokens:900,output_tokens:12},result:'reply'};
 }
 const r=await invokeClaudeSDK([{role:'user',content:'private'}],model,null,'private-account',null,null,null,deps(querySDK));
 assert.equal(r.text,'reply');assert.equal(r.substationUsage.input,0);assert.equal(r.substationUsage.output,12);
 assert.equal(r.substationUsage.cache_creation,700);assert.equal(r.substationUsage.cache_read,900);
 assert.equal(r.substationUsage.provider_model,'claude-opus-5-5');assert.match(r.substationUsage.account_alias,/^[a-f0-9]{64}$/);
 assert.equal(r.substationUsage.usage_complete,true);
});
test('plain incomplete provider usage is not estimated or complete',async()=>{
 async function* querySDK(){yield {type:'assistant',message:{id:'plain-partial',model:'claude-opus-5-5',content:[{type:'text',text:'reply'}],usage:{output_tokens:2}}};}
 const r=await invokeClaudeSDK([{role:'user',content:'private'}],model,null,'private-account',null,null,null,deps(querySDK));
 assert.equal(r.substationUsage.input,null);assert.equal(r.substationUsage.output,2);assert.equal(r.substationUsage.cache_creation,null);
 assert.equal(r.substationUsage.usage_complete,false);
});
