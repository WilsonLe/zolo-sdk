import assert from 'node:assert/strict';
import test from 'node:test';
import { sdk, fixture, responseFor, assertWire, mediaVector, sequence, fixed, resourceOrigin } from './resource-support.mjs';

test('040 core: exact selected transport URL and private viewer header yield an independent binary Buffer', async t => {
  const f = await fixture(t), expected = sequence(193);
  const url = f.url + '&algoversion=1&cloudkeyversion=0007&zcloudurl=true&note=pcloudsession%3Dordinary-value';
  f.hooks.resource = call => responseFor(call, new ReadableStream({ start(controller) {
    controller.enqueue(expected.subarray(0, 3)); controller.enqueue(expected.subarray(3, 91));
    controller.enqueue(expected.subarray(91)); controller.close();
  } }));
  const result = await f.read(url);
  assert.ok(Buffer.isBuffer(result)); assert.deepEqual(result, expected);
  assert.equal(f.resourceCalls.length, 1);
  assertWire(f.resourceCalls[0], url); assert.equal(f.operations.length, 2);
  f.viewer.dispose(); assert.deepEqual(result, expected);
  result[0] ^= 1; assert.notEqual(result[0], expected[0]);
});

test('040 core: independent RSA/OAEP and GCM oracle opens only after explicit ciphertext fetch', async t => {
  const f = await fixture(t), vector = mediaVector('1', 8193);
  const decoder = sdk.createPCloudResourceDecoder(vector.privatePkcs8Der, { publicSpkiDer: vector.publicSpkiDer });
  t.after(() => decoder.dispose());
  f.hooks.resource = call => responseFor(call, vector.ciphertext);
  const bytes = await f.read(f.url);
  assert.deepEqual(bytes, vector.ciphertext); assert.equal(f.resourceCalls.length, 1);
  const opened = decoder.openResource(bytes, vector.wrapped, '1');
  assert.equal(opened.gcmAuthenticated, true); assert.deepEqual(opened.plaintext, vector.plaintext);
  const changed = Buffer.from(bytes); changed[3] ^= 1;
  f.hooks.resource = call => responseFor(call, changed);
  const tampered = await f.read(f.url); assert.deepEqual(tampered, changed);
  assert.throws(() => decoder.openResource(tampered, vector.wrapped, '1'), { code: 'authentication-failed' });
  assert.equal(f.resourceCalls.length, 2, 'decoder failure triggers no hidden fetch or refresh');
  opened.plaintext.fill(0);
});

test('040 core: block CTR keeps reset-per4096 and clear-tail semantics in explicit decoder composition', async t => {
  const f = await fixture(t), vector = mediaVector('2', 8193);
  const decoder = sdk.createPCloudResourceDecoder(vector.privatePkcs8Der, { publicSpkiDer: vector.publicSpkiDer });
  t.after(() => decoder.dispose());
  f.hooks.resource = call => responseFor(call, vector.ciphertext);
  const bytes = await f.read(), opened = decoder.openResource(bytes, vector.wrapped, '2');
  assert.equal(opened.gcmAuthenticated, false); assert.deepEqual(opened.plaintext, vector.plaintext);
  assert.equal(bytes[8192], vector.plaintext[8192]); assert.equal(f.resourceCalls.length, 1);
  opened.plaintext.fill(0);
});

test('040 core: explicit zero/lower byte limit admits empty only and does not poison later attempts', async t => {
  const f = await fixture(t);
  f.hooks.resource = call => responseFor(call, null, { headers: { 'content-length': '0' } });
  assert.deepEqual(await f.read(undefined, { maxBytes: 0 }), Buffer.alloc(0));
  f.hooks.resource = call => responseFor(call, Buffer.from([1]));
  await assert.rejects(f.read(undefined, { maxBytes: 0 }), fixed('response-limit', { submitted: true }));
  assert.deepEqual(await f.read(undefined, { maxBytes: 1 }), Buffer.from([1]));
  assert.equal(f.resourceCalls.length, 3); assert.ok(f.resourceCalls.every(call => call.url.origin === resourceOrigin));
});
