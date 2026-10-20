import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const isolatedHome = mkdtempSync(join(tmpdir(), 'substation-resume-fixture-'));
process.env.HOME = isolatedHome;
process.env.CLAUDE_CONFIG_DIR = isolatedHome;
test.after(() => rmSync(isolatedHome, {recursive:true, force:true}));
const {invokeClaudeSDKWithTools, sdkResumeCache} = await import('../src/index.js');
const exact='API Error: 400 A maximum of 4 blocks with cache_control may be provided. Found 5.';
for (const scenario of ['second-failure','genuine-assistant','missing-model-assistant','error-bearing-assistant','close-failure','embedded401','embedded429','unstructured400','provider-stream','missing-model-stream','canceled','other400','rate429','fresh400']) test(`resume marker recovery fails closed: ${scenario}`,async()=>{
  sdkResumeCache.clear();const calls=[],closed=[];let stage=0;
  const model={modelId:`claude-resume-guard-${scenario}`},token={id:`resume-guard-${scenario}`,token:'offline',activeRequests:0};
  const tools=[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{}}}}];
  const controller=new AbortController();
  const sdkMod={tool:name=>({name}),createSdkMcpServer:c=>c,query(args){
    const current=++stage;if(scenario==='second-failure'&&current===3)assert.deepEqual(closed,[2],'failed query cleanup must finish before fresh query');calls.push({resume:args.options.resume,model:args.options.model,token:args.options.env.CLAUDE_CODE_OAUTH_TOKEN});
    const iter=(async function*(){
      yield {type:'system',subtype:'init',model:model.modelId,session_id:'sdk-legitimate'};
      if(current===1&&scenario!=='fresh400') {yield {type:'assistant',message:{id:'msg-seed',model:model.modelId,content:[{type:'text',text:'ready'}]}};return;}
      if(scenario==='genuine-assistant')yield {type:'assistant',message:{id:'msg-real',model:model.modelId,content:[{type:'text',text:'Already answered'}]}};
      if(scenario==='missing-model-assistant')yield {type:'assistant',message:{content:[{type:'text',text:'Already answered without model identity'}]}};
      if(scenario==='error-bearing-assistant')yield {type:'assistant',error:'unclassified',message:{content:[{type:'text',text:'Already answered despite missing model and error metadata'}]}};
      if(scenario==='missing-model-stream')yield {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Already streamed'}}};
      if(scenario==='provider-stream')yield {type:'stream_event',event:{type:'message_start',message:{id:'msg-stream',model:model.modelId,usage:{input_tokens:2}}}};
      if(scenario==='canceled')controller.abort();
      if(scenario==='embedded401'||scenario==='embedded429'){const error=new Error(exact);error.statusCode=scenario==='embedded401'?401:429;throw error;}
      if(scenario==='unstructured400')throw new Error('Untrusted prior error text: '+exact);
      throw new Error(scenario==='other400'?'API Error: 400 invalid cache TTL order':scenario==='rate429'?'API Error: 429 usage limit':exact);
    })();iter.close=async()=>{await Promise.resolve();if(scenario==='close-failure'&&current===2)throw new Error('cleanup failed');closed.push(current);};return iter;
  }};
  const deps={sdkMod,z:{},tokens:[token],markRequestStart(){},markSuccess(){}};
  const initial=[{role:'user',content:'Guard fixture'}];
  const invoke=h=>invokeClaudeSDKWithTools(h,tools,'auto',model,token.id,null,true,null,deps,controller.signal);
  if(scenario!=='fresh400')assert.equal((await invoke(initial)).text,'ready');
  const tail=[...initial,{role:'assistant',content:'ready'},{role:'user',content:'Next'}];
  await assert.rejects(invoke(scenario==='fresh400'?initial:tail));
  assert.equal(calls.length,scenario==='second-failure'?3:scenario==='fresh400'?1:2);
  if(scenario==='second-failure') {assert.equal(calls[1].resume,'sdk-legitimate');assert.equal(calls[2].resume,undefined);assert.deepEqual(calls[2].model,calls[1].model);assert.equal(calls[2].token,calls[1].token);assert.deepEqual(closed,[2,3]);}
});
