import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const paths=[new URL('../src/index.js',import.meta.url).pathname,new URL('../dist/index.js',import.meta.url).pathname];
function fixture(path,mode='disabled'){
 const text=readFileSync(path,'utf8');
 const start=text.indexOf('function usageProbesDisabled()')>=0?text.indexOf('function usageProbesDisabled()'):text.indexOf('async function probeUsageOnce()');
 const code=text.slice(start,text.indexOf('\nfunction markRateLimited',start));
 let disabled=mode==='disabled';let unreadable=mode==='unreadable';let requests=0,tokenReads=0,timers=0;
 const context=vm.createContext({homedir:()=>'/fixture-home',join:(...x)=>x.join('/'),statSync:p=>{assert.equal(p,'/fixture-home/.hermes/lane-memory/DISABLED');if(unreadable)throw Object.assign(Error(),{code:'EACCES'});if(!disabled)throw Object.assign(Error(),{code:'ENOENT'});return {};},getAnthropicOAuthTokens:()=>{tokenReads++;return [{id:1},{id:2}];},makeAnthropicRequest:async()=>{requests++;if(mode==='flip')disabled=true;},setTimeout:()=>{timers++;},setInterval:()=>{timers++;},USAGE_PROBE_INTERVAL_MS:180000,CLAUDE_CODE_SYSTEM_PREFIX:'fixture',parseKnownResetSeconds:()=>0,markRateLimited:()=>{}});
 vm.runInContext(code,context);
 return {context,get requests(){return requests;},get tokenReads(){return tokenReads;},get timers(){return timers;}};
}
for(const path of paths){
 test(path+' disabled never schedules or reads auth/provider',async()=>{const f=fixture(path);f.context.startUsageProbeLoop();await f.context.probeUsageOnce();assert.equal(f.timers,0);assert.equal(f.tokenReads,0);assert.equal(f.requests,0);});
 test(path+' unreadable switch fails closed',async()=>{const f=fixture(path,'unreadable');f.context.startUsageProbeLoop();await f.context.probeUsageOnce();assert.equal(f.requests,0);assert.equal(f.timers,0);});
 test(path+' absent switch preserves inert probe behavior',async()=>{const f=fixture(path,'enabled');f.context.startUsageProbeLoop();await f.context.probeUsageOnce();assert.equal(f.requests,2);assert.equal(f.timers,2);});
 test(path+' marker appearing between tokens prevents next request',async()=>{const f=fixture(path,'flip');await f.context.probeUsageOnce();assert.equal(f.requests,1);});
}
