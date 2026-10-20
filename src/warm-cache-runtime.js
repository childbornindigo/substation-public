/** Staged SDK runtime: no inference unless an owned explicit configuration enables it. */
import {lstatSync,readFileSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createConnection} from 'node:net';
import {randomBytes,randomUUID} from 'node:crypto';
import {WarmCacheHandoff,DurableStateStore,validateOwnedPath} from './warm-cache-handoff.js';
import {AtomicSectionWriter,createSummaryAdapter} from './warm-cache-targets.js';
export const warmHash=v=>createHash('sha256').update(String(v)).digest('hex');
function readOwnedJSON(path,bound){const before=validateOwnedPath(path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=fstatSync(fd);if(st.dev!==before.dev||st.ino!==before.ino||st.mode&0o077||st.size>bound)throw Error('private bounded metadata required');const bytes=readFileSync(fd,'utf8');const after=validateOwnedPath(path);if(after.dev!==st.dev||after.ino!==st.ino||after.mtimeMs!==st.mtimeMs||after.size!==st.size)throw Error('metadata changed during read');return JSON.parse(bytes);}finally{closeSync(fd);}}
export function readWarmConfig(path){
 try{const c=readOwnedJSON(path,65536);if(c.version!==1||typeof c.enabled!=='boolean'||!c.destinations||Array.isArray(c.destinations)||typeof c.destinations!=='object'||Object.keys(c.destinations).length>8||(c.marginMs!==undefined&&(!Number.isSafeInteger(c.marginMs)||c.marginMs<=0)))return null;return c;}catch{return null;}
}
export class SdkWarmRuntime{
 constructor({directory,invoke,probe,clock,store,lifecycle=readGatewayLifecycle}){
  this.lifecycle=lifecycle;this.directory=directory;this.invoke=invoke;this.probe=probe;this.contexts=new Map();this.configPath=join(directory,'warm-cache-handoff-config.json');this.store=store;this.clock=clock;this.controller=null;this.running=false;
 }
 config(){return readWarmConfig(this.configPath);}
 ensure(){
  if(this.controller)return this.controller;
  if(!this.config())return null;
  const self=this;
  const controller=new WarmCacheHandoff({store:this.store||new DurableStateStore(join(this.directory,'warm-cache-session-state.json')),clock:this.clock,enabled:false,
   probe:r=>self.probe(r),summarize:createSummaryAdapter({getContext:r=>self.context(r),prepare:r=>self.writer(r).prepare(r),invoke:i=>{if(self.config()?.enabled!==true)throw Error('handoff disabled before dispatch');return self.invoke(i);}}),write:(r,result)=>self.writer(r).write(r,result)});
  Object.defineProperty(controller,'enabled',{get:()=>self.config()?.enabled===true});
  Object.defineProperty(controller,'marginMs',{get:()=>self.config()?.marginMs??600000});this.controller=controller;return controller;
 }
 writer(record){const c=this.config();if(!c)throw Error('handoff disabled');const lifecycle=this.lifecycle();if(!lifecycle||lifecycle.sessions?.[record.session]?.generation!==record.generation)throw Error('gateway generation unavailable');return new AtomicSectionWriter({root:c.root,destinations:{...c.destinations,[record.session]:{...c.destinations[record.session],generation:record.generation}}});}
 context(record){const c=this.config(),ctx=this.contexts.get(record.session);if(!c||!c.destinations[record.session]||this.lifecycle()?.sessions?.[record.session]?.generation!==record.generation||!ctx||!['generation','account','model','prefix'].every(k=>ctx[k]===record[k]))throw Error('registered context unavailable');return structuredClone(ctx);}
 started({correlation,messages,tools,model,token,requestId,startedAt}){
  if(correlation?.initiator==='warm_cache_handoff')return null;
  const c=this.config(),entry=c?.destinations?.[correlation?.session];if(!entry)return null;
  const observed=this.lifecycle()?.sessions?.[correlation.session];if(!observed||observed.turn!==correlation.turn||observed.source!==correlation.source||observed.state!=='busy'||(entry.generation&&entry.generation!==observed.generation))return null;
  const context={requestId,requestIdentity:randomUUID(),lastUserTurn:correlation.turn,session:correlation.session,generation:observed.generation,account:warmHash(token.id),model,prefix:warmHash(JSON.stringify({messages,tools})),messages:structuredClone(messages),tools:structuredClone(tools||[])};
  if(Buffer.byteLength(JSON.stringify(context))>8*1024*1024)return null;
  const controller=this.ensure();if(!controller?.requestStarted({...context,turn:correlation.turn,source:correlation.source,requestId,startedAt}))return null;
  this.contexts.set(context.session,context);return Object.fromEntries(['session','requestId','requestIdentity','generation','account','model','prefix'].map(k=>[k,context[k]]));
 }
 finished(handle,usage,outcome,result){if(!handle)return;const h=this.controller;if(!h)return;const ctx=this.contexts.get(handle.session);if(!ctx||!['requestId','requestIdentity','generation','account','model','prefix'].every(k=>ctx[k]===handle[k]))return false;const current=h.status().sessions.find(r=>r.session===handle.session);if(!current||!['requestId','generation','account','model','prefix'].every(k=>current[k]===handle[k]))return false;const complete=outcome==='ok'&&typeof result?.text==='string'&&result.text.length>0&&!(result.toolCalls?.length);if(complete&&ctx)ctx.messages.push({role:'assistant',content:result.text});h.observeUsage(handle.session,handle.requestId,{...(usage?.usage_complete===true?usage:{}),account:usage?.account_alias});h.requestFinished(handle.session,handle.requestId,complete?'ok':'incomplete-or-tool-turn');}
 async tick(){if(this.controller)for(const [session,abort]of this.controller.inflight){const ctx=this.contexts.get(session);if(this.config()?.enabled!==true||!ctx||(await this.probe(ctx))?.idle!==true)abort.abort();}if(this.running||this.config()?.enabled!==true)return {state:'disabled-or-busy',attempts:[]};this.running=true;try{return await this.ensure().tick();}finally{this.running=false;}}
 clear(session){this.contexts.delete(session);this.controller?.clear(session);}
}

// Existing turn_end proves model-loop completion only. It precedes delivery and
// pending-input drain: it MUST NOT be promoted into idle authority.
export function readGatewayLifecycle({path=join(homedir(),'.hermes','state','warm-cache-lifecycle.json'),now=Date.now(),processStart=pid=>execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000}).trim()}={}){
 try{
  const v=readOwnedJSON(path,512*1024);
  if(v.version!==1||!Number.isSafeInteger(v.gateway_pid)||v.gateway_pid<=0||!/^[a-f0-9]{32}$/.test(v.gateway_incarnation)||typeof v.gateway_process_start!=='string'||!v.gateway_process_start||processStart(v.gateway_pid)!==v.gateway_process_start||!Number.isFinite(v.emitted_at_ms)||v.emitted_at_ms>now||now-v.emitted_at_ms>30000||!v.sessions||Object.keys(v.sessions).length>128)return null;
  return v;
 }catch{return null;}
}
export function lifecycleIdleFromSnapshot(record,v,now){
 const row=v?.sessions?.[record.session];
 if(!row||row.generation!==record.generation||row.turn!==record.lastUserTurn||row.state!=='idle'||row.source!=='user'||!Number.isSafeInteger(row.run_generation)||row.generation!==warmHash(v.gateway_incarnation+':'+row.run_generation)||!Number.isFinite(row.observed_at_ms)||row.observed_at_ms>now||now-row.observed_at_ms>30000||!['pendingInput','running','clarify','draining','approval','deliveryPending','background'].every(k=>row[k]===false))return null;
 return {session:record.session,generation:record.generation,idle:true,pendingInput:false};
}

export async function probeLifecycleIdle(record,options={}){
 const path=options.path||join(homedir(),'.hermes','state','warm-cache-lifecycle.json');
 const initial=readGatewayLifecycle({...options,path});if(!initial)return null;
 const expected=join(dirname(path),`warm-cache-lifecycle-${initial.gateway_pid}-${initial.gateway_incarnation}.sock`);
 if(initial.socket_path!==expected)return null;
 try{
  validateOwnedPath(dirname(expected),{directory:true});const before=lstatSync(expected);
  if(!before.isSocket()||before.uid!==process.getuid()||before.mode&0o077||before.nlink!==1)return null;
  const nonce=randomBytes(16).toString('hex');
  const reply=await new Promise((resolve)=>{
   const socket=(options.connect||createConnection)(expected);let bytes='',done=false;
   const finish=v=>{if(done)return;done=true;socket.destroy();resolve(v);};
   socket.setTimeout(1000,()=>finish(null));socket.on('error',()=>finish(null));socket.on('connect',()=>socket.write(JSON.stringify({version:1,nonce,session:record.session,generation:record.generation})+'\n'));
   socket.on('data',chunk=>{bytes+=chunk.toString('utf8');if(Buffer.byteLength(bytes)>65536)return finish(null);if(bytes.includes('\n')){try{if(bytes.slice(bytes.indexOf('\n')+1).trim())return finish(null);finish(JSON.parse(bytes.slice(0,bytes.indexOf('\n'))));}catch{finish(null);}}});socket.on('end',()=>finish(null));
  });
  const after=lstatSync(expected),now=options.now??Date.now();
  if(after.dev!==before.dev||after.ino!==before.ino||!reply||reply.nonce!==nonce||reply.gateway_pid!==initial.gateway_pid||reply.gateway_incarnation!==initial.gateway_incarnation||reply.gateway_process_start!==initial.gateway_process_start||reply.version!==1||!Number.isFinite(reply.emitted_at_ms)||reply.emitted_at_ms>now||now-reply.emitted_at_ms>30000)return null;
  return lifecycleIdleFromSnapshot(record,reply,now);
 }catch{return null;}
}
