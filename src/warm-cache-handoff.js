/** Metadata-only warm-cache lifecycle. Importing never enables inference. */
import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,fstatSync,closeSync,readFileSync,writeFileSync,fsyncSync,lstatSync,renameSync,unlinkSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
const hash=value=>createHash('sha256').update(value).digest('hex');
const HEX=/^[a-f0-9]{64}$/;
const clean=value=>JSON.parse(JSON.stringify(value));
export const defaultClock=()=>({wall:Date.now(),mono:Number(process.hrtime.bigint()/1000000n)});
export function effectiveCacheTTL(usage){
 const five=usage?.cache_creation_5m, hour=usage?.cache_creation_1h;
 if(!Number.isSafeInteger(five)||five<0||!Number.isSafeInteger(hour)||hour<0)return null;
 if(five>0&&hour===0)return 300000;
 if(hour>0&&five===0)return 3600000;
 return null; // mixed markers, no write provenance, or overage ambiguity
}
export function validateOwnedPath(path,{directory=false}={}){
 const absolute=resolve(path);if(absolute!==path)throw Error('noncanonical owned path');
 const chain=[];for(let p=absolute;;p=dirname(p)){chain.push(p);if(p===dirname(p))break;}
 for(const p of chain.reverse()){
  const st=lstatSync(p);if(st.isSymbolicLink())throw Error('owned path alias refused');
  if(p!==absolute&&!st.isDirectory())throw Error('owned path ancestor is not directory');
  if(p===absolute&&(st.uid!==process.getuid()||(directory?!st.isDirectory():!st.isFile()||st.nlink!==1)))throw Error('owned path identity refused');
 }
 return lstatSync(absolute);
}
export class DurableStateStore{
 constructor(path){this.path=resolve(path);this.parent=dirname(this.path);this.parentIdentity=validateOwnedPath(this.parent,{directory:true});}
 checkParent(){const now=validateOwnedPath(this.parent,{directory:true});if(now.dev!==this.parentIdentity.dev||now.ino!==this.parentIdentity.ino)throw Error('warm state parent changed');}
 transaction(fn){
  this.checkParent();const lock=this.path+'.lock';let fd;
  try{fd=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}catch{throw Error('warm state already claimed or uncertain');}
  const lockIdentity=fstatSync(fd),nonce=randomUUID();writeFileSync(fd,nonce);let tmp;
  try{
   fsyncSync(fd);this.syncParent();let original=null;
   try{const st=validateOwnedPath(this.path);if(st.size>512*1024)throw Error('warm state input bound exceeded');original=readFileSync(this.path);}catch(e){if(e.code!=='ENOENT')throw e;}
   const state=original?JSON.parse(original):{version:1,sessions:{}};
   if(state.version!==1||!state.sessions||typeof state.sessions!=='object'||Array.isArray(state.sessions)||Object.keys(state.sessions).length>128)throw Error('warm state schema invalid');
   const result=fn(state);const bytes=Buffer.from(JSON.stringify(state));if(bytes.length>512*1024)throw Error('warm metadata bound exceeded');
   if(original){validateOwnedPath(this.path);if(hash(readFileSync(this.path))!==hash(original))throw Error('warm state changed outside lock');}
   else{try{lstatSync(this.path);throw Error('warm state appeared outside lock');}catch(e){if(e.code!=='ENOENT')throw e;}}
   this.checkParent();tmp=this.path+'.pending-'+randomUUID();const out=openSync(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   try{writeFileSync(out,bytes);fsyncSync(out);}finally{closeSync(out);}
   this.checkParent();renameSync(tmp,this.path);tmp=null;this.syncParent();return result;
  }finally{
   // Only the exact owned lock is removed; failed pending metadata is retained.
   closeSync(fd);this.checkParent();const final=validateOwnedPath(lock);if(final.dev!==lockIdentity.dev||final.ino!==lockIdentity.ino||readFileSync(lock,'utf8')!==nonce)throw Error('warm lock identity changed; replacement retained');unlinkSync(lock);this.syncParent();
  }
 }
 syncParent(){const fd=openSync(this.parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
}
export class MemoryStateStore{
 constructor(){this.state={version:1,sessions:{}};}
 transaction(fn){const draft=clean(this.state);const result=fn(draft);this.state=draft;return result;}
}
export class WarmCacheHandoff{
 constructor({store=new MemoryStateStore(),clock=defaultClock,enabled=false,marginMs=600000,probe=()=>null,summarize,write}={}){
  if(!Number.isSafeInteger(marginMs)||marginMs<=0)throw Error('positive margin required');
  this.inflight=new Map();this.store=store;this.clock=clock;this.enabled=enabled===true;this.marginMs=marginMs;this.probe=probe;this.summarize=summarize;this.write=write;
 }
 requestStarted(event){
  const {session,generation,requestId,turn,source,startedAt,account,model,prefix}=event;
  if(![session,generation,account,prefix].every(x=>typeof x==='string'&&HEX.test(x))||typeof requestId!=='string'||requestId.length>100||!Number.isFinite(startedAt)||!/^[-a-zA-Z0-9._]{1,100}$/.test(model))return false;
  const now=this.clock();if(startedAt>now.wall)return false;
  this.inflight.get(session)?.abort();
  this.store.transaction(state=>{
   let row=state.sessions[session];const rotated=!row||row.generation!==generation;
   if(rotated){if(!row&&Object.keys(state.sessions).length>=128)throw Error('session metadata limit');row={session,generation,epoch:0,claimed:null,lastUserTurn:null};}
   const genuine=source==='user'&&typeof turn==='string'&&/^[a-f0-9]{32}$/.test(turn)&&turn!==row.lastUserTurn;
   if(genuine){row.epoch++;row.claimed=null;row.lastUserTurn=turn;}
   row.armed=genuine||(!rotated&&row.armed===true&&source==='user'&&turn===row.lastUserTurn);
   Object.assign(row,{requestId,startedAt,account,model,prefix,busy:true,ttlMs:null,expiresAt:null,observedWall:now.wall,observedMono:now.mono,source:source||'unclassified',outcome:null});state.sessions[session]=row;
  });return true;
 }
 observeUsage(session,requestId,usage){
  const now=this.clock();return this.store.transaction(state=>{
   const row=state.sessions[session];if(!row||row.requestId!==requestId)return false;
   const rollback=now.wall<row.observedWall||now.mono<row.observedMono;
   const ttl=rollback?null:effectiveCacheTTL(usage);
   row.ttlMs=usage?.provider_model===row.model&&usage?.account===row.account?ttl:null;
   row.expiresAt=row.ttlMs?row.startedAt+row.ttlMs:null;
   row.expiresMono=row.expiresAt?now.mono+Math.max(0,row.expiresAt-now.wall):null;
   row.observedWall=now.wall;row.observedMono=now.mono;
   row.cacheRead=Number.isSafeInteger(usage?.cache_read)&&usage.cache_read>=0?usage.cache_read:null;
   row.ttlEvidence=row.ttlMs?'provider_ephemeral_creation':'unknown';return Boolean(row.ttlMs);
  });
 }
 requestFinished(session,requestId,outcome='ok'){
  return this.store.transaction(state=>{const row=state.sessions[session];if(!row||row.requestId!==requestId)return false;row.busy=false;row.outcome=outcome;if(outcome!=='ok'){row.ttlMs=null;row.expiresAt=null;}return true;});
 }
 clear(session){this.inflight.get(session)?.abort();this.store.transaction(state=>{delete state.sessions[session];});}
 status(){return this.store.transaction(state=>({enabled:this.enabled,version:1,sessions:Object.values(state.sessions).map(row=>clean(row))}));}
 warm(row,now){return row.ttlMs&&row.outcome==='ok'&&!row.busy&&now.wall>=row.observedWall&&now.mono>=row.observedMono&&now.wall<row.expiresAt&&now.mono<row.expiresMono;}
 due(row,now){const margin=Math.min(this.marginMs*(row.ttlMs/3600000),row.ttlMs-1);return row.armed===true&&this.warm(row,now)&&now.wall>=row.expiresAt-margin;}
 same(a,b){return a&&b&&['session','generation','epoch','requestId','account','model','prefix','startedAt'].every(key=>a[key]===b[key]);}
 async tick(){
  if(!this.enabled)return {state:'disabled',attempts:[]};
  if(typeof this.summarize!=='function'||typeof this.write!=='function')return {state:'adapter-unavailable',attempts:[]};
  const rows=this.status().sessions;const attempts=[];
  for(const snapshot of rows){
   const now=this.clock();if(snapshot.claimed||snapshot.epoch<1||!this.due(snapshot,now))continue;
   const quiet=await this.probe(clean(snapshot));if(!this.enabled||!quiet||quiet.session!==snapshot.session||quiet.generation!==snapshot.generation||quiet.idle!==true||quiet.pendingInput!==false)continue;
   const claim=randomUUID();const admitted=this.store.transaction(state=>{const row=state.sessions[snapshot.session];if(!this.enabled||!this.same(row,snapshot)||row.claimed||!this.due(row,this.clock()))return false;row.claimed={id:claim,epoch:row.epoch,state:'attempted'};return true;});
   if(!admitted)continue;const abort=new AbortController();this.inflight.set(snapshot.session,abort);const attempt={session:snapshot.session,claim,state:'attempted'};attempts.push(attempt);
   try{
    if(!this.enabled)throw Error('handoff disabled before inference');
    const result=await this.summarize(clean(snapshot),{signal:abort.signal});let fresh=this.status().sessions.find(row=>row.session===snapshot.session);
    if(!this.enabled||!this.same(fresh,snapshot)||fresh.claimed?.id!==claim||!this.warm(fresh,this.clock()))throw Error('session/cache changed during handoff');
    if(!result||!result.pins||!['session','generation','account','model','prefix'].every(key=>result.pins[key]===snapshot[key])||!Number.isSafeInteger(result.usage?.cache_read)||result.usage.cache_read<=0)throw Error('handoff warm usage/pins unconfirmed');
    const again=await this.probe(clean(snapshot));if(!this.enabled||!again||again.idle!==true||again.pendingInput!==false||again.session!==snapshot.session||again.generation!==snapshot.generation)throw Error('target became busy');
    fresh=this.status().sessions.find(row=>row.session===snapshot.session);if(!this.enabled||!this.same(fresh,snapshot)||!this.warm(fresh,this.clock()))throw Error('session/cache changed before write');
    // Writer must perform its own target CAS; no transport is part of this API.
    await this.write(clean(snapshot),result);attempt.state='written';
   }catch(error){attempt.state='failed';attempt.reason=abort.signal.aborted?'handoff_attempt_cancelled':'handoff_attempt_failed';}finally{if(this.inflight.get(snapshot.session)===abort)this.inflight.delete(snapshot.session);}
   this.store.transaction(state=>{const row=state.sessions[snapshot.session];if(row?.claimed?.id===claim)row.claimed.state=attempt.state;});
  }
  return {state:'checked',attempts};
 }
}
export function nativeCacheObservation(){return {enabled:false,ttlMs:null,reason:'native request-start/effective-TTL provenance unavailable'};}
