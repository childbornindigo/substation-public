// No LLM traffic: local HTTP completions backed by inexpensive Node children.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SdkProcessCap } from '../../src/sdk-process-cap.js';

export function createCapFixtureServer({ root, statePath, limit = 8, durationMs = 200, queueTimeoutMs = 10000 }) {
  const cap = new SdkProcessCap({ root, statePath, limit, queueTimeoutMs, pollMs: 10 });
  const children = new Set(); const stats = { started: 0, completed: 0, peak: 0, providerCalls: 0 };
  const query = ({ options }) => {
    const child = options.spawnClaudeCodeProcess({ command: process.execPath,
      args: ['-e', `setTimeout(()=>process.exit(0),${Math.max(10, durationMs)});`], env: process.env });
    children.add(child); stats.started++; stats.peak = Math.max(stats.peak, children.size);
    child.once('close', () => { children.delete(child); stats.completed++; });
    return { close() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); },
      async *[Symbol.asyncIterator]() { await once(child, 'close'); yield 'offline fixture completion'; } };
  };
  const server = createServer(async (req, res) => {
    if (req.url === '/fixture-stats') { res.end(JSON.stringify({ ...stats, live: children.size, queued: cap.queue.length })); return; }
    const ac = new AbortController(); const cancelled = () => { if (!res.writableEnded) ac.abort(); };
    res.on('close', cancelled);
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const q = await cap.query(query, { options: { abortController: ac } });
      for await (const _ of q) {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'offline-sdk-cap-fixture', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '{"summary":"offline fixture"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    } catch (e) { if (!res.destroyed) { res.writeHead(e.statusCode || 503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } }
    finally { res.removeListener('close', cancelled); }
  });
  return { server, cap, stats, children, async close() {
    for (const child of children) child.kill('SIGKILL');
    await Promise.all([...children].map(child => once(child, 'close')));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}
