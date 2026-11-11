import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { fixture, fixed, responseFor, readerResponse, sequence, bounded, privateText } from './resource-support.mjs';

test('040 response: every well-formed non200 status is one fixed failure, never a binary provider refusal', async t => {
  const f = await fixture(t);
  for (const status of [201, 204, 206, 300, 301, 302, 303, 304, 307, 308, 399, 403, 500, 503]) {
    f.hooks.resource = call => responseFor(call, [204, 304].includes(status) ? null : Buffer.from('{"error_code":212}'), { status });
    await assert.rejects(f.read(), fixed('request-failed', { submitted: true, status }));
  }
  assert.equal(f.resourceCalls.length, 14);
  f.hooks.resource = call => responseFor(call, Buffer.from('{"error_code":212,"data":"opaque-not-account-envelope"}'));
  assert.equal((await f.read()).toString(), '{"error_code":212,"data":"opaque-not-account-envelope"}');
});

test('040 response: redirect/location/range/identity mismatches reject before reading and cancel the unread body', async t => {
  const f = await fixture(t); const fixtures = [
    { headers: { location: '' } }, { headers: { location: 'https://outside.invalid/private' } },
    { headers: { 'content-range': '' } }, { headers: { 'content-range': 'bytes 0-1/2' } },
    { redirected: true }, { url: 'https://outside.invalid/private' }, { url: 3 },
  ];
  for (const options of fixtures) {
    let reads = 0, cancelled = 0;
    f.hooks.resource = call => {
      const response = responseFor(call, new ReadableStream({
        pull() { reads++; return new Promise(() => {}); }, cancel() { cancelled++; },
      }, { highWaterMark: 0 }), options);
      return response;
    };
    await assert.rejects(f.read(), fixed('invalid-response', { submitted: true }));
    assert.equal(reads, 0); assert.equal(cancelled, 1);
  }
  assert.equal(f.resourceCalls.length, fixtures.length);
});

test('040 response: real Headers normalized absent/identity encodings work; all other codings fail before body reads', async t => {
  const f = await fixture(t);
  for (const encoding of [undefined, 'identity', 'IdEnTiTy']) {
    f.hooks.resource = call => responseFor(call, Buffer.from([0, 255]), { headers: encoding === undefined ? {} : { 'content-encoding': encoding } });
    assert.deepEqual(await f.read(), Buffer.from([0, 255]));
  }
  for (const encoding of ['', 'gzip', 'br', 'deflate', 'identity,gzip', 'identity, identity']) {
    let reads = 0;
    f.hooks.resource = call => readerResponse(call, { read() { reads++; throw Error(privateText); },
      cancel() {}, releaseLock() {} }, { 'content-encoding': encoding }).response;
    await assert.rejects(f.read(), fixed('invalid-response', { submitted: true })); assert.equal(reads, 0);
  }
});

test('040 response: empty present/null bodies and strict decimal lengths have explicit independent outcomes', async t => {
  const f = await fixture(t);
  for (const [bytes, headers] of [[null, {}], [null, { 'content-length': '000' }],
    [Buffer.alloc(0), {}], [Buffer.from([7]), { 'content-length': '0001' }]]) {
    f.hooks.resource = call => responseFor(call, bytes, { headers });
    assert.deepEqual(await f.read(), bytes ?? Buffer.alloc(0));
  }
  for (const length of ['', '+1', '-1', '1.0', '1e0', '1,1', '0x1', '1'.repeat(33)]) {
    f.hooks.resource = call => responseFor(call, Buffer.from([7]), { headers: { 'content-length': length } });
    await assert.rejects(f.read(), fixed('invalid-response', { submitted: true }));
  }
  for (const [bytes, length] of [[null, '1'], [Buffer.from([1]), '2'], [Buffer.from([1, 2]), '1']]) {
    f.hooks.resource = call => responseFor(call, bytes, { headers: { 'content-length': length } });
    await assert.rejects(f.read(), fixed('invalid-response', { submitted: true }));
  }
  f.hooks.resource = call => responseFor(call, null, { headers: { 'content-length': '99999999999999999999999999999999' } });
  await assert.rejects(f.read(), fixed('response-limit', { submitted: true }));
});

test('040 response: declared and cumulative caps are independent of chunk boundaries and operator cap cannot be raised', async t => {
  const f = await fixture(t, { maxResponseBytes: 8192 });
  const expected = sequence(8192);
  f.hooks.resource = call => responseFor(call, expected, { headers: { 'content-length': '8192' } });
  assert.deepEqual(await f.read(undefined, { maxBytes: 16 * 1024 * 1024 }), expected);
  f.hooks.resource = call => responseFor(call, null, { headers: { 'content-length': '8193' } });
  await assert.rejects(f.read(), fixed('response-limit', { submitted: true }));
  f.hooks.resource = call => responseFor(call, new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.alloc(5000)); controller.enqueue(Buffer.alloc(3193)); controller.close();
  } }));
  await assert.rejects(f.read(undefined, { maxBytes: 16 * 1024 * 1024 }), fixed('response-limit', { submitted: true }));
  f.hooks.resource = call => responseFor(call, Buffer.from([1, 2, 3, 4]));
  await assert.rejects(f.read(undefined, { maxBytes: 3 }), fixed('response-limit', { submitted: true }));
});

test('040 response: default2MiB and explicitly configured8MiB remain network ceilings despite16MiB call maximum', { timeout: 10000 }, async t => {
  for (const [options, cap] of [[{}, 2 * 1024 * 1024], [{ maxResponseBytes: 8 * 1024 * 1024 }, 8 * 1024 * 1024]]) {
    const f = await fixture(t, { ...options, requestTimeoutMs: 5000 });
    const expected = Buffer.alloc(cap, 0xa5);
    f.hooks.resource = call => responseFor(call, expected);
    assert.deepEqual(await f.read(undefined, { maxBytes: 16 * 1024 * 1024 }), expected);
    f.hooks.resource = call => responseFor(call, Buffer.alloc(cap + 1));
    await assert.rejects(f.read(undefined, { maxBytes: 16 * 1024 * 1024 }), fixed('response-limit', { submitted: true }));
    assert.equal(f.resourceCalls.length, 2);
  }
});

test('040 response: adapter reuses one backing buffer yet earlier chunk bytes and returned caller bytes remain owned', async t => {
  const f = await fixture(t), shared = Buffer.alloc(3); let step = 0, cancels = 0, releases = 0, response;
  f.hooks.resource = call => {
    response = readerResponse(call, {
      async read() {
        if (step === 0) { step++; shared.set([1, 2, 3]); return { done: false, value: shared }; }
        if (step === 1) { step++; shared.set([4, 5, 6]); return { done: false, value: shared }; }
        shared.fill(0xee); return { done: true, value: undefined };
      }, cancel() { cancels++; }, releaseLock() { releases++; shared.fill(0xdd); },
    }); return response.response;
  };
  const bytes = await f.read(); assert.deepEqual(bytes, Buffer.from([1, 2, 3, 4, 5, 6]));
  shared.fill(0xcc); assert.deepEqual(bytes, Buffer.from([1, 2, 3, 4, 5, 6]));
  assert.equal(response.acquisitions(), 1); assert.equal(cancels, 0); assert.equal(releases, 1);
});

test('040 response: ordinary cross-realm Uint8Array works; invalid/shared/Proxy chunks and accessor done are rejected without coercion', async t => {
  const f = await fixture(t);
  const cross = runInNewContext('new Uint8Array([1,255,3])'); let index = 0;
  f.hooks.resource = call => readerResponse(call, { read() { return Promise.resolve(index++ === 0
    ? { done: false, value: cross } : { done: true, value: undefined }); }, cancel() {}, releaseLock() {} }).response;
  assert.deepEqual(await f.read(), Buffer.from([1, 255, 3]));
  let traps = 0; const trap = () => { traps++; throw Error(privateText); };
  const chunks = [new DataView(new ArrayBuffer(2)), new Int8Array(2), new Uint8Array(new SharedArrayBuffer(2)),
    new Proxy(new Uint8Array(2), { get: trap }), { valueOf: trap }, 'bytes'];
  for (const chunk of chunks) {
    f.hooks.resource = call => readerResponse(call, { read() { return Promise.resolve({ done: false, value: chunk }); },
      cancel() {}, releaseLock() {} }).response;
    await assert.rejects(f.read(), fixed('invalid-response', { submitted: true }));
  }
  const result = {}; Object.defineProperty(result, 'done', { get: trap });
  f.hooks.resource = call => readerResponse(call, { read() { return Promise.resolve(result); }, cancel() {}, releaseLock() {} }).response;
  await assert.rejects(f.read(), fixed('invalid-response', { submitted: true })); assert.equal(traps, 0);
});

test('040 response: metadata and reader methods are captured once, not validated and then read again', async t => {
  const f = await fixture(t), reads = new Map(); let step = 0;
  f.hooks.resource = call => {
    const reader = {};
    const methods = { read: async () => step++ === 0 ? { done: false, value: Buffer.from([8, 9]) } : { done: true },
      cancel() {}, releaseLock() {} };
    for (const name of Object.keys(methods)) Object.defineProperty(reader, name, { get() {
      const count = (reads.get(name) ?? 0) + 1; reads.set(name, count);
      if (count > 1) throw Error(privateText); return methods[name];
    } });
    const response = responseFor(call, null);
    const fields = { status: 200, redirected: false, url: new URL(call.raw).href,
      headers: new Headers(), body: { locked: false, cancel() {}, getReader() { return reader; } } };
    for (const [name, value] of Object.entries(fields)) Object.defineProperty(response, name, { configurable: true, get() {
      const count = (reads.get(name) ?? 0) + 1; reads.set(name, count);
      if (count > 1) throw Error(privateText); return value;
    } });
    return response;
  };
  assert.deepEqual(await f.read(), Buffer.from([8, 9]));
  for (const name of ['status', 'redirected', 'url', 'headers', 'body', 'read', 'cancel', 'releaseLock']) assert.equal(reads.get(name), 1, name);
});

test('040 response: trusted custom empty URL is explicit compatibility, but missing/nonstring/throwing URL is not empty', async t => {
  const f = await fixture(t);
  f.hooks.resource = call => responseFor(call, Buffer.from([1]), { url: '' });
  assert.deepEqual(await f.read(), Buffer.from([1]));
  for (const value of [undefined, null, 1]) {
    f.hooks.resource = call => { const response = responseFor(call); Object.defineProperty(response, 'url', { value }); return response; };
    await assert.rejects(f.read(), fixed('invalid-response', { submitted: true }));
  }
  f.hooks.resource = call => { const response = responseFor(call); Object.defineProperty(response, 'url', { get() { throw Error(privateText); } }); return response; };
  await assert.rejects(bounded(f.read()), fixed('request-failed', { submitted: true }));
});

test('040 response: an external release exception alone cannot replace a completed bounded read', async t => {
  const f = await fixture(t); let step = 0, releases = 0;
  f.hooks.resource = call => readerResponse(call, {
    read() { return Promise.resolve(step++ === 0 ? { done: false, value: Buffer.from([1, 7]) } : { done: true }); },
    cancel() { throw Error(privateText); }, releaseLock() { releases++; throw Error(privateText); },
  }).response;
  assert.deepEqual(await f.read(), Buffer.from([1, 7])); assert.equal(releases, 1);
});
