import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {invokeClaudeSDK,sdkCacheUsage} from '../src/index.js';
import {probeLifecycleIdle} from '../src/warm-cache-runtime.js';
const model={modelId:'claude-sonnet-5'},token={id:'offline-observation',token:'MOCK_ONLY',activeRequests:0};
const hash=v=>createHash('sha256').update(v).digest('hex');
test('actual SDK observation joins start, served ephemeral usage and completion after iterator closes',async()=>{
 const events=[];let closed=false;
 async function* querySDK(){try{yield{type:'system',subtype:'init',model:model.modelId};yield{type:'assistant',message:{id:'observed',model:model.modelId,content:[{type:'text',text:'offline'}],usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:99,cache_creation_input_tokens:2,cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:2}}}};yield{type:'result',usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:99,cache_creation_input_tokens:2}};}finally{closed=true;}}
 const warmCacheObserver={started:e=>{events.push(e);return{id:'owned'};},finished:(h,u,outcome)=>{assert.equal(closed,true);events.push({h,u,outcome});}};
 const before=Date.now();const result=await invokeClaudeSDK([{role:'user',content:'owned offline'}],model,null,token.id,null,null,null,{tokens:[token],querySDK,warmCacheObserver});
 assert.equal(events.length,2);assert.ok(events[0].startedAt>=before);assert.equal(events[0].token.id,token.id);assert.equal(events[1].u.account_alias,hash(token.id));assert.equal(events[1].u.cache_creation_1h,2);assert.equal(events[1].u.cache_creation_5m,0);assert.equal(events[1].outcome,'ok');assert.equal(result.substationUsage.providers[0].cache_creation_1h,2);
});
test('policy text cannot substitute for provider ephemeral usage',()=>{assert.deepEqual(sdkCacheUsage({usage:{ttl:'1h',cache_creation_input_tokens:10}}),{});assert.deepEqual(sdkCacheUsage({usage:{cache_creation:{ephemeral_1h_input_tokens:-1,ephemeral_5m_input_tokens:0}}}),{});});
test('legacy model-loop completion alone never claims gateway idle or empty pending input',async()=>{assert.equal(await probeLifecycleIdle({session:'a'.repeat(64)}),null);});

test('actual summary SDK bridge appends instruction, pins sole account, denies tools and reports served usage',async()=>{
 const {invokeWarmSummary}=await import('../src/index.js');let calls=0,denials=0;
 const tool={type:'function',function:{name:'owned_lookup',parameters:{type:'object',properties:{}}}};
 const sdkMod={tool:(name,_description,_schema,handler)=>({name,handler}),createSdkMcpServer:x=>x,async*query({prompt,options}){
  calls++;assert.equal(options.maxTurns,1);assert.equal(options.tools,undefined);assert.ok(options.allowedTools.includes('mcp__caller-tools__owned_lookup'));assert.equal(options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,'4096');assert.equal(options.canUseTool,undefined);
  const hook=options.hooks.PreToolUse[0].hooks[0];
  for(const tool_name of ['Bash','mcp__caller-tools__owned_lookup'])assert.equal((await hook({tool_name})).hookSpecificOutput.permissionDecision,'deny');denials++;
  const blocks=[];if(typeof prompt==='string')blocks.push(prompt);else for await(const p of prompt)blocks.push(JSON.stringify(p));assert.ok(blocks.join('').includes('Write only a JSON'));
  assert.ok(options.mcpServers['caller-tools'].tools.some(t=>t.name==='owned_lookup'));
  yield{type:'system',subtype:'init',model:model.modelId};yield{type:'assistant',message:{id:'warm-summary',model:model.modelId,content:[{type:'text',text:'{"Status":"offline complete"}'}],usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:55,cache_creation_input_tokens:0}}};yield{type:'result',usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:55,cache_creation_input_tokens:0}};
 }};
 const input={session:'a'.repeat(64),generation:'b'.repeat(64),account:hash(token.id),model:model.modelId,prefix:'d'.repeat(64),messages:[{role:'user',content:'original owned context'},{role:'user',content:'Write only a JSON handoff.'}],tools:[tool],handoffRequestId:'owned-request',origin:'warm-handoff',summaryOnly:true,executeTools:false,notifications:false,tool_choice:'none'};
 const r=await invokeWarmSummary(input,{tokens:[token],sdkMod,z:{},warmDispatchGuard:()=>true,markRequestStart(){},markSuccess(){}});assert.equal(calls,1);assert.equal(denials,1);assert.equal(r.handoffRequestId,input.handoffRequestId);assert.equal(r.usage.account,hash(token.id));assert.equal(r.usage.provider_model,model.modelId);assert.equal(r.usage.usage_complete,true);assert.deepEqual(r.toolCalls,[]);
 await assert.rejects(invokeWarmSummary({...input,executeTools:true},{tokens:[token]}));await assert.rejects(invokeWarmSummary({...input,account:'f'.repeat(64)},{tokens:[token]}));
});
test('summary cancellation aborts actual SDK iterator with no second query',async()=>{
 const {invokeWarmSummary}=await import('../src/index.js');let queries=0,closed=false,ready;const started=new Promise(r=>{ready=r;}),abort=new AbortController();
 const sdkMod={tool:n=>({name:n}),createSdkMcpServer:x=>x,async*query({options}){queries++;try{ready();await new Promise((resolve,reject)=>{options.abortController.signal.addEventListener('abort',()=>reject(Error('owned abort')),{once:true});});}finally{closed=true;}}};
 const input={session:'a'.repeat(64),generation:'b'.repeat(64),account:hash(token.id),model:model.modelId,prefix:'d'.repeat(64),messages:[{role:'user',content:'owned summary'}],tools:[],handoffRequestId:'cancel-owned',origin:'warm-handoff',summaryOnly:true,executeTools:false,notifications:false,tool_choice:'none',signal:abort.signal};
 const pending=invokeWarmSummary(input,{tokens:[token],sdkMod,z:{},warmDispatchGuard:()=>true,markRequestStart(){},markSuccess(){}});await started;abort.abort();await assert.rejects(pending);assert.equal(closed,true);assert.equal(queries,1);
});
