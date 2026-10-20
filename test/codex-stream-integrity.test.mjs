import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import {fileURLToPath} from 'node:url';
const source=readFileSync(process.env.SUBSTATION_TEST_SOURCE || fileURLToPath(new URL('../src/index.js',import.meta.url)),'utf8');
function fn(name){const m=source.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n}\\n)`));assert.ok(m,name);return m[0]+'\n}';}
const textEvent=t=>({type:'response.output_text.delta',delta:t});
const complete=(output=[])=>({type:'response.completed',response:{status:'completed',model:'gpt-6.1-sol',output,usage:{output_tokens:1}}});
const added={type:'response.output_item.added',item:{type:'function_call',id:'fc1',call_id:'call1',name:'mock_mutation',arguments:'{'}};
const failed={type:'response.failed',response:{error:{code:'server_error',message:'mock upstream failure'}}};
function harness(plan={}) {
  let attempts=0, destroys=0, refreshes=0, writes=0;
  const httpsRequest=(_opts,cb)=>{
    attempts++;
    const req=new EventEmitter();req.write=()=>{writes++};req.destroy=()=>{destroys++};
    req.end=()=>setImmediate(()=>{
      const res=new EventEmitter();res.statusCode=plan.status||200;res.headers={};
      let decoder=null;res.setEncoding=()=>{decoder=new StringDecoder('utf8')};cb(res);
      if(plan.hang)return;
      if(plan.delayedToken){
        res.emit('data','data: '+JSON.stringify({type:'response.created',response:{model:'gpt-6.1-sol'}})+'\n\n');
        setTimeout(()=>res.emit('data','data: '+JSON.stringify({type:'response.in_progress'})+'\n\n'),10);
        setTimeout(()=>{res.emit('data','data: '+JSON.stringify(textEvent('late token'))+'\n\ndata: '+JSON.stringify(complete())+'\n\n');res.emit('end');},25);
        return;
      }
      const events=plan.events||[];
      const sep=plan.crlf?'\r\n':'\n';
      const data=Buffer.from(events.map(e=>(plan.noSpace?'data:':'data: ')+JSON.stringify(e)+sep+sep).join(''));
      const size=plan.bytewise?1:Math.max(data.length,1);
      for(let i=0;i<data.length;i+=size){const chunk=data.subarray(i,i+size);res.emit('data',decoder?decoder.write(chunk):chunk);}
      if(decoder){const tail=decoder.end();if(tail)res.emit('data',tail);}
      if(plan.reset)res.emit('error',new Error('ECONNRESET'));
      else if(plan.aborted)res.emit('aborted');
      else if(!plan.hangAfter)res.emit('end');
    });return req;
  };
  const token={provider:'openai',id:'mock',token:'mock-only'};
  const ctx=vm.createContext({Buffer,setTimeout,clearTimeout,httpsRequest,CODEX_PROGRESS_TIMEOUT:20,CODEX_ATTEMPT_TIMEOUT:80,CODEX_FIRST_BYTE_TIMEOUT:15,
    isCodexSessionStallError:()=>false,enforceToolProgress:()=>{},pool:[token,{...token,id:'mock2'}],resolveCodexReasoningEffort:()=> 'low',logEffectiveEffort:()=>{},buildCodexBody:()=>({model:'gpt-6.1-sol'}),codexRequestHash:()=> 'hash',getCachedCodexFailure:()=>null,log:()=>{},CODEX_MAX_TOKEN_ATTEMPTS:2,selectToken:()=>token,markRequestStart:()=>{},markRequestEnd:()=>{},markSuccess:()=>{},markRateLimited:()=>{},markDead:()=>{},normalizeToolCalls:x=>x,codexRequestFailureCache:new Map(),isCodexTransientError:()=>true,rememberCodexFailure:()=>{},logRequestEnd:()=>{},classifyInvokeError:()=> 'mock-error',randomUUID:()=> 'mock-id',refreshOpenAIToken:()=>{refreshes++}});
  vm.runInContext([...(source.includes('function codexFailureCode(')?['codexFailureCode','codexWireValue']:[]),'extractCodexOutputText','getCodexServedModel','makeCodexRequest','invokeCodex'].map(fn).join('\n'),ctx);
  return {ctx,stats:()=>({attempts,destroys,refreshes,writes}),request:(cb=null,signal=null)=>ctx.makeCodexRequest('{}',token,cb,null,signal),invoke:(cb=null,signal=null)=>ctx.invokeCodex([],{modelId:'gpt-6.1-sol'},cb,[],null,signal)};
}
test('completed text and upstream identity survive one-byte UTF-8 + CRLF chunks',async()=>{const h=harness({events:[textEvent('café 🦋'),complete()],bytewise:true,crlf:true});const r=await h.request();assert.equal(r.text,'café 🦋');assert.equal(r.servedModel,'gpt-6.1-sol');});
test('completed tool-only result retains actual id and arguments',async()=>{const h=harness({events:[complete([{type:'function_call',id:'fc1',call_id:'call1',name:'mock_mutation',arguments:'{"ok":true}'}])]});const r=await h.request();assert.equal(r.toolCalls[0].id,'call1');assert.equal(r.toolCalls[0].function.arguments,'{"ok":true}');});
test('empty end preserves distinct empty-stream diagnostic',async()=>{await assert.rejects(harness().request(),/Empty response from Codex/);});
test('no first byte preserves timeout duration and diagnostic',async()=>{const h=harness({hang:true});await assert.rejects(h.request(),/no stream data/);assert.equal(h.stats().destroys,1);});
test('partial text end cannot report success',async()=>{await assert.rejects(harness({events:[textEvent('partial')]}).request(),/before response.completed/);});
test('unfinished function call cannot reach executor',async()=>{let executions=0;try{const r=await harness({events:[added]}).request();for(const c of r.toolCalls||[])executions++;}catch{}assert.equal(executions,0);});
test('explicit incomplete response rejects partial text',async()=>{await assert.rejects(harness({events:[textEvent('partial'),{type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'}}}]}).request(),/incomplete: max_output_tokens/);});
test('failed terminal preserves upstream failure instead of returning text',async()=>{await assert.rejects(harness({events:[textEvent('partial'),failed]}).request(),/mock upstream failure/);});
test('reset rejects partial response',async()=>{await assert.rejects(harness({events:[textEvent('partial')],reset:true}).request(),/ECONNRESET/);});
test('aborted rejects partial response',async()=>{await assert.rejects(harness({events:[textEvent('partial')],aborted:true}).request(),/aborted/);});
test('buffered text followed by failure never retries',async()=>{const h=harness({events:[textEvent('partial'),failed]});await assert.rejects(h.invoke(),/mock upstream failure/);assert.equal(h.stats().attempts,1);});
test('unfinished tool followed by failure never retries or executes',async()=>{const h=harness({events:[added,failed]});await assert.rejects(h.invoke(),/mock upstream failure/);assert.equal(h.stats().attempts,1);});
test('streamed text followed by failure never retries',async()=>{const h=harness({events:[textEvent('partial'),failed]});let visible='';await assert.rejects(h.invoke(s=>visible+=s),/mock upstream failure/);assert.equal(visible,'partial');assert.equal(h.stats().attempts,1);});
test('pre-aborted client never submits request body or rotates',async()=>{const c=new AbortController();c.abort();const h=harness({hang:true});await assert.rejects(h.invoke(null,c.signal),/canceled/);assert.equal(h.stats().attempts,source.includes('const attemptRequest = async')?0:1);assert.equal(h.stats().writes,0);});
test('in-flight cancellation destroys upstream and never rotates',async()=>{const c=new AbortController();const h=harness({hang:true});const p=h.invoke(null,c.signal);setImmediate(()=>c.abort());await assert.rejects(p,/canceled/);assert.equal(h.stats().attempts,1);assert.equal(h.stats().destroys,1);});
test('empty failure may rotate boundedly before any output',async()=>{const h=harness();await assert.rejects(h.invoke(),/Empty response/);assert.equal(h.stats().attempts,2);});

test('valid data field without optional space parses',async()=>{const h=harness({noSpace:true,events:[textEvent('ok'),complete()]});assert.equal((await h.request()).text,'ok');});
test('received event without terminal output uses progress-stall diagnostic',async()=>{const h=harness({events:[{type:'response.created',response:{model:'gpt-6.1-sol'}}],hangAfter:true});await assert.rejects(h.request(),/stream stalled/);});

test('long first-token latency succeeds while stream events continue',async()=>{const h=harness({delayedToken:true});assert.equal((await h.request()).text,'late token');});
test('completed envelope updates previously added function arguments',async()=>{const h=harness({events:[added,complete([{...added.item,arguments:'{\"ok\":true}'}])]});assert.equal((await h.request()).toolCalls[0].function.arguments,'{\"ok\":true}');});

test('bare completed event cannot bless partial text',async()=>{await assert.rejects(harness({events:[textEvent('partial'),{type:'response.completed'}]}).request(),/malformed response.completed/);});
test('contradictory completed status cannot bless partial tool',async()=>{await assert.rejects(harness({events:[added,{type:'response.completed',response:{status:'incomplete',output:[]}}]}).request(),/malformed response.completed/);});
test('incomplete reason is bounded and excludes arbitrary provider content',async()=>{await assert.rejects(harness({events:[{type:'response.incomplete',response:{incomplete_details:{reason:'PRIVATE_SENTINEL'}}}]}).request(),e=>/incomplete: unknown/.test(e.message)&&!e.message.includes('PRIVATE_SENTINEL'));});

for (const [label, terminal, expected] of [
  ['failed', failed, /mock upstream failure/],
  ['incomplete', {type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'}}}, /incomplete/],
  ['malformed completed', {type:'response.completed'}, /malformed response.completed/],
]) {
  test(`${label} terminal closes transport even without upstream EOF`,async()=>{
    const h=harness({events:[textEvent('partial'),terminal],hangAfter:true});
    await assert.rejects(h.invoke(),expected);
    assert.equal(h.stats().attempts,1);
    assert.equal(h.stats().destroys,1);
  });
}
