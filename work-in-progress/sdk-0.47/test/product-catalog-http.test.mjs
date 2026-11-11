import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { CookieJar } from 'tough-cookie';
import { API, getProductCatalogItem, deleteProductCatalogItem, ProductCatalogDeleteError, ZaloProtocolError } from 'zalo-personal-sdk';
import { apiFixture, reply, replyDataText, requestParams, withDecodedData, privateText, hostileSignal, onAbort, bounded } from './fixtures/account-api.mjs';
const origin = 'https://catalog.fixture.invalid';
const fixture = respond => apiFixture(API, CookieJar, respond ?? (() => reply({})));
const selected = { productId: ' selected opaque ID ', catalogId: 'catalog-with-no-UID-grammar' };
const gate = () => Promise.withResolvers();
async function reached(g, promise) { assert.equal(await bounded(Promise.race([g.promise.then(() => true), promise.then(() => false, () => false)])), true); }
function safe(error) {
  const text = `${error} ${error.stack} ${JSON.stringify(error)} ${inspect(error)}`;
  assert.equal(text.includes(privateText), false); assert.equal(text.includes(origin), false);
  for (const key of ['cause', 'raw', 'body', 'input', 'url', 'data']) assert.equal(Object.hasOwn(error, key), false);
}
function readError(code, extra = {}) { return error => {
  assert.ok(error instanceof ZaloProtocolError); assert.equal(error.code, code);
  for (const [key, value] of Object.entries(extra)) assert.equal(error[key], value); safe(error); return true;
}; }
function writeError(code, submitted, outcomeUnknown, extra = {}) { return error => {
  assert.ok(error instanceof ProductCatalogDeleteError); assert.equal(error.code, code);
  assert.equal(error.submitted, submitted); assert.equal(error.outcomeUnknown, outcomeUnknown);
  for (const [key, value] of Object.entries(extra)) assert.equal(error[key], value); safe(error); return true;
}; }
function invalid(error) { assert.ok(error instanceof TypeError); safe(error); return true; }
function exact(call, action, expected) {
  assert.equal(call.raw, `${origin}/api/prodcatalog/product/${action}?zpw_ver=695&zpw_type=30`);
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'error');
  const parsed = requestParams(call); assert.deepEqual([...parsed.form.keys()], ['params']); assert.deepEqual(parsed.data, expected);
  assert.notEqual(parsed.encoded, JSON.stringify(expected));
}

test('view uses exactly one catalog POST and returns the direct partial row without requested-ID correlation or item unwrap', async () => {
  const f = fixture(call => { exact(call, 'view', { product_id: selected.productId });
    return reply({ product_id: 'different-returned-ID', owner_id: 'seller', product_name: '', price: '12.00', unknown: { retained: true } }); });
  const result = await getProductCatalogItem(f.api, { productId: selected.productId });
  assert.deepEqual(result.known, { product_id: 'different-returned-ID', owner_id: 'seller', product_name: '', price: '12.00' });
  assert.equal(result.raw.product_id, 'different-returned-ID'); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.raw)); assert.ok(Object.isFrozen(result.known));
  assert.equal(Object.isFrozen(result.raw.unknown), false); assert.equal(Object.hasOwn(result, 'requestedId'), false);
  f.hooks.respond = () => reply({ item: { product_id: 'nested-is-not-unwrapped' }, items: [], future: true });
  const nested = await getProductCatalogItem(f.api, { productId: 'ignored-for-correlation' });
  assert.deepEqual(nested.known, {}); assert.equal(nested.raw.item.product_id, 'nested-is-not-unwrapped'); assert.equal(f.sent.length, 2);
});

test('explicit outgoing IDs preserve numeric/string type, zero/negative values, leading whitespace and UTF8 bounds without lookups', async () => {
  const f = fixture();
  for (const productId of [0, -0, -7, Number.MAX_SAFE_INTEGER, '0', '0001', ' spaced ', 'é'.repeat(128)]) {
    f.hooks.respond = call => { exact(call, 'view', { product_id: productId === 0 ? 0 : productId }); return reply({}); };
    assert.deepEqual((await getProductCatalogItem(f.api, { productId })).known, {});
  }
  for (const productId of [undefined, null, false, '', 'é'.repeat(129), '\ud800', 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) await assert.rejects(getProductCatalogItem(f.api, { productId }), invalid);
  assert.equal(f.sent.length, 8);
});

test('view own-data preflight rejects class/Proxy/accessor/unknown options before dispatch without private getter invocation', async () => {
  const f = fixture(); let reads = 0; const hostile = () => { reads++; throw Error(privateText); };
  const accessor = {}; Object.defineProperty(accessor, 'productId', { get: hostile });
  class Custom { constructor() { this.productId = 'x'; } }
  for (const input of [undefined, null, [], new Custom(), accessor, new Proxy({ productId: 'x' }, { get: hostile, ownKeys: hostile, getPrototypeOf: hostile }),
    { productId: 'x', unknown: undefined }, { productId: 'x', catalogId: 'not-view' }, { productId: 'x', signal: {} }]) await assert.rejects(getProductCatalogItem(f.api, input), invalid);
  assert.equal(reads, 0); assert.equal(f.sent.length, 0);
  await getProductCatalogItem(f.api, Object.assign(Object.create(null), { productId: 'x', signal: undefined })); assert.equal(f.sent.length, 1);
});

test('view qualifies independent optional fields and distinguishes valid empty rows from falsey/array/extra-layer decoded values', async () => {
  const f = fixture(() => reply({ product_id: 'p', owner_id: null, catalog_id: false, product_name: 1, price: 2,
    description: '', currency_unit: 'x'.repeat(256), product_photos: null, create_time: 1.25, future: true }));
  assert.deepEqual((await getProductCatalogItem(f.api, { productId: 'x' })).known,
    { product_id: 'p', description: '', currency_unit: 'x'.repeat(256), product_photos: null, create_time: 1.25 });
  for (const value of [undefined, null, false, 0, '', [], 'raw', '{}']) {
    f.hooks.respond = () => reply(value); await assert.rejects(getProductCatalogItem(f.api, { productId: 'x' }), readError('invalid-response'));
  }
  for (const data of [undefined, null, false, 0, '']) {
    f.hooks.respond = () => Response.json({ error_code: 0, ...(data === undefined ? {} : { data }) });
    await assert.rejects(getProductCatalogItem(f.api, { productId: 'x' }), readError('invalid-response'));
  }
  f.hooks.respond = () => reply({}); assert.deepEqual((await getProductCatalogItem(f.api, { productId: 'x' })).known, {});
});

test('single deletion uses the exact two-parameter POST and returns only frozen ACK wrapper without ID/count/state claims', async () => {
  const f = fixture(call => { exact(call, 'delete', { product_id: selected.productId, catalog_id: selected.catalogId });
    return reply({ wrongEcho: 'not-correlated', version: 9, arbitrary: { kept: true } }); });
  const result = await deleteProductCatalogItem(f.api, selected);
  assert.ok(Object.isFrozen(result)); assert.deepEqual(result.raw, { wrongEcho: 'not-correlated', version: 9, arbitrary: { kept: true } });
  assert.equal(Object.isFrozen(result.raw), false); assert.equal(Object.isFrozen(result.raw.arbitrary), false);
  for (const key of ['deleted', 'productId', 'catalogId', 'count', 'version']) assert.equal(Object.hasOwn(result, key), false);
  assert.equal(f.sent.length, 1);
});

test('deletion parsed outer-success falsey data ACK is undefined, whereas encrypted inner-success returns every inner value unchanged', async () => {
  const f = fixture();
  for (const data of [undefined, null, false, 0, '']) {
    f.hooks.respond = () => Response.json({ error_code: 0, ...(data === undefined ? {} : { data }) });
    const result = await deleteProductCatalogItem(f.api, selected); assert.equal(Object.hasOwn(result, 'raw'), true); assert.equal(result.raw, undefined);
  }
  for (const data of [undefined, null, false, 0, '', 'not-a-JSON-wrapper', [], { any: true }]) {
    f.hooks.respond = () => reply(data); assert.deepEqual((await deleteProductCatalogItem(f.api, selected)).raw, data);
  }
  assert.equal(f.sent.length, 13);
});

test('entirely empty/unparsed HTTP bodies never become deletion ACKs or fabricated view-not-found rows', async () => {
  const f = fixture();
  for (const body of ['', 'not-json', 'null', '[]']) {
    f.hooks.respond = () => new Response(body);
    await assert.rejects(deleteProductCatalogItem(f.api, selected), writeError('submission-unknown', true, true, { providerCode: undefined }));
    await assert.rejects(getProductCatalogItem(f.api, { productId: 'x' }), error => {
      assert.ok(error instanceof ZaloProtocolError); assert.ok(['request-failed', 'invalid-response'].includes(error.code));
      assert.equal(error.providerCode, undefined); safe(error); return true;
    });
  }
  assert.equal(f.sent.length, 8);
});

test('delete lease is per API/exact JSON wire tuple, sharing minuszero/zero but distinguishing number/string and other tuples', async () => {
  const begun = gate(), release = gate(), f = fixture(() => { begun.resolve(); return release.promise; }), other = fixture();
  const pending = deleteProductCatalogItem(f.api, { productId: -0, catalogId: 'c' }); await reached(begun, pending);
  await assert.rejects(deleteProductCatalogItem(f.api, { productId: 0, catalogId: 'c' }), writeError('busy', false, false));
  f.hooks.respond = () => reply(null);
  await deleteProductCatalogItem(f.api, { productId: '0', catalogId: 'c' }); await deleteProductCatalogItem(f.api, { productId: 0, catalogId: 'other' });
  await deleteProductCatalogItem(other.api, { productId: 0, catalogId: 'c' });
  release.resolve(reply(null)); await pending;
  f.hooks.respond = () => reply(null, { innerCode: 212 }); await assert.rejects(deleteProductCatalogItem(f.api, { productId: 0, catalogId: 'c' }), writeError('request-failed', true, false));
  f.hooks.respond = () => { throw Error(privateText); }; await assert.rejects(deleteProductCatalogItem(f.api, { productId: 0, catalogId: 'c' }), writeError('submission-unknown', true, true));
  f.hooks.respond = () => reply(null); await deleteProductCatalogItem(f.api, { productId: 0, catalogId: 'c' });
  assert.equal(f.sent.length, 6); assert.equal(other.sent.length, 1);
});

test('delete snapshots both IDs before await and rejects missing/unsafe/unknown/accessor input without any fallback request', async () => {
  const begun = gate(), release = gate(); let decoded;
  const f = fixture(call => { decoded = requestParams(call).data; begun.resolve(); return release.promise; });
  const input = { productId: 'original', catalogId: 'selected' }, pending = deleteProductCatalogItem(f.api, input);
  input.productId = 'mutated'; input.catalogId = 'mutated'; await reached(begun, pending); assert.deepEqual(decoded, { product_id: 'original', catalog_id: 'selected' });
  release.resolve(reply(null)); await pending;
  let reads = 0; const accessor = { productId: 'x' }; Object.defineProperty(accessor, 'catalogId', { get() { reads++; throw Error(privateText); } });
  for (const value of [{ productId: 'x' }, { productId: null, catalogId: 'x' }, { productId: 'x', catalogId: '' }, { productId: 'x', catalogId: 1.5 },
    { ...selected, itemIds: undefined }, accessor, { ...selected, signal: {} }]) await assert.rejects(deleteProductCatalogItem(f.api, value), invalid);
  assert.equal(reads, 0); assert.equal(f.sent.length, 1);
});

test('current decoded safe refusals stay known, while caller-created or previously issued public errors do not certify either current operation', async () => {
  const f = fixture(() => reply(null, { innerCode: 212 })); let issued;
  try { await getProductCatalogItem(f.api, { productId: 'x' }); } catch (error) { issued = error; }
  assert.ok(issued instanceof ZaloProtocolError); assert.equal(issued.providerCode, 212);
  await assert.rejects(deleteProductCatalogItem(f.api, selected), writeError('request-failed', true, false, { providerCode: 212 }));
  f.hooks.respond = () => reply(null, { outerCode: -205 });
  await assert.rejects(getProductCatalogItem(f.api, { productId: 'x' }), readError('request-failed', { providerCode: -205 }));
  const forged = new ZaloProtocolError('request-failed', 200, 212);
  for (const [thrown, expectedReadCode] of [[forged, 'request-failed'], [issued, 'request-failed'],
    [new ProductCatalogDeleteError('request-failed', true, false, 212, 200), 'invalid-response']]) {
    f.hooks.respond = () => { const response = new Response('unread'); response.text = async () => { throw thrown; }; return response; };
    await assert.rejects(getProductCatalogItem(f.api, { productId: 'x' }), error => { assert.notEqual(error, thrown); return readError(expectedReadCode, { providerCode: undefined })(error); });
    await assert.rejects(deleteProductCatalogItem(f.api, selected), error => { assert.notEqual(error, thrown); return writeError('submission-unknown', true, true, { providerCode: undefined })(error); });
  }
  assert.equal(f.sent.length, 9);
});

test('POST-DECODE custom row/ACK policy keeps shallow references and permits only mandatory Promise then probes on opaque raw ACKs', async () => {
  const f = fixture(); let reads = 0, thenReads = 0; const hostile = () => { reads++; throw Error(privateText); };
  const getter = {}; Object.defineProperty(getter, 'product_name', { enumerable: true, get: hostile });
  await assert.rejects(withDecodedData(f, getter, () => getProductCatalogItem(f.api, { productId: 'x' })), readError('invalid-response'));
  const opaque = new Proxy({}, { get(_target, key) { if (key === 'then') { thenReads++; return undefined; } return hostile(); }, ownKeys: hostile, getPrototypeOf: hostile });
  const result = await withDecodedData(f, opaque, () => deleteProductCatalogItem(f.api, selected));
  assert.equal(result.raw, opaque); assert.ok(Object.isFrozen(result)); assert.ok(thenReads > 0); assert.equal(reads, 0);
  const data = { arbitrary: { untouched: true } };
  const ack = await withDecodedData(f, data, () => deleteProductCatalogItem(f.api, selected));
  assert.equal(ack.raw, data); assert.equal(Object.isFrozen(data), false); assert.equal(Object.isFrozen(data.arbitrary), false);
});

test('both RPCs use intrinsic-safe genuine signals with fixed pre/post-abort errors and resistant listener cleanup', async () => {
  for (const write of [false, true]) {
    const invoke = (api, signal) => write ? deleteProductCatalogItem(api, { ...selected, signal }) : getProductCatalogItem(api, { productId: 'x', signal });
    const f = fixture(), pre = new AbortController(); pre.abort(privateText);
    await assert.rejects(invoke(f.api, pre.signal), write ? writeError('aborted', false, false) : readError('aborted')); assert.equal(f.sent.length, 0);
    let reads = 0; const trap = () => { reads++; throw Error(privateText); }, good = hostileSignal(trap), initial = good.listeners();
    await invoke(f.api, good.signal); assert.equal(good.listeners(), initial);
    const active = hostileSignal(trap, true), before = active.listeners(), begun = gate(), release = gate(); release.promise.catch(() => {});
    f.hooks.respond = call => { onAbort(call.init.signal, () => release.reject(Error(privateText))); begun.resolve(); return release.promise; };
    const pending = invoke(f.api, active.signal), observed = assert.rejects(pending, write ? writeError('aborted', true, true, { providerCode: undefined }) : readError('aborted', { providerCode: undefined }));
    try { await reached(begun, pending); active.controller.abort(privateText); await bounded(observed); assert.equal(active.stopped(), 1); assert.equal(active.listeners(), before); assert.equal(reads, 0); }
    finally { release.reject(Error(privateText)); active.cleanup(); await observed.catch(() => {}); }
  }
});

test('strict201 and redirects never read a body or replay; redirects cancel readable bodies and catalog headers do not borrow other service cookies', async () => {
  const f = fixture();
  for (const write of [false, true]) for (const spec of [{ status: 201 }, { status: 302 }, { status: 200, location: '' }]) {
    const before = f.sent.length; let reads = 0, cancels = 0;
    f.hooks.respond = call => {
      if (f.sent.length > before + 1) return reply({});
      const headers = new Headers(call.init.headers); assert.equal(headers.get('user-agent'), 'Synthetic032');
      assert.equal((headers.get('cookie') ?? '').includes('profile_fixture='), false); assert.equal((headers.get('cookie') ?? '').includes('file_fixture='), false);
      const response = new Response(new ReadableStream({ cancel() { cancels++; } }), { status: spec.status });
      if (Object.hasOwn(spec, 'location')) response.headers.set('Location', spec.location);
      response.text = () => { reads++; throw Error(privateText); }; return response;
    };
    const pending = write ? deleteProductCatalogItem(f.api, selected) : getProductCatalogItem(f.api, { productId: 'x' });
    await assert.rejects(pending, write ? writeError('submission-unknown', true, true, { providerCode: undefined }) : readError('request-failed', { providerCode: undefined }));
    assert.equal(f.sent.length, before + 1); assert.equal(reads, 0); if (spec.status !== 201) assert.equal(cancels, 1);
  }
});

test('local callback/status faults remain fresh fixed errors and missing catalog service never triggers a fallback', async () => {
  const f = fixture();
  for (const [respond, expectedReadCode] of [[() => { throw Error(privateText); }, 'request-failed'],
    [() => { const response = new Response('{}'); Object.defineProperty(response, 'status', { get() { throw Error(privateText); } }); return response; }, 'invalid-response']]) {
    f.hooks.respond = respond;
    await assert.rejects(getProductCatalogItem(f.api, { productId: 'x' }), readError(expectedReadCode, { providerCode: undefined }));
    await assert.rejects(deleteProductCatalogItem(f.api, selected), writeError('submission-unknown', true, true, { providerCode: undefined }));
  }
  f.api.zpwServiceMap.catalog = [];
  await assert.rejects(getProductCatalogItem(f.api, { productId: 'x' }), readError('unsupported-service'));
  await assert.rejects(deleteProductCatalogItem(f.api, selected), writeError('unsupported-service', false, false)); assert.equal(f.sent.length, 4);
});
