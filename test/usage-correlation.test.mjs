import assert from 'node:assert/strict';
import test from 'node:test';
const mod = await import(process.env.CORRELATION_TEST_SOURCE || '../src/index.js');
const model={modelId:'claude-caller-tools-regression'};
const tools=[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{}}}}];
const correlation={turn:'a'.repeat(32),call:'b'.repeat(32),session:'c'.repeat(64),proxy:'chatcmpl-private',source:'wake',attempt:'1'};
const deps=(query,rows,throwLedger=false)=>({sdkMod:{tool:name=>({name}),createSdkMcpServer:x=>x,query},z:{},tokens:[{id:'private-account',token:'NEVER-LOG-CREDENTIAL',activeRequests:0}],markRequestStart(){},markSuccess(){},onUsageRow:row=>{if(throwLedger)throw Error('diskfail');rows.push(row);}});
test('provider usage joined before tool abort without tool execution or resume',async()=>{
  const rows=[];let executed=0;
  async function* query({options}){
    yield {type:'system',subtype:'init',model:model.modelId,session_id:'sdk-private-id'};
    yield {type:'assistant',message:{id:'msg-private-id',model:'claude-sonnet-5-5',usage:{input_tokens:5,cache_creation_input_tokens:700,cache_read_input_tokens:900,output_tokens:12},content:[{type:'tool_use',id:'call-1',name:'mcp__caller-tools__lookup',input:{raw:'PRIVATE ARGUMENT'}}]}};
    executed++;assert.equal(options.abortController.signal.aborted,true);
  }
  const result=await mod.invokeClaudeSDKWithTools([{role:'user',content:'PRIVATE CHAT'}],tools,'required',model,'private-account',null,true,null,deps(query,rows),null,correlation);
  assert.equal(result.toolCalls[0].id,'call-1');assert.equal(executed,0);
  const row=rows.find(x=>x.event==='sdk_provider_message');
  assert.ok(row,'baseline has no authoritative provider usage join');
  assert.equal(row.provider_model,'claude-sonnet-5-5');assert.equal(row.cache_creation,700);assert.equal(row.cache_read,900);assert.equal(row.input,5);
  assert.equal(row.turn,correlation.turn);assert.equal(row.call,correlation.call);
  const raw=JSON.stringify(rows);assert.doesNotMatch(raw,/PRIVATE|NEVER-LOG|private-account|sdk-private-id|msg-private-id/);
  assert.match(row.provider_message,/^[a-f0-9]{64}$/);
  assert.match(rows.find(x=>x.event==='sdk_start').account_alias,/^[a-f0-9]{64}$/);
});
test('missing or malformed SDK usage remains null, not inferred zeros',()=>{
  assert.deepEqual(mod.sdkUsageRow({id:'msg',usage:{input_tokens:-1,output_tokens:'3',cache_creation_input_tokens:Infinity}}),{provider_model:null,provider_request:null,provider_message:mod.sdkUsageRow({id:'msg'}).provider_message,input:null,cache_creation:null,cache_read:null,output:null});
});
test('headers validate opaque IDs and never accept raw source content',()=>{
  const headers={'x-hermes-usage-turn':'a'.repeat(32),'x-hermes-usage-call':'b'.repeat(32),'x-hermes-usage-session':'c'.repeat(64),'x-hermes-usage-source':'RAW CHAT','x-hermes-usage-attempt':'1'};
  assert.equal(mod.usageCorrelationFromHeaders(headers,'proxy').source,'unclassified');
  assert.equal(mod.usageCorrelationFromHeaders({...headers,'x-hermes-usage-turn':'telegram:123'},'proxy'),null);
});
test('telemetry failures and malformed SDK session metadata do not alter tool return',async()=>{
  async function* query(){yield {type:'system',subtype:'init',model:model.modelId,session_id:{private:'malformed'}};yield {type:'assistant',message:{content:[{type:'tool_use',id:'call-2',name:'mcp__caller-tools__lookup',input:{}}]}};}
  const result=await mod.invokeClaudeSDKWithTools([{role:'user',content:'lookup'}],tools,'required',model,'private-account',null,true,null,deps(query,[],true),null,correlation);
  assert.equal(result.toolCalls[0].id,'call-2');
});
test('throwing provider usage extractor cannot fail actual tool response',async()=>{
  const message={content:[{type:'tool_use',id:'call-extractor',name:'mcp__caller-tools__lookup',input:{}}]};
  Object.defineProperty(message,'usage',{get(){throw Error('malformed SDK telemetry getter');}});
  async function* query(){yield {type:'assistant',message};}
  const result=await mod.invokeClaudeSDKWithTools([{role:'user',content:'lookup'}],tools,'required',model,'private-account',null,true,null,deps(query,[]),null,correlation);
  assert.equal(result.toolCalls[0].id,'call-extractor');
});

test('provider model missing or malformed remains null rather than requested/init echo',()=>{
  for (const value of [undefined,null,42,{},'PRIVATE CHAT CONTENT','x'.repeat(101)]) assert.equal(mod.sdkUsageRow({model:value}).provider_model,null);
  assert.equal(mod.sdkUsageRow({model:'claude-opus-4-6'}).provider_model,'claude-opus-4-6');
});

test('caller-tool abort returns authoritative measured usage without result or estimates',async()=>{
  async function* query(){yield {type:'assistant',message:{id:'measured-tool',model:'claude-opus-5-5',usage:{input_tokens:0,cache_creation_input_tokens:700,cache_read_input_tokens:900,output_tokens:12},content:[{type:'tool_use',id:'measured-call',name:'mcp__caller-tools__lookup',input:{}}]}};}
  const result=await mod.invokeClaudeSDKWithTools([{role:'user',content:'lookup'}],tools,'required',model,'private-account',null,true,null,deps(query,[]),null,correlation);
  assert.equal(result.substationUsage.input,0);
  assert.equal(result.substationUsage.cache_creation,700);
  assert.equal(result.substationUsage.cache_read,900);
  assert.equal(result.substationUsage.output,12);
  assert.equal(result.substationUsage.provider_model,'claude-opus-5-5');
  assert.match(result.substationUsage.account_alias,/^[a-f0-9]{64}$/);
});
test('duplicate fragments max per message; terminal aggregate supersedes assistant sum',async()=>{
  async function* query(){
    yield {type:'assistant',message:{id:'same-message',model:'claude-opus-5-5',usage:{input_tokens:5,cache_creation_input_tokens:7,cache_read_input_tokens:9,output_tokens:2},content:[]}};
    yield {type:'assistant',message:{id:'same-message',model:'claude-opus-5-5',usage:{input_tokens:5,cache_creation_input_tokens:7,cache_read_input_tokens:9,output_tokens:3},content:[]}};
    yield {type:'result',usage:{input_tokens:5,cache_creation_input_tokens:7,cache_read_input_tokens:9,output_tokens:3},result:'ok'};
  }
  const result=await mod.invokeClaudeSDKWithTools([{role:'user',content:'lookup'}],tools,'auto',model,'private-account',null,true,null,deps(query,[]),null,correlation);
  assert.equal(result.substationUsage.input,5);assert.equal(result.substationUsage.cache_creation,7);assert.equal(result.substationUsage.output,3);
  assert.equal(result.substationUsage.providers[0].provider_messages.length,1);
});
test('missing counters remain null on measured return',async()=>{
  async function* query(){yield {type:'assistant',message:{id:'partial',model:'claude-opus-5-5',content:[{type:'tool_use',id:'missing-call',name:'mcp__caller-tools__lookup',input:{}}],usage:{output_tokens:0}}};}
  const result=await mod.invokeClaudeSDKWithTools([{role:'user',content:'lookup'}],tools,'required',model,'private-account',null,true,null,deps(query,[]),null,correlation);
  assert.equal(result.substationUsage.input,null);assert.equal(result.substationUsage.cache_read,null);assert.equal(result.substationUsage.output,0);
});

test('SDK provider stream terminal usage gives real final output before tool abort',async()=>{
  async function* query({options}){
    assert.equal(options.includePartialMessages,true);
    yield {type:'stream_event',event:{type:'message_start',message:{id:'stream-tool',model:'claude-opus-5-5',usage:{input_tokens:5,cache_creation_input_tokens:700,cache_read_input_tokens:900,output_tokens:1}}}};
    yield {type:'stream_event',event:{type:'message_delta',usage:{output_tokens:37}}};
    yield {type:'stream_event',event:{type:'message_stop'}};
    yield {type:'assistant',message:{id:'stream-tool',model:'claude-opus-5-5',usage:{input_tokens:5,cache_creation_input_tokens:700,cache_read_input_tokens:900,output_tokens:1},content:[{type:'tool_use',id:'stream-call',name:'mcp__caller-tools__lookup',input:{}}]}};
  }
  const result=await mod.invokeClaudeSDKWithTools([{role:'user',content:'lookup'}],tools,'required',model,'private-account',null,true,null,deps(query,[]),null,correlation);
  assert.equal(result.substationUsage.output,37);
  assert.equal(result.substationUsage.providers[0].usage_source,'provider_stream_terminal');
  assert.equal(result.substationUsage.usage_complete,true);
});

test('terminal SDK result lacking cache fields is not complete measured usage',async()=>{
  for (const usage of [{},{input_tokens:1,output_tokens:2}]) {
    async function* query(){yield {type:'result',usage,result:'ok'};}
    const result=await mod.invokeClaudeSDKWithTools([{role:'user',content:'lookup'}],tools,'auto',model,'private-account',null,true,null,deps(query,[]),null,correlation);
    assert.equal(result.substationUsage.cache_creation,null);assert.equal(result.substationUsage.cache_read,null);
    assert.equal(result.substationUsage.usage_complete,false);assert.equal(result.substationUsage.providers[0].usage_complete,false);
  }
});

test('actual SDK assistant-before-terminal tool ordering stays incomplete and immediate-abort',async()=>{
 let terminalSeen=false;
 async function* query(){
  yield {type:'stream_event',event:{type:'message_start',message:{id:'actual-order',model:'claude-opus-5-5',usage:{input_tokens:5,cache_creation_input_tokens:700,cache_read_input_tokens:900,output_tokens:0}}}};
  yield {type:'assistant',message:{id:'actual-order',model:'claude-opus-5-5',usage:{input_tokens:5,cache_creation_input_tokens:700,cache_read_input_tokens:900,output_tokens:0},content:[{type:'tool_use',id:'actual-order-tool',name:'mcp__caller-tools__lookup',input:{}}]}};
  terminalSeen=true;yield {type:'stream_event',event:{type:'message_delta',usage:{output_tokens:47}}};
 }
 const result=await mod.invokeClaudeSDKWithTools([{role:'user',content:'lookup'}],tools,'required',model,'private-account',null,true,null,deps(query,[]),null,correlation);
 assert.equal(terminalSeen,false);assert.equal(result.toolCalls[0].id,'actual-order-tool');assert.equal(result.substationUsage.output,0);assert.equal(result.substationUsage.usage_complete,false);
});
test('actual OpenAI fallback counters stay separate from unsupported Claude cache creation',()=>{
 const usage=mod.measuredOpenAIUsage({input_tokens:100,output_tokens:12,input_tokens_details:{cached_tokens:80}},'gpt-6-sol','private-account',1);
 assert.equal(usage.input,100);assert.equal(usage.output,12);assert.equal(usage.cache_read,80);assert.equal(usage.cache_creation,null);assert.equal(usage.provider_model,'gpt-6-sol');
 const combined=mod.combineMeasuredUsage({providers:[{input:3,output:2,cache_creation:7,cache_read:9,provider_model:'claude-opus-5-5',account_alias:'a'.repeat(64),usage_complete:false}]},usage);
 assert.equal(combined.input,103);assert.equal(combined.output,14);assert.equal(combined.cache_creation,null);assert.equal(combined.provider_model,null);assert.equal(combined.providers.length,2);
});

test('review initiator and parent turn transport accepts only bounded causal metadata',()=>{
 const headers={'x-hermes-usage-turn':'a'.repeat(32),'x-hermes-usage-call':'b'.repeat(32),'x-hermes-usage-session':'c'.repeat(64),'x-hermes-usage-initiator':'background_memory_review','x-hermes-usage-parent-turn':'d'.repeat(32)};
 const valid=mod.usageCorrelationFromHeaders(headers,'proxy');assert.equal(valid.initiator,'background_memory_review');assert.equal(valid.parent_turn,'d'.repeat(32));
 const invalid=mod.usageCorrelationFromHeaders({...headers,'x-hermes-usage-initiator':'PRIVATE PROMPT','x-hermes-usage-parent-turn':'telegram:PRIVATE'},'proxy');assert.equal(invalid.initiator,null);assert.equal(invalid.parent_turn,null);
});

test('terminal stream without actual served identity cannot declare complete zero usage',async()=>{
 const rows=[];
 async function* query(){
  yield {type:'system',subtype:'init',model:'claude-opus-5-5'};
  yield {type:'stream_event',event:{type:'message_start',message:{id:'synthetic-error',usage:{input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0}}}};
  yield {type:'stream_event',event:{type:'message_stop'}};
  yield {type:'result',is_error:true,subtype:'error_during_execution',usage:{input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0},result:'API Error'};
 }
 try{await mod.invokeClaudeSDKWithTools([{role:'user',content:'lookup'}],tools,'auto',model,'private-account',null,true,null,deps(query,rows),null,correlation);}catch{}
 const row=rows.find(r=>r.usage_source==='provider_stream_terminal');
 assert.ok(row);assert.equal(row.usage_complete,false);assert.equal(row.provider_model,null);assert.equal(row.input,null);
});
