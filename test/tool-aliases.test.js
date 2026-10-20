import assert from 'node:assert/strict';
import test from 'node:test';
import { enforceToolProgress, normalizeToolCalls, progressTracker } from '../src/index.js';

const tool = name => ({ function: { name } });
const call = (name, args) => ({ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('remaps case-insensitively and normalizes Bash arguments', () => {
  const [result] = normalizeToolCalls([call('bAsH', { command: 'echo hi', description: 'drop me' })], [tool('terminal')]);
  assert.equal(result.function.name, 'terminal');
  assert.deepEqual(JSON.parse(result.function.arguments), { command: 'echo hi' });
});

test('normalizes Read, Grep, Edit, Write, and AskUserQuestion arguments', () => {
  const registered = ['read_file', 'search_files', 'patch', 'write_file', 'clarify'].map(tool);
  const results = normalizeToolCalls([
    call('Read', { file_path: '/tmp/a', offset: 5 }),
    call('Grep', { pattern: 'needle', path: '/tmp', glob: '*.js', output_mode: 'content' }),
    call('Edit', { file_path: '/tmp/a', old_string: 'a', new_string: 'b', replace_all: true }),
    call('Write', { file_path: '/tmp/a', content: 'hello' }),
    call('AskUserQuestion', { question: 'Pick?', choices: ['A', 'B'], extra: true }),
  ], registered);
  assert.deepEqual(results.map(result => [result.function.name, JSON.parse(result.function.arguments)]), [
    ['read_file', { path: '/tmp/a' }],
    ['search_files', { pattern: 'needle', path: '/tmp', file_glob: '*.js' }],
    ['patch', { path: '/tmp/a', old_string: 'a', new_string: 'b', mode: 'replace' }],
    ['write_file', { path: '/tmp/a', content: 'hello' }],
    ['clarify', { question: 'Pick?', choices: ['A', 'B'] }],
  ]);
});

test('preserves a registered real tool before considering aliases', () => {
  const [result] = normalizeToolCalls([call('BASH', { custom: true })], [tool('Bash'), tool('terminal')]);
  assert.equal(result.function.name, 'Bash');
  assert.deepEqual(JSON.parse(result.function.arguments), { custom: true });
});

test('leaves unknown or unavailable aliases unchanged', () => {
  const calls = [call('FutureTool', { x: 1 }), call('Bash', { command: 'echo hi' })];
  assert.deepEqual(normalizeToolCalls(calls, [tool('read_file')]), calls);
});

test('NotebookEdit is a clear hard error unless registered for real', () => {
  assert.throws(
    () => normalizeToolCalls([call('NotebookEdit', {})], [tool('patch')]),
    error => error.code === 'SUBSTATION_UNSUPPORTED_TOOL' && /no notebook-editing equivalent/i.test(error.message),
  );
  const [result] = normalizeToolCalls([call('notebookedit', { cell: 1 })], [tool('NotebookEdit')]);
  assert.equal(result.function.name, 'NotebookEdit');
});

const progressMessages = result => [
  { role: 'user', content: 'stable session seed' },
  { role: 'assistant', tool_calls: [call('Bash', { command: 'git status' })] },
  { role: 'tool', tool_call_id: 'call-1', content: result },
];

test('third identical tool call and result is mechanically blocked', () => {
  progressTracker.clear();
  assert.equal(enforceToolProgress(progressMessages('clean'), 'claude-test'), false);
  assert.equal(enforceToolProgress(progressMessages('clean'), 'claude-test'), true);
  assert.throws(
    () => enforceToolProgress(progressMessages('clean'), 'claude-test'),
    /BLOCKED: repeated identical tool call with no state change \(Bash\)\. Change approach — do not re-run the same call\./,
  );
});

test('a changed tool result resets no-progress repetition', () => {
  progressTracker.clear();
  enforceToolProgress(progressMessages('first'), 'codex-test');
  assert.equal(enforceToolProgress(progressMessages('first'), 'codex-test'), true);
  assert.equal(enforceToolProgress(progressMessages('changed'), 'codex-test'), false);
  assert.doesNotThrow(() => enforceToolProgress(progressMessages('changed'), 'codex-test'));
});
