import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import {invokeClaudeSDKWithTools,invokeWarmSummary} from '../src/index.js';

test('installed native SDK preserves provider tool schemas for a denied summary turn', {timeout:30000}, async()=>{
 const base=process.env.SUBSTATION_TEST_ROOT;
 assert.ok(base?.includes('/.hermes/heavy-outputs/WO-flex-substation-warm-cache-auto-handoff-2026-10-04/'));
 const dir=fs.mkdtempSync(path.join(base,'native-summary-'));
 const requests=[];const sentinel=path.join(dir,'MUST-NOT-EXIST');
 const server=http.createServer((req,res)=>{
  let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{
   if(!req.url.includes('/messages')){res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;}
   const body=JSON.parse(raw);requests.push(body);
   if(requests.length===3){
    const events=[['message_start',{type:'message_start',message:{id:'msg_denied_native',type:'message',role:'assistant',content:[],model:'claude-sonnet-5',stop_reason:null,stop_sequence:null,usage:{input_tokens:2,output_tokens:0}}}],['content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'toolu_denied_native',name:'Bash',input:{}}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({command:`touch '${sentinel}'`})}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:8}}],['message_stop',{type:'message_stop'}]];
    res.writeHead(200,{'Content-Type':'text/event-stream'});for(const[event,value]of events)res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);res.end();return;
   }
   const text='{"Status":"Owned offline summary"}',id=`msg_summary_${requests.length}`;
   const events=[['message_start',{type:'message_start',message:{id,type:'message',role:'assistant',content:[],model:'claude-sonnet-5',stop_reason:null,stop_sequence:null,usage:{input_tokens:2,cache_creation_input_tokens:3,cache_read_input_tokens:100,output_tokens:0,cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:3}}}}],['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:8}}],['message_stop',{type:'message_stop'}]];
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   for(const[event,value]of events)res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);res.end();
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const previous={};
 const settings={ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'sk-offline-fixture',CLAUDE_CONFIG_DIR:dir,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'};
 for(const[k,v]of Object.entries(settings)){previous[k]=process.env[k];process.env[k]=v;}
 const token={id:'native-summary-offline',token:'offline',activeRequests:0};
 const tools=[{type:'function',function:{name:'owned_lookup',parameters:{type:'object',properties:{}}}}];
 let summaryOptions;
 const deps={tokens:[token],sdkMod:{...sdk,query(args){if(args.options.hooks)summaryOptions=args.options;return sdk.query(args);}},z:{},markRequestStart(){},markSuccess(){},warmDispatchGuard:()=>true};
 const messages=[{role:'user',content:'Owned original context'}];
 try{
  const original=await invokeClaudeSDKWithTools(messages,tools,'auto',{modelId:'claude-sonnet-5'},token.id,null,true,null,deps);
  const account=createHash('sha256').update(token.id).digest('hex');
  const result=await invokeWarmSummary({session:'a'.repeat(64),generation:'b'.repeat(64),account,model:'claude-sonnet-5',prefix:'c'.repeat(64),messages:[...messages,{role:'assistant',content:original.text},{role:'user',content:'Write only a JSON handoff.'}],tools,handoffRequestId:'native-owned-summary',origin:'warm-handoff',summaryOnly:true,executeTools:false,notifications:false,tool_choice:'none'},deps);
  assert.equal(requests.length,2);
  assert.ok(requests[0].tools.some(t=>t.name==='Bash'),'fixture must include real native tools');
  assert.deepEqual(requests[1].tools,requests[0].tools,'summary must retain actual provider schemas');
  assert.deepEqual(requests[1].system,requests[0].system,'summary must retain actual provider system prefix');
  assert.equal(result.usage.provider_model,'claude-sonnet-5');
  assert.equal(result.usage.cache_read,100); // Synthetic counter: never a live cache claim.
  assert.equal(result.usage.usage_complete,true);
  let denied=0;
  const deny=summaryOptions.hooks.PreToolUse[0].hooks[0];
  const options={...summaryOptions,hooks:{PreToolUse:[{hooks:[async(...args)=>{denied++;return deny(...args);}]}]}};
  delete options.resume;
  const query=sdk.query({prompt:'Owned localhost native denial fixture',options});
  try{for await(const message of query){/* Consume the real CLI permission path. */}}
  catch(error){assert.match(error.message,/Reached maximum number of turns \(1\)/);}
  finally{await query.close();}
  assert.ok(denied>0,'real CLI must invoke denial hook under bypassPermissions');
  assert.equal(fs.existsSync(sentinel),false,'native Bash must never execute');
 }finally{
  for(const[k,v]of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;
  await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});
 }
});
