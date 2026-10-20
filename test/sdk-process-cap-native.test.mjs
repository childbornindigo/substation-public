import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { SdkProcessCap } from '../src/sdk-process-cap.js';

test('installed SDK runs through capped native spawn against a loopback provider only', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-cap-native-')); const statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ schema_version: 1, sampled_at_epoch: Date.now() / 1000, kernel_pressure_level: 1, pressure_level: 'normal', blocked: false, admission: { claude: true } }));
  let providerRequests = 0;
  const server = createServer((req, res) => {
    req.resume(); req.on('end', () => {
      if (!req.url.includes('/messages')) { res.end('{}'); return; }
      providerRequests++;
      const events = [
        ['message_start', { type: 'message_start', message: { id: 'msg_cap_fixture', type: 'message', role: 'assistant', content: [], model: 'claude-opus-5-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'offline-cap-proof' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [event, value] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cap = new SdkProcessCap({ root: join(dir, 'slots'), statePath, limit: 1 });
  try {
    const q = await cap.query(sdk.query, { prompt: 'Offline capped SDK fixture', options: {
      model: 'claude-opus-5-5', maxTurns: 1, tools: [], settingSources: [], cwd: dir,
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, abortController: new AbortController(),
      env: { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_AUTH_TOKEN: undefined,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'sk-offline-cap-fixture',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' },
    } });
    let text = '';
    for await (const msg of q) if (msg.type === 'assistant') for (const block of msg.message?.content || []) if (block.type === 'text') text += block.text;
    assert.match(text, /offline-cap-proof/); assert.equal(providerRequests, 1);
    for (let i = 0; i < 100 && readdirSync(cap.root).length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(readdirSync(cap.root).length, 0, 'actual native child close releases lease');
    console.log(JSON.stringify({ proof: 'installed-sdk-capped-native-spawn', loopbackProviderRequests: providerRequests, realProviderCalls: 0 }));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});
