import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { API } from 'zca-js';
import { CookieJar } from 'tough-cookie';
import { protocolRequest, readProtocolResponse } from '../dist/protocol-request.js';

const key = Buffer.alloc(32, 0x73), path = '/api/backuppc2mb/upload';
function encrypted(data, wrapped = true) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(wrapped ? { error_code: 0, data } : data)), cipher.final()]);
  return Response.json({ error_code: 0, data: bytes.toString('base64') });
}
function decrypt(value) {
  const cipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(Buffer.from(value, 'base64')), cipher.final()]).toString('utf8');
}
function fixture(respond = () => Response.json({ error_code: 0 }), map = {}) {
  const calls = [];
  const api = new API({ uid: '1', imei: 'synthetic-imei', language: 'vi', API_TYPE: 30, API_VERSION: 695,
    cookie: new CookieJar(), secretKey: key.toString('base64'), userAgent: 'Synthetic Backup',
    settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) { const request = { url: new URL(input), init }; calls.push(request); return respond(request); } },
  }, new Proxy(map, { get: (target, name) => Object.hasOwn(target, name) ? target[name]
    : name === 'backuppcmobile' ? undefined : [`https://${String(name)}.fixture.zalo.me`] }), ['wss://fixture.zalo.me']);
  return { api, calls };
}
const request = () => ({ service: 'backuppcmobile', path, method: 'POST',
  params: { bkid: 'opaque:backup', batch_data: '{"last":1,"chunk_id":2,"total_chunk":2,"size":99}' },
  paramsPlacement: 'multipart', multipart: { field: 'file_data', fileName: 'backup_chunk',
    blob: new Blob([Uint8Array.of(1, 2, 255)], { type: 'application/octet-stream' }), paramField: 'param' },
  response: 'plain-envelope' });

test('multipart placement writes singular AES param into the form and preserves common query only', async () => {
  const f = fixture(() => Response.json({ error_code: 0, extra: { preserved: true } }), { backuppcmobile: ['https://backup.fixture.zalo.me'] });
  assert.deepEqual(await protocolRequest(f.api, request()), { error_code: 0, extra: { preserved: true } });
  assert.equal(f.calls.length, 1); const { url, init } = f.calls[0];
  assert.equal(url.origin, 'https://backup.fixture.zalo.me'); assert.equal(url.pathname, path);
  assert.deepEqual(Object.fromEntries(url.searchParams), { zpw_ver: '695', zpw_type: '30' });
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.ok(init.body instanceof ArrayBuffer);
  const form = await new Response(init.body, { headers: init.headers }).formData();
  assert.deepEqual([...form.keys()], ['param', 'file_data']);
  assert.equal(decrypt(form.get('param')), JSON.stringify(request().params));
  const file = form.get('file_data'); assert.equal(file.name, 'backup_chunk'); assert.equal(file.type, 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), Uint8Array.of(1, 2, 255));
});

test('legacy multipart defaults still place encrypted plural params in the URL without a form parameter', async () => {
  const f = fixture(() => encrypted({ original: true })); const value = request();
  delete value.paramsPlacement; delete value.multipart.paramField; delete value.response;
  assert.deepEqual(await protocolRequest(f.api, value), { original: true });
  const { url, init } = f.calls[0];
  assert.deepEqual([...url.searchParams.keys()].sort(), ['params', 'zpw_type', 'zpw_ver']);
  assert.deepEqual(JSON.parse(decrypt(url.searchParams.get('params'))), value.params);
  const form = await new Response(init.body, { headers: init.headers }).formData();
  assert.deepEqual([...form.keys()], ['file_data']); assert.equal(init.redirect, 'error');
});

test('new form placement rejects invalid combinations and oversized field metadata before I/O', async () => {
  const f = fixture(); let starts = 0;
  for (const patch of [{ method: 'GET' }, { multipart: undefined }, { multipart: { ...request().multipart, paramField: undefined } },
    { multipart: { ...request().multipart, paramField: 'params' } }, { paramsPlacement: 'query' }, { params: null }, { params: '' },
    { params: { data: 'x'.repeat(65537) } }]) {
    await assert.rejects(protocolRequest(f.api, { ...request(), ...patch, onRequestStart() { starts++; } }));
  }
  assert.equal(starts, 0); assert.equal(f.calls.length, 0);
});

test('compiled fallback is restricted to this service/path and never mutates the map', async () => {
  const map = {}; const f = fixture(undefined, map);
  await protocolRequest(f.api, request()); assert.equal(f.calls[0].url.origin, 'https://bkpc2mb.zaloapp.com');
  assert.equal(Object.hasOwn(map, 'backuppcmobile'), false);
  for (const patch of [{ path: '/api/backuppc2mb/other' }, { service: 'absent' }]) {
    f.api.zpwServiceMap.absent = undefined;
    await assert.rejects(protocolRequest(f.api, { ...request(), ...patch }), { code: 'unsupported-service' });
  }
  f.api.zpwServiceMap.backuppcmobile = ['http://bkpc2mb.zaloapp.com'];
  await assert.rejects(protocolRequest(f.api, request()), { code: 'unsupported-service' });
  assert.equal(f.calls.length, 1);
});

test('plain-envelope preserves strict status input for its feature owner, enforces HTTP200 and does not AES unwrap', async () => {
  for (const body of [{ error_code: 212, data: 'opaque' }, { error_code: '0' }, {}, { error_code: 0, data: { extension: 1 } }]) {
    assert.deepEqual(await readProtocolResponse(Response.json(body), key.toString('base64'), 'plain-envelope'), body);
  }
  for (const response of [Response.json({ error_code: 0 }, { status: 201 }), new Response(null, { status: 204 }),
    Response.json({ error_code: 0 }, { status: 500 }), Response.json([]), new Response('not-json')]) {
    await assert.rejects(readProtocolResponse(response, key.toString('base64'), 'plain-envelope'));
  }
  assert.deepEqual(await readProtocolResponse(encrypted({ old: true }), key.toString('base64')), { old: true });
  assert.deepEqual(await readProtocolResponse(encrypted({ old: true }), key.toString('base64'), 'encrypted-envelope'), { error_code: 0, data: { old: true } });
  assert.deepEqual(await readProtocolResponse(encrypted({ old: true }, false), key.toString('base64'), 'preview'), undefined);
  assert.equal(await readProtocolResponse(new Response(''), key.toString('base64'), 'polling'), null);
});

test('handoff stays after asynchronous form encoding and cancellation prevents a later transport call', async () => {
  const f = fixture(); const controller = new AbortController(); let starts = 0;
  const original = Response.prototype.arrayBuffer; let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  Response.prototype.arrayBuffer = async function () { entered(); await gate; return Reflect.apply(original, this, []); };
  try {
    const promise = protocolRequest(f.api, { ...request(), signal: controller.signal, onRequestStart() { starts++; } });
    const rejection = assert.rejects(promise, { code: 'aborted' }); await ready;
    assert.equal(starts, 0); assert.equal(f.calls.length, 0); controller.abort(); release(); await rejection;
    assert.equal(starts, 0); assert.equal(f.calls.length, 0);
  } finally { release?.(); Response.prototype.arrayBuffer = original; }
});
