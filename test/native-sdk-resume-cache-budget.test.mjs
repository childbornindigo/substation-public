import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const isolatedHome = mkdtempSync(join(tmpdir(), 'substation-resume-fixture-'));
process.env.HOME = isolatedHome;
process.env.CLAUDE_CONFIG_DIR = isolatedHome;
test.after(() => rmSync(isolatedHome, {recursive:true, force:true}));
const source = await import(process.env.NATIVE_RESUME_TEST_SOURCE || '../src/index.js');
const cacheError = 'A maximum of 4 blocks with cache_control may be provided. Found 5.';
for (const ttl of ['5m', '1h']) test(`native ${ttl} exact injected resume400 retries fresh once, preserves history and captured-action guard`, {timeout:20000}, async () => {
  let stage = 0, sentinel = 0;
  const requests = [], queries = [], sessions = [], prompts = [], usageRows = [], closed = [];
  const server = http.createServer((req,res) => {
    let raw=''; req.on('data',x=>raw+=x); req.on('end',()=> {
      if (!req.url.includes('/messages')) {res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;}
      const body = JSON.parse(raw), markers=[];
      for (const group of ['tools','system','messages']) for (const [i,item] of (body[group]||[]).entries()) {
        if(item.cache_control) markers.push({path:`${group}.${i}`,ttl:item.cache_control.ttl||'5m'});
        for(const[j,b]of(Array.isArray(item.content)?item.content:[]).entries()) if(b.cache_control) markers.push({path:`${group}.${i}.content.${j}`,ttl:b.cache_control.ttl||'5m'});
      }
      if(body.cache_control)markers.push({path:'cache_control',ttl:body.cache_control.ttl||'5m'});
      requests.push({stage,markers,body});
      const reject = stage===4;
      let short=false;
      const badOrder=markers.some(m=>{if(m.ttl==='5m')short=true;return short&&m.ttl==='1h';});
      if(reject || markers.length>4 || badOrder) {
        res.writeHead(400,{'Content-Type':'application/json'});
        res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:reject?cacheError:'native cache boundary validation failed'}}));return;
      }
      const tool=stage===5, block=tool?{type:'tool_use',id:'toolu_recovery_fixture',name:'mcp__caller-tools__lookup',input:{}}:{type:'text',text:''};
      const events=[['message_start',{type:'message_start',message:{id:`msg_resume_${stage}`,type:'message',role:'assistant',content:[],model:'claude-opus-5-5',stop_reason:null,stop_sequence:null,usage:{input_tokens:2,cache_creation_input_tokens:123,cache_read_input_tokens:456,output_tokens:0}}}],['content_block_start',{type:'content_block_start',index:0,content_block:block}],['content_block_delta',{type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:'{}'}:{type:'text_delta',text:stage<5?'ready':'done'}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:7}}],['message_stop',{type:'message_stop'}]];
      res.writeHead(200,{'Content-Type':'text/event-stream'}); for(const[e,v]of events)res.write(`event: ${e}\ndata: ${JSON.stringify(v)}\n\n`);res.end();
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  Object.assign(process.env,{CLAUDE_CODE_PROMPT_CACHE_TTL:ttl,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'sk-offline-fixture',CLAUDE_CONFIG_DIR:process.env.HOME,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'});
  const sdkMod={...sdk,tool(name,desc,shape,handler,opt){return sdk.tool(name,desc,shape,async(...args)=>{sentinel++;return handler(...args);},opt);},query(args){
    stage++; const current=stage;if(stage===5)assert.ok(closed.includes(4),'failed native query closed before fresh recovery');queries.push({stage:current,resume:args.options.resume,model:args.options.model,token:args.options.env.CLAUDE_CODE_OAUTH_TOKEN,maxTurns:args.options.maxTurns,systemPrompt:args.options.systemPrompt,permissionMode:args.options.permissionMode});
    let prompt=args.prompt;
    if(typeof prompt==='string')prompts.push({stage:current,string:prompt});
    else {const input=prompt;prompt=(async function*(){for await(const m of input){prompts.push({stage:current,message:m.message});yield m;}})();}
    const native=sdk.query({...args,prompt});const iter=(async function*(){for await(const m of native){if(m.type==='system'&&m.subtype==='init')sessions.push({stage:current,id:m.session_id});yield m;}})();iter.close=async()=>{await native.close();closed.push(current);};return iter;
  }};
  const tools=[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{}}}}],model={modelId:'claude-opus-5-5'};
  const token={id:`resume-recovery-fixture-${ttl}`,token:'offline',activeRequests:0};const deps={sdkMod,z:{},tokens:[token],markRequestStart(){},markSuccess(){},onUsageRow(row){usageRows.push(row);}};
  const invoke=(history,choice='auto')=>source.invokeClaudeSDKWithTools(history,tools,choice,model,token.id,null,true,null,deps,null,{turn:"fixture-turn",call:"fixture-call",session:"fixture-session"});
  let history=[{role:'user',content:'Offline initial history'}];
  try {
    assert.equal((await invoke(history)).text,'ready');
    for(const content of ['First legitimate continuation','Second legitimate continuation']) {
      history=[...history,{role:'assistant',content:'ready'},{role:'user',content}];assert.equal((await invoke(history)).text,'ready');
    }
    const firstID=sessions.find(s=>s.stage===1).id;
    assert.equal(queries[1].resume,firstID);assert.equal(queries[2].resume,firstID);
    assert.equal(sessions.find(s=>s.stage===2).id,firstID);assert.equal(sessions.find(s=>s.stage===3).id,firstID);
    history=[...history,{role:'assistant',content:'ready'},{role:'user',content:'Call lookup exactly once'}];
    const recovered=await invoke(history,'required');
    assert.equal(recovered.toolCalls.length,1);assert.equal(recovered.toolCalls[0].id,'toolu_recovery_fixture');assert.deepEqual(recovered.toolCalls[0].function,{name:'lookup',arguments:'{}'});
    assert.equal(queries[3].resume,firstID);assert.equal(queries[4].resume,undefined);
    const retryStarts=usageRows.filter(r=>r.event==='sdk_start').slice(-2);assert.deepEqual(retryStarts.map(r=>[r.sdk_attempt,r.resumed]),[[1,true],[2,false]]);assert.equal(retryStarts[0].sdk_request,retryStarts[1].sdk_request);assert.equal(retryStarts[0].account_alias,retryStarts[1].account_alias);
    const rejected=recovered.substationUsage.providers.find(p=>p.provider_model===null);assert.ok(rejected);for(const key of ['input','output','cache_creation','cache_read'])assert.equal(rejected[key],null);assert.equal(rejected.usage_complete,false);assert.ok(recovered.substationUsage.providers.some(p=>p.provider_model==='claude-opus-5-5'&&p.cache_creation===123));
    const expected=source.formatStableMessagesForSDK(history,'\n\nYou MUST call one of the provided tools to respond.',ttl);
    assert.deepEqual(prompts.find(p=>p.stage===5).message,{role:'user',content:expected},'recovery must send full original history via unchanged fresh formatter');
    for(const q of queries.slice(1)){assert.equal(q.model,queries[0].model);assert.equal(q.token,queries[0].token);assert.equal(q.maxTurns,1);assert.equal(q.permissionMode,queries[0].permissionMode);assert.deepEqual(q.systemPrompt,queries[0].systemPrompt);}
    history=[...history,{role:'assistant',content:null,tool_calls:recovered.toolCalls},{role:'tool',tool_call_id:recovered.toolCalls[0].id,name:'lookup',content:'caller performed once'},{role:'user',content:'Finish'}];
    assert.equal((await invoke(history)).text,'done');assert.equal(queries[5].resume,undefined,'never resume a captured/aborted tool session');
    assert.equal(queries.length,6);assert.equal(sentinel,0);
    for(const r of requests.filter(r=>r.stage!==4)){assert.ok(r.markers.length<=4);assert.ok(r.markers.every(m=>m.ttl===ttl));}
    assert.equal(requests.filter(r=>r.stage===5).length,1);assert.equal(requests.filter(r=>r.stage===6).length,1);
    console.log(JSON.stringify({proof:'actual-native-injected-provider400-recovery-contract',ttl,production_fifth_marker_reproduced:false,queries:queries.map(q=>({stage:q.stage,resumed:Boolean(q.resume)})),requests:requests.map(({stage,markers})=>({stage,markers,fault_injected:stage===4})),same_model_account:true,full_history_preserved:true,sentinel_executions:sentinel}));
  } finally {server.close();}
});
