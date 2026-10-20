import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
const source = readFileSync(process.env.SUBSTATION_TEST_SOURCE || fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8');
function fn(name) {
  const match = source.match(new RegExp(`function ${name}\\([^]*?(?=\\n}\\n)`));
  assert.ok(match, `real source function ${name} exists`);
  return match[0] + '\n}';
}
function constant(name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n};', start) + 3);
}
test('exact requested id routes to OpenAI, existing aliases remain stable', () => {
  const ctx = vm.createContext({});
  vm.runInContext(constant('MODEL_CONFIG') + '\n' + constant('MODEL_MAP') + '\n' + fn('resolveModel'), ctx);
  const actual = ctx.resolveModel('gpt-6.1-sol');
  assert.equal(actual.modelId, 'gpt-6.1-sol');
  assert.equal(actual.apiModel, 'gpt-6.1-sol');
  assert.equal(actual.provider, 'openai');
  assert.equal(actual.reasoningEffort, 'low');
  assert.equal(ctx.resolveModel('gpt-6-sol').modelId, 'gpt-6-sol');
  assert.equal(ctx.resolveModel('sol').modelId, 'gpt-5.6-sol');
  assert.equal(ctx.resolveModel('gpt-latest').modelId, 'gpt-6-sol');
  assert.equal(ctx.resolveModel('sonnet-4-6').modelId, 'claude-sonnet-4-6');
});
function mockRequest(events, chunked = false) {
  return (_options, cb) => {
    const req = new EventEmitter();
    req.write = () => {}; req.destroy = () => {};
    req.end = () => setImmediate(() => {
      const res = new EventEmitter(); res.statusCode = 200; res.headers = {};
      cb(res);
      const data = events.map(e => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n';
      if (chunked) for (let i = 0; i < data.length; i += 7) res.emit('data', Buffer.from(data.slice(i, i + 7)));
      else res.emit('data', Buffer.from(data));
      res.emit('end');
    });
    return req;
  };
}
async function parse(events, chunked = false) {
  const seen = [];
  const ctx = vm.createContext({ Buffer, setTimeout, clearTimeout, httpsRequest: mockRequest(events, chunked), CODEX_PROGRESS_TIMEOUT: 1000, CODEX_ATTEMPT_TIMEOUT: 1000, CODEX_FIRST_BYTE_TIMEOUT: 1000, isCodexSessionStallError: () => false });
  vm.runInContext((source.includes('function codexFailureCode(')?fn('codexFailureCode')+'\n'+fn('codexWireValue')+'\n':'')+fn('extractCodexOutputText') + '\n' + fn('getCodexServedModel') + '\n' + fn('makeCodexRequest'), ctx);
  const result = await ctx.makeCodexRequest('{}', { token: 'mock-only' }, null, m => seen.push(m));
  return { result, seen };
}
test('real SSE parser captures upstream identity across arbitrary chunks', async () => {
  const {result, seen} = await parse([{type:'response.created', response:{model:'gpt-6.1-sol'}}, {type:'response.output_text.delta', delta:'SS_'}, 'not JSON', {type:'response.output_text.done', text:'SS_SOL61_TEXT_OK'}, {type:'response.completed', response:{model:'gpt-6.1-sol', output:[], usage:{output_tokens:4}}}], true);
  assert.equal(result.servedModel, 'gpt-6.1-sol');
  assert.equal(result.text, 'SS_SOL61_TEXT_OK');
  assert.equal(result.usage.output_tokens, 4);
  assert.deepEqual(seen, ['gpt-6.1-sol']);
});
test('final-only function calls preserve actual call id and JSON', async () => {
  const {result} = await parse([{type:'response.completed',response:{model:'gpt-6.1-sol',output:[{type:'function_call',id:'fc-1',call_id:'call-1',name:'substation_probe_echo',arguments:'{"marker":"SS_SOL61_TOOL_OK"}'}]}}]);
  assert.equal(result.servedModel, 'gpt-6.1-sol');
  assert.equal(result.toolCalls[0].id, 'call-1');
  assert.equal(result.toolCalls[0].function.name, 'substation_probe_echo');
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).marker, 'SS_SOL61_TOOL_OK');
});
test('missing upstream identity stays missing rather than echoing requested id', async () => {
  const {result, seen} = await parse([{type:'response.output_text.done', text:'ok'}, {type:'response.completed',response:{output:[]}}]);
  assert.equal(result.servedModel, null);
  assert.equal(seen.length, 0);
});
test('parallel function calls retain separate item and call identities', async () => {
  const {result} = await parse([{type:'response.output_item.added',item:{type:'function_call',id:'fc-a',call_id:'call-a',name:'a'}}, {type:'response.output_item.added',item:{type:'function_call',id:'fc-b',call_id:'call-b',name:'b'}}, {type:'response.function_call_arguments.delta',item_id:'fc-a',delta:'{"a":1}'}, {type:'response.function_call_arguments.done',item_id:'fc-b',arguments:'{"b":2}'}, {type:'response.completed',response:{model:'gpt-6.1-sol',output:[]}}]);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].id, 'call-a');
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).a, 1);
  assert.equal(result.toolCalls[1].id, 'call-b');
  assert.equal(JSON.parse(result.toolCalls[1].function.arguments).b, 2);
});

test('later upstream identity remains observable instead of assumed requested identity', async () => {
  const {result, seen} = await parse([{type:'response.created',response:{model:'gpt-6.1-sol'}},{type:'response.output_text.done',text:'ok'},{type:'response.completed',response:{model:'gpt-6-sol',output:[]}}]);
  assert.equal(result.servedModel, 'gpt-6-sol');
  assert.deepEqual(seen, ['gpt-6.1-sol', 'gpt-6-sol']);
});
