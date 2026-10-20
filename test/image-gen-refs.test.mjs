// Unit tests for /v1/images/generations reference-image support.
// Extracts resolveImageRefs + chatgptImageGenerate from src/index.js; fake upstream, no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync, writeFileSync, mkdtempSync, statSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
const source = readFileSync(process.env.SUBSTATION_TEST_SOURCE || fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8');
function fn(name){const m=source.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n}\\n)`));assert.ok(m,name);return m[0]+'\n}';}
const consts = source.match(/const IMAGE_REF_MAX_COUNT[^\n]*\nconst IMAGE_REF_MAX_BYTES[^\n]*\n/)[0];

const PNG = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from('pngbody')]);
const JPG = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.from('jpgbody')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1,0,0,0]), Buffer.from('WEBPVP8 ')]);

function harness() {
  const bodies = [];
  const httpsRequest = (_o, cb) => {
    const req = new EventEmitter();
    req.write = b => bodies.push(b); req.destroy = () => {};
    req.end = () => setImmediate(() => {
      const res = new EventEmitter(); res.statusCode = 200; cb(res);
      res.emit('data', 'data: ' + JSON.stringify({type:'response.output_item.done',item:{type:'image_generation_call',result:'QUJD'}}) + '\n');
      res.emit('end');
    });
    return req;
  };
  const ctx = vm.createContext({Buffer, setTimeout, clearTimeout, statSync, existsSync, readFileSync, httpsRequest, TIMEOUT: 1000});
  vm.runInContext([consts, ...['imageRefError','sniffImageMime','looksLikeJpegBase64','resolveImageRefs','chatgptImageGenerate'].map(fn)].join('\n'), ctx);
  const gen = async (prompt, image) => {
    const parts = ctx.resolveImageRefs(image);
    await ctx.chatgptImageGenerate({token: 't'}, prompt, '1024x1024', 'high', parts);
    return bodies[bodies.length - 1];
  };
  return {ctx, gen, bodies};
}
const contentOf = b => JSON.parse(b).input[0].content;
const bad = (h, image, re) => assert.throws(() => h.ctx.resolveImageRefs(image), e => e.statusCode === 400 && re.test(e.message));

test('no image: body byte-identical to legacy text-only request', async () => {
  const h = harness();
  const body = await h.gen('a cat');
  const legacy = JSON.stringify({
    model: 'gpt-5.5', instructions: 'Generate the requested image. Output only the image.',
    input: [{role: 'user', content: 'a cat'}],
    tools: [{type: 'image_generation', model: 'gpt-image-2', size: '1024x1024', quality: 'high'}],
    store: false, stream: true,
  });
  assert.equal(body, legacy);
});
test('data URL becomes input_image after input_text', async () => {
  const h = harness();
  const u = `data:image/png;base64,${PNG.toString('base64')}`;
  assert.deepEqual(contentOf(await h.gen('p', u)), [{type:'input_text', text:'p'}, {type:'input_image', image_url:u}]);
});
test('raw base64 defaults to png, sniffs jpeg and webp', async () => {
  const h = harness();
  assert.match(contentOf(await h.gen('p', PNG.toString('base64')))[1].image_url, /^data:image\/png;base64,/);
  assert.match(contentOf(await h.gen('p', JPG.toString('base64')))[1].image_url, /^data:image\/jpeg;base64,/);
  assert.match(contentOf(await h.gen('p', WEBP.toString('base64')))[1].image_url, /^data:image\/webp;base64,/);
});
test('absolute path is read and encoded', async () => {
  const h = harness();
  const f = join(mkdtempSync(join(tmpdir(), 'imgref-')), 'a.jpg'); writeFileSync(f, JPG);
  assert.equal(contentOf(await h.gen('p', f))[1].image_url, `data:image/jpeg;base64,${JPG.toString('base64')}`);
});
test('array of mixed refs preserves order', async () => {
  const h = harness();
  const f = join(mkdtempSync(join(tmpdir(), 'imgref-')), 'a.png'); writeFileSync(f, PNG);
  const c = contentOf(await h.gen('p', [f, JPG.toString('base64')]));
  assert.equal(c.length, 3);
  assert.match(c[1].image_url, /image\/png/); assert.match(c[2].image_url, /image\/jpeg/);
});
test('more than 4 images -> 400', () => {
  bad(harness(), Array(5).fill(PNG.toString('base64')), /Too many/);
});
test('oversized image -> 400 (base64 and path); exactly 4 MiB ok', () => {
  const h = harness(); const big = Buffer.alloc(4 * 1024 * 1024 + 1, 1);
  bad(h, big.toString('base64'), /exceeds/);
  const f = join(mkdtempSync(join(tmpdir(), 'imgref-')), 'big.png'); writeFileSync(f, big);
  bad(h, f, /exceeds/);
  assert.equal(h.ctx.resolveImageRefs(Buffer.alloc(4 * 1024 * 1024, 1).toString('base64')).length, 1);
});
test('invalid input -> 400, never dropped', () => {
  const h = harness();
  bad(h, 'not base64 !!!', /not a data URL/);
  bad(h, 42, /non-empty string/);
  bad(h, '', /non-empty string/);
  bad(h, [], /empty array/);
  bad(h, {url: 'x'}, /non-empty string/);
  bad(h, '/nonexistent/zzz.png', /not found/);
  bad(h, 'data:text/plain;base64,QUJD', /valid base64 image data URL/);
  bad(h, [PNG.toString('base64'), null], /image\[1\]/);
});
