import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
const source=await import(process.env.NATIVE_SDK_CAPTURE_TEST_SOURCE || '../src/index.js');
async function replay(toolName,input={},ttl="5m",reject=false) {
let providerCalls=0,sentinelExecutions=0;const eventsObserved=[],rows=[],requests=[];
const server=http.createServer((req,res)=>{let text='';req.on('data',x=>text+=x);req.on('end',()=>{if(req.url.includes('/messages')){providerCalls++;const body=JSON.parse(text);const ttls=[],cacheMarkers=[];for(const group of ['tools','system','messages'])for(const [i,item] of (body[group]||[]).entries()){if(item.cache_control){ttls.push(item.cache_control.ttl||'5m');cacheMarkers.push({path:`${group}.${i}`,ttl:item.cache_control.ttl||'5m'});}for(const [j,block] of (Array.isArray(item.content)?item.content:[]).entries())if(block.cache_control){ttls.push(block.cache_control.ttl||'5m');cacheMarkers.push({path:`${group}.${i}.content.${j}`,ttl:block.cache_control.ttl||'5m'});}}let shorter=false;const invalid=ttls.some(t=>{if(t==='5m')shorter=true;return t==='1h'&&shorter;});requests.push({ttls,cacheMarkers,model:body.model,stream:body.stream,messages:body.messages?.length,tools:body.tools?.length,max_tokens:body.max_tokens,});if(invalid||reject){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'a ttl=1h cache_control block must not come after a ttl=5m cache_control block'}}));return;}res.writeHead(200,{'Content-Type':'text/event-stream'});const events=[['message_start',{type:'message_start',message:{id:'msg_tool_fixture',type:'message',role:'assistant',content:[],model:'claude-opus-5-5',stop_reason:null,stop_sequence:null,usage:{input_tokens:2,cache_creation_input_tokens:12345,cache_read_input_tokens:6789,output_tokens:0}}}],['content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'toolu_fixture',name:toolName,input:{}}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:47}}],['message_stop',{type:'message_stop'}]];for(const[e,v]of events)res.write(`event: ${e}\ndata: ${JSON.stringify(v)}\n\n`);res.end();}else{res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');}})});await new Promise(r=>server.listen(0,'127.0.0.1',r));
process.env.CLAUDE_CODE_PROMPT_CACHE_TTL=ttl;process.env.ANTHROPIC_BASE_URL=`http://127.0.0.1:${server.address().port}`;process.env.ANTHROPIC_API_KEY='sk-offline-fixture';process.env.CLAUDE_CONFIG_DIR=process.env.HOME;process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';process.env.DISABLE_TELEMETRY='1';process.env.DISABLE_ERROR_REPORTING='1';
const queryOptions=[];
const sdkMod={...sdk,tool(name,desc,shape,handler,options){return sdk.tool(name,desc,shape,async(...args)=>{sentinelExecutions++;return handler(...args);},options);},async *query(args){queryOptions.push({maxTurns:args.options.maxTurns,resume:args.options.resume});for await(const m of sdk.query(args)){eventsObserved.push(m.type==='stream_event'?'stream_event/'+m.event?.type:m.type);yield m;}}};
try {
 const result=await source.invokeClaudeSDKWithTools([{role:'user',content:'Find fixture'}],[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{}}}}],'auto',{modelId:'claude-opus-5-5'},'offline-fixture',null,true,null,{sdkMod,z:{},tokens:[{id:'offline-fixture',token:'offline-fixture',activeRequests:0}],markRequestStart(){},markSuccess(){},onUsageRow:r=>rows.push(r)},null,{turn:'a'.repeat(32),call:'b'.repeat(32),session:'c'.repeat(64),source:'user',proxy:'offline'});
 return {result,requests,providerCalls,sentinelExecutions,eventsObserved,queryOptions,rows};
} catch(error) {if(reject)return {error,requests,providerCalls};throw error;} finally {server.close();}
}
for(const ttl of ['5m','1h']) for (const [label,name,input] of [['caller MCP tool','mcp__caller-tools__lookup',{}],['first built-in Read compatibility','Read',{file_path:'/nonexistent-offline-fixture'}]]) {
 test(ttl+' '+label+' returns captured call without a second native inference turn',{timeout:10000},async()=>{
  const p=await replay(name,input,ttl);
  assert.equal(p.result.toolCalls.length,1);
  console.log(JSON.stringify({proof:'actual-native-cache-order',ttl,tool:name,providerCalls:p.providerCalls,sentinelExecutions:p.sentinelExecutions,requests:p.requests,real_provider_calls:0}));
  assert.equal(p.requests[0].ttls.length,4);
  assert.ok(p.requests[0].ttls.every(value=>value===ttl),'application and SDK-owned cache markers must respect existing TTL policy');
  assert.equal(p.result.toolCalls[0].function.name,name==='Read'?'Read':'lookup');
  assert.equal(p.result.toolCalls[0].id,'toolu_fixture');
  assert.equal(p.sentinelExecutions,0);
  assert.equal(p.providerCalls,1,'capture/abort must not race a second paid provider request');
  assert.equal(p.queryOptions[0].maxTurns,1);
  assert.equal(p.queryOptions[0].resume,undefined);
  assert.equal(p.result.substationUsage.cache_creation,12345);
  assert.equal(p.result.substationUsage.cache_read,6789);
  assert.equal(p.result.substationUsage.usage_complete,false,'real native assistant precedes terminal usage, so incomplete output must not be declared complete');
 });
}

test('native HTTP400 synthetic SDK error is not complete zero-cost provider usage',{timeout:10000},async()=>{
 const p=await replay('mcp__caller-tools__lookup',{},'1h',true);
 assert.match(p.error?.message||'',/API Error: 400/);
 assert.ok(p.providerCalls>=1);
 const u=p.error.substationUsage;
 assert.equal(u.usage_complete,false);assert.equal(u.provider_model,null);
 for(const key of ['input','output','cache_creation','cache_read'])assert.equal(u[key],null, key+' must be unknown without actual served provider identity');
});
