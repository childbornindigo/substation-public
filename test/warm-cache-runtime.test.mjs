import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {SdkWarmRuntime,readGatewayLifecycle,probeLifecycleIdle,lifecycleIdleFromSnapshot,warmHash} from '../src/warm-cache-runtime.js';
import {MemoryStateStore} from '../src/warm-cache-handoff.js';
const base=process.env.SUBSTATION_TEST_ROOT;
if(!base||!base.includes('/.hermes/heavy-outputs/WO-flex-substation-warm-cache-auto-handoff-2026-10-04/'))throw Error('governed fixtures required');
const session='a'.repeat(64),turn='b'.repeat(32),incarnation='c'.repeat(32),generation=warmHash(incarnation+':1'),account=warmHash('offline-token');
function fixture(){const dir=fs.mkdtempSync(path.join(base,'runtime-'));return{dir,cleanup:()=>fs.rmSync(dir,{recursive:true})};}
test('configured margin reaches controller and invalid configuration holds',async()=>{
 const x=fixture();try{
 const configPath=path.join(x.dir,'warm-cache-handoff-config.json');
 fs.writeFileSync(configPath,JSON.stringify({version:1,enabled:false,marginMs:120000,root:path.join(x.dir,'.hermes/workspace/memory/active'),destinations:{}}),{mode:0o600});
 const runtime=new SdkWarmRuntime({directory:x.dir,store:new MemoryStateStore(),probe:()=>null});
 assert.equal(runtime.ensure().marginMs,120000);
 fs.writeFileSync(configPath,JSON.stringify({version:1,enabled:false,marginMs:-1,destinations:{}}),{mode:0o600});
 assert.equal(runtime.config(),null);
 }finally{x.cleanup();}
});
test('registered observation works with inference OFF and includes completed assistant response',async()=>{
 const x=fixture();try{
 const config={version:1,enabled:false,root:path.join(x.dir,'.hermes/workspace/memory/active'),destinations:{[session]:{path:path.join(x.dir,'handoff.md')}}};fs.writeFileSync(path.join(x.dir,'warm-cache-handoff-config.json'),JSON.stringify(config),{mode:0o600});
 const state=new MemoryStateStore();let invoked=0;
 const runtime=new SdkWarmRuntime({directory:x.dir,store:state,invoke:()=>{invoked++;},probe:()=>null,lifecycle:()=>({sessions:{[session]:{state:'busy',turn,generation,source:'user'}}})});
 const messages=[{role:'user',content:'owned original task'}],handle=runtime.started({correlation:{session,turn,source:'user'},messages,tools:[],model:'claude-sonnet-5',token:{id:'offline-token'},requestId:'r',startedAt:Date.now()});
 assert.ok(handle);runtime.finished(handle,{provider_model:'claude-sonnet-5',account_alias:account,usage_complete:true,cache_creation_5m:0,cache_creation_1h:10},'ok',{text:'Finished actual latest task'});
 assert.equal(state.state.sessions[session].ttlMs,3600000);assert.equal(runtime.contexts.get(session).messages.at(-1).content,'Finished actual latest task');assert.deepEqual(messages,[{role:'user',content:'owned original task'}]);await runtime.tick();assert.equal(invoked,0);
 runtime.finished(handle,{provider_model:'claude-sonnet-5',account_alias:account,usage_complete:true,cache_creation_5m:0,cache_creation_1h:10},'ok',{text:'tool requested',toolCalls:[{}]});assert.equal(state.state.sessions[session].ttlMs,null);
 }finally{x.cleanup();}
});
test('authoritative lifecycle requires fresh process incarnation, exact turn and all explicit idle flags',()=>{
 const x=fixture();try{
 const file=path.join(x.dir,'lifecycle.json'),now=1000000;const row={generation,run_generation:1,turn,state:'idle',source:'user',observed_at_ms:now,pendingInput:false,running:false,clarify:false,draining:false,approval:false,deliveryPending:false,background:false};
 const snapshot={version:1,gateway_pid:99,gateway_incarnation:incarnation,gateway_process_start:'owned-start',emitted_at_ms:now,sessions:{[session]:row}};
 const save=()=>fs.writeFileSync(file,JSON.stringify(snapshot),{mode:0o600});save();const options={path:file,now,processStart:()=> 'owned-start'},record={session,generation,lastUserTurn:turn};
 assert.equal(lifecycleIdleFromSnapshot(record,readGatewayLifecycle(options),now)?.idle,true);assert.equal(readGatewayLifecycle({...options,processStart:()=> 'different'}),null);assert.equal(lifecycleIdleFromSnapshot({...record,lastUserTurn:'d'.repeat(32)},readGatewayLifecycle(options),now),null);
 for(const k of ['pendingInput','running','clarify','draining','approval','deliveryPending','background']){row[k]=true;save();assert.equal(lifecycleIdleFromSnapshot(record,readGatewayLifecycle(options),now),null);row[k]=false;}
 row.observed_at_ms=now-30001;save();assert.equal(lifecycleIdleFromSnapshot(record,readGatewayLifecycle(options),now),null);row.observed_at_ms=now;save();fs.chmodSync(file,0o644);assert.equal(readGatewayLifecycle(options),null);
 }finally{x.cleanup();}
});
test('live owner socket supersedes stale idle file and unavailable/failed publication holds',async()=>{
 const {createServer,createConnection}=await import('node:net');const x=fixture(),cwd=process.cwd();let server;
 try{
 process.chdir(x.dir);const now=Date.now(),pid=process.pid,basename=`warm-cache-lifecycle-${pid}-${incarnation}.sock`,socketPath=path.join(x.dir,basename),file=path.join(x.dir,'lifecycle.json');
 const row={generation,run_generation:1,turn,source:'user',state:'idle',observed_at_ms:now,pendingInput:false,running:false,clarify:false,draining:false,approval:false,deliveryPending:false,background:false};
 const snapshot={version:1,gateway_pid:pid,gateway_incarnation:incarnation,gateway_process_start:'owned-start',emitted_at_ms:now,socket_path:socketPath,sessions:{[session]:row}};fs.writeFileSync(file,JSON.stringify(snapshot),{mode:0o600});let held=false;
 server=createServer(socket=>socket.once('data',bytes=>{const request=JSON.parse(bytes.toString());assert.equal(request.session,session);assert.equal(request.generation,generation);socket.end(JSON.stringify({...snapshot,nonce:request.nonce,sessions:{[session]:{...row,state:held?'held':'idle'}}})+'\n');}));await new Promise(resolve=>server.listen(basename,resolve));fs.chmodSync(socketPath,0o600);
 const options={path:file,now,processStart:()=> 'owned-start',connect:()=>createConnection(basename)},record={session,generation,lastUserTurn:turn};assert.equal((await probeLifecycleIdle(record,options))?.idle,true);
 held=true;assert.equal(await probeLifecycleIdle(record,options),null);await new Promise(resolve=>server.close(resolve));server=null;assert.equal(await probeLifecycleIdle(record,options),null);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));process.chdir(cwd);x.cleanup();}
});

test('overlapping stale completion cannot contaminate newest context or establish its cache',()=>{
 const x=fixture();try{
 fs.writeFileSync(path.join(x.dir,'warm-cache-handoff-config.json'),JSON.stringify({version:1,enabled:false,root:path.join(x.dir,'.hermes/workspace/memory/active'),destinations:{[session]:{path:path.join(x.dir,'handoff.md')}}}),{mode:0o600});
 const state=new MemoryStateStore(),runtime=new SdkWarmRuntime({directory:x.dir,store:state,probe:()=>null,lifecycle:()=>({sessions:{[session]:{state:'busy',turn,generation,source:'user'}}})});
 const start=(requestId,text)=>runtime.started({correlation:{session,turn,source:'user'},messages:[{role:'user',content:text}],tools:[],model:'claude-sonnet-5',token:{id:'offline-token'},requestId,startedAt:Date.now()});
 const a=start('A','Task A'),b=start('B','Task B'),usage={provider_model:'claude-sonnet-5',account_alias:account,usage_complete:true,cache_creation_5m:0,cache_creation_1h:10};
 runtime.finished(a,usage,'ok',{text:'OLD_RESPONSE_A'});assert.equal(state.state.sessions[session].ttlMs,null);assert.equal(state.state.sessions[session].busy,true);assert.deepEqual(runtime.contexts.get(session).messages,[{role:'user',content:'Task B'}]);
 runtime.finished(b,usage,'ok',{text:'NEW_RESPONSE_B'});assert.deepEqual(runtime.contexts.get(session).messages,[{role:'user',content:'Task B'},{role:'assistant',content:'NEW_RESPONSE_B'}]);assert.equal(state.state.sessions[session].ttlMs,3600000);
 }finally{x.cleanup();}
});
