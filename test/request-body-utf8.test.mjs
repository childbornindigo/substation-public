// Regression: inbound request bodies must survive chunk boundaries that fall
// inside a multi-byte UTF-8 character.
//
// Cache-cliff root-cause WO 2026-10-06, cause C4.  The three POST handlers did
// `req.on('data', c => body += c)` on raw Buffers, which decodes each chunk
// separately: a character split across two chunks becomes U+FFFD U+FFFD.  Node
// delivers large bodies in 64 KiB chunks and Hermes' system prompt is the first
// message, so a "§" (C2 A7) landing on byte 65,536 turned the system prompt into
// different bytes on about 12% of requests.  That prefix change re-wrote the
// whole cache for the session (84 of 255 cache cliffs, 16.8M cache-write tokens
// in 1.3 days: 61 in the system prompt block, 19 in history/tool results, 4 in tool
// descriptions).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'substation-utf8-'));
process.env.HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));
const here = dirname(fileURLToPath(import.meta.url));
const srcPath = process.env.UTF8_TEST_SOURCE || join(here, '../src/index.js');
const mod = await import(srcPath);

function bufferStream(buf, cuts) {
  const parts = []; let at = 0;
  for (const cut of [...cuts, buf.length]) { parts.push(buf.subarray(at, cut)); at = cut; }
  return Readable.from(parts, { objectMode: false });
}
const done = s => new Promise((res, rej) => { s.on('end', res); s.on('error', rej); });

test('control: naive per-chunk decoding really does corrupt a split character', () => {
  const buf = Buffer.from('a§b', 'utf8'); // 61 C2 A7 62
  let naive = '';
  for (const chunk of [buf.subarray(0, 2), buf.subarray(2)]) naive += chunk.toString();
  assert.match(naive, /�/);
});

test('readUtf8Body keeps 2-, 3- and 4-byte characters intact across every possible split', async () => {
  assert.equal(typeof mod.readUtf8Body, 'function', 'readUtf8Body is exported');
  const text = JSON.stringify({ s: 'sec § dash — box ─ rocket \u{1F680} done' });
  const buf = Buffer.from(text, 'utf8');
  for (let cut = 1; cut < buf.length; cut++) {
    const stream = bufferStream(buf, [cut]);
    const state = mod.readUtf8Body(stream, 1 << 20, () => assert.fail('not too large'));
    await done(stream);
    assert.equal(state.text, text, `split at byte ${cut}`);
  }
});

test('readUtf8Body at a 64 KiB boundary inside a character (the production shape)', async () => {
  const filler = 'x'.repeat(65535 - 20);
  const text = JSON.stringify({ system: `${filler}§tail`, n: 1 });
  const buf = Buffer.from(text, 'utf8');
  const at = buf.indexOf(Buffer.from('§')) + 1; // between C2 and A7
  const stream = bufferStream(buf, [at]);
  const state = mod.readUtf8Body(stream, 1 << 20, () => assert.fail('not too large'));
  await done(stream);
  assert.equal(JSON.parse(state.text).system.endsWith('§tail'), true);
});

test('readUtf8Body enforces the byte limit once and stops accumulating', async () => {
  let calls = 0;
  const stream = bufferStream(Buffer.from('é'.repeat(100)), [50, 120]);
  const state = mod.readUtf8Body(stream, 100, () => { calls++; });
  await done(stream);
  assert.equal(calls, 1);
  assert.equal(state.tooLarge, true);
  assert.ok(Buffer.byteLength(state.text) <= 100);
});

for (const rel of ['../src/index.js', '../dist/index.js']) {
  test(`${rel}: no POST handler concatenates raw request chunks`, () => {
    const code = readFileSync(join(here, rel), 'utf8');
    const rawReaders = code.match(/req\.on\('data', c => \{[\s\S]{0,400}?body \+= c;/g) || [];
    assert.equal(rawReaders.length, 0, 'raw `body += c` request readers must not exist');
    assert.equal((code.match(/readUtf8Body\(req, MAX_BODY_SIZE/g) || []).length, 3,
      'chat/completions, messages and images/generations all use readUtf8Body');
  });
}
