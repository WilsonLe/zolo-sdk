import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { inspect } from 'node:util';
import test from 'node:test';
import {
  acquireCloudMediaViewer, restoreCloudMediaViewer, getCloudDownloadUrls,
  getCloudMediaQueuePage, CloudMediaError, ZaloProtocolError,
} from 'zalo-personal-sdk';
import {
  accountKey, accountReply, authOrigin, cloudBase, cloudCipher, cloudReply,
  cookies, defaultCloudKey, queueFixture, readCloudRequest, uid, viewerHeader,
} from './fixtures/cloud-queue.mjs';

const wrappingKey = Buffer.alloc(32, 0x38);
const privateText = 'private-queue-adapter-or-accessor-value';
const gate = () => Promise.withResolvers();
const emptyPage = (lastNoiseId = '', hasMore = false) => ({ mediaItems: [], lastNoiseId, hasMore });

function fixed(code, details = {}) {
  return error => {
    assert.ok(error instanceof CloudMediaError);
    if (code !== undefined) assert.equal(error.code, code);
    assert.equal(error.stage, 'queue');
    assert.equal(error.outcomeUnknown, false);
    for (const [key, value] of Object.entries(details)) assert.equal(error[key], value);
    for (const key of ['cause', 'raw', 'data', 'frame', 'headers', 'cookie', 'url', 'cursor', 'viewer_key', 'enk']) {
      assert.equal(Object.hasOwn(error, key), false);
    }
    const text = `${String(error)} ${JSON.stringify(error)} ${inspect(error)}`;
    for (const value of [privateText, viewerHeader, uid, defaultCloudKey.toString('base64')]) {
      assert.equal(text.includes(value), false);
    }
    return true;
  };
}

async function bounded(promise, timeout = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Synthetic queue fixture expected prompt progress.')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function reached(entered, pending) {
  const result = await bounded(Promise.race([
    entered.promise.then(() => true), pending.then(() => false, () => false),
  ]));
  assert.equal(result, true, 'Actual synthetic HTTP handoff must precede the held-operation assertion.');
}

function observeRejection(pending, expected) {
  return assert.rejects(pending, expected).then(() => ({}), error => ({ error }));
}
async function checkRejection(observed) {
  const result = await bounded(observed, 500);
  if (Object.hasOwn(result, 'error')) throw result.error;
}

async function ready(t, options) {
  const f = await queueFixture(t, options);
  const viewer = await acquireCloudMediaViewer(f.connection);
  t.after(() => viewer.dispose());
  assert.equal(f.operationCalls.length, 1);
  return { ...f, viewer };
}

function exactRequest(call, cursor, source, key, base = cloudBase, header = viewerHeader) {
  const target = new URL(base);
  assert.equal(call.url.origin, target.origin);
  assert.equal(call.url.pathname, `${target.pathname.replace(/\/$/, '')}/cloudmedia/queue/pc/verify`);
  assert.equal(call.init.method, 'GET'); assert.equal(call.init.body, undefined);
  assert.equal(call.init.redirect, 'error');
  assert.deepEqual([...call.url.searchParams.keys()], ['zpw_ver', 'zpw_type', 'params']);
  assert.equal(call.url.searchParams.get('zpw_ver'), '695');
  assert.equal(call.url.searchParams.get('zpw_type'), '30');
  const parsed = readCloudRequest(call, key);
  const expected = JSON.stringify({ lastNoiseId: cursor, loadType: 1, listNoiseIds: [], tracking_source: source });
  assert.equal(parsed.plaintext, expected);
  assert.equal(cloudCipher(key, expected, parsed.packet.subarray(0, 16)), parsed.encoded);
  assert.ok(call.raw.includes(`params=${encodeURIComponent(parsed.encoded)}`));
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('cloud-viewer-key'), header);
  assert.equal(headers.get('user-agent'), 'Synthetic Cloud SDK');
  assert.equal(headers.get('accept'), 'application/json, text/plain, */*');
  assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
  for (const field of ['imei', 'language', 'signkey', 'pageSize', 'direction', 'msgId']) {
    assert.equal(Object.hasOwn(parsed.params, field), false);
  }
  return parsed;
}

function rawReply(key, text, code = 0, extraString = false) {
  return Response.json({ error_code: code, data: cloudCipher(key, extraString ? JSON.stringify(text) : text) });
}

test('complete explicit initial page, continuation and caller-selected locator workflow never commits or pumps the queue', async t => {
  const f = await ready(t);
  const rows = [
    { action: 1, noiseId: 'noise/add', actionType: 1, ts: 8, cliTs: 9,
      msgInfo: { cliMsgId: '0007', srcId: '0', destId: '99', destType: 6, ts: 7, glbMsgId: 'opaque-global' }, mediaInfo: { mediaSize: 55 } },
    { action: 2, noiseId: 'noise/remove', msgInfo: { extInfo: { orgMsgs: ['0007', '0007'] } } },
    { action: 3, noiseId: 'noise/thread', msgInfo: { destType: 6, destId: '99' } },
    { action: 4, noiseId: 'noise/temp', temp: true },
    { action: 5, noiseId: 'noise/reset', ts: 2 },
    { action: 6, noiseId: 'noise/duplicate' },
    { action: 999, future: { opaque: ['kept'] } },
  ];
  f.hooks.queue = call => {
    exactRequest(call, '', 0, f.key);
    const selected = cookies(call);
    assert.equal(selected.get('cloud_root'), 'cloud_root'); assert.equal(selected.get('queue_path'), 'queue_path');
    for (const key of ['auth_root', 'auth_viewer', 'cloud_path', 'cloud_wrong_path', 'other_host']) assert.equal(selected.has(key), false);
    return cloudReply(f.key, { mediaItems: rows, lastNoiseId: '000000-next/+', hasMore: true, future: { preserved: [1, 2] } });
  };
  const page = await getCloudMediaQueuePage(f.connection, f.viewer, '');
  assert.deepEqual(page.mediaItems, rows); assert.equal(page.lastNoiseId, '000000-next/+');
  assert.equal(page.hasMore, true); assert.equal(page.responseCode, 0);
  assert.deepEqual(page.raw.future, { preserved: [1, 2] });
  assert.equal(f.operationCalls.length, 2, 'Returning a continuation never performs its next request.');
  rows[0].msgInfo.destId = 'caller-mutated'; rows[6].future.opaque.push('caller-mutated');
  assert.equal(page.mediaItems[0].msgInfo.destId, '99'); assert.deepEqual(page.mediaItems[6].future.opaque, ['kept']);
  f.hooks.queue = call => {
    exactRequest(call, page.lastNoiseId, 4, f.key);
    return cloudReply(f.key, emptyPage('last opaque cursor', false));
  };
  const final = await getCloudMediaQueuePage(f.connection, f.viewer, page.lastNoiseId, { trackingSource: 4 });
  assert.deepEqual(final.mediaItems, []); assert.equal(final.hasMore, false); assert.equal(final.lastNoiseId, 'last opaque cursor');
  f.hooks.locators = call => {
    assert.deepEqual(readCloudRequest(call, f.key).params, { list_noise_ids: ['noise/add'] });
    return cloudReply(f.key, { download_urls: { 'noise/add': 'opaque-selected-locator' } });
  };
  assert.equal((await getCloudDownloadUrls(f.connection, f.viewer, ['noise/add'])).downloadUrls['noise/add'], 'opaque-selected-locator');
  assert.deepEqual(f.operationCalls.map(call => call.url.pathname), [
    '/api/getCloudViewerKey', f.queuePath, f.queuePath, f.cloudPath,
  ]);
});

test('provider order, duplicate noise IDs and nonunique message tuples remain raw without identity normalization or winner selection', async t => {
  const f = await ready(t);
  const text = '{"mediaItems":[{"noiseId":"same","msgInfo":{"cliMsgId":"0007","srcId":0,"destId":"1","destType":0,"ts":10},"zKey":"0007_1_0"},{"noiseId":"same","msgInfo":{"cliMsgId":"0007","srcId":0,"destId":"1","destType":0,"ts":1},"zKey":"0007_1_0"},{"action":5,"msgInfo":{"destId":"88","destType":6}},{"unknown":{"__proto__":{"retained":true},"constructor":"own"},"id":900719925474099312345}],"lastNoiseId":"opaque","hasMore":false,"__proto__":{"root":true}}';
  f.hooks.queue = () => rawReply(f.key, text);
  const page = await getCloudMediaQueuePage(f.connection, f.viewer, '');
  assert.equal(page.mediaItems.length, 4);
  assert.equal(page.mediaItems[0].msgInfo.ts, 10); assert.equal(page.mediaItems[1].msgInfo.ts, 1);
  assert.equal(page.mediaItems[0].noiseId, page.mediaItems[1].noiseId);
  assert.equal(page.mediaItems[0].msgInfo.srcId, '0'); assert.equal(page.mediaItems[2].msgInfo.destId, '88');
  assert.equal(page.mediaItems[3].id, '900719925474099312345');
  assert.equal(Object.hasOwn(page.mediaItems[3].unknown, '__proto__'), true);
  assert.deepEqual(page.mediaItems[3].unknown.__proto__, { retained: true });
  assert.equal(Object.hasOwn(page.raw, '__proto__'), true);
  for (const value of [page, page.mediaItems, page.mediaItems[0], page.mediaItems[0].msgInfo, page.raw, page.mediaItems[3].unknown.__proto__]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { page.mediaItems[0].msgInfo.srcId = 'changed'; }, TypeError);
  assert.throws(() => { page.mediaItems.push({}); }, TypeError);
  assert.equal(f.operationCalls.length, 2);
});

test('hasMore follows original JSON truthiness including negative zero and preserves separate lossless raw values', async t => {
  const f = await ready(t);
  const variants = [
    ['false', false, false], ['0', false, 0], ['-0', false, undefined], ['null', false, null], ['""', false, ''],
    ['"0"', true, '0'], ['[]', true, []], ['{}', true, {}], ['1', true, 1], ['-1', true, -1],
    ['900719925474099312345', true, '900719925474099312345'],
  ];
  for (const [token, expected, rawExpected] of variants) {
    f.hooks.queue = () => rawReply(f.key, `{"mediaItems":[],"lastNoiseId":"","hasMore":${token}}`);
    const page = await getCloudMediaQueuePage(f.connection, f.viewer, '');
    assert.equal(page.hasMore, expected, token);
    assert.equal(Object.hasOwn(page.raw, 'hasMore'), true);
    if (token !== '-0') assert.deepEqual(page.raw.hasMore, rawExpected);
  }
  assert.equal(f.operationCalls.length, 1 + variants.length);
});

test('explicit cursor grammar preserves opaque and maximum UTF8 strings and rejects coercion before I/O without executing accessors', async t => {
  const f = await ready(t); let reads = 0;
  const hostile = () => { reads++; throw new Error(privateText); };
  const coercive = { toString: hostile, valueOf: hostile };
  const proxy = new Proxy({}, { getPrototypeOf: hostile, get: hostile, getOwnPropertyDescriptor: hostile });
  for (const cursor of [undefined, null, 0, -0, false, 1n, coercive, proxy, new String('x'), 'x'.repeat(257), 'é'.repeat(129), '\u0000', '\n', '\u007f', '\ud800', '\udc00']) {
    await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, cursor), fixed('invalid-input', { submitted: false, providerCode: undefined }));
  }
  assert.equal(reads, 0); assert.equal(f.operationCalls.length, 1);
  for (const cursor of ['', '000000001', '900719925474099312345678901234567890', ' Noise:/+_AbC ', 'x'.repeat(256), 'é'.repeat(128)]) {
    f.hooks.queue = call => { exactRequest(call, cursor, 0, f.key); return cloudReply(f.key, emptyPage(cursor)); };
    assert.equal((await getCloudMediaQueuePage(f.connection, f.viewer, cursor)).lastNoiseId, cursor);
  }
});

test('tracking options accept only explicit own numeric0..4 and no inherited/getter/proxy/unknown metadata', async t => {
  const f = await ready(t); let reads = 0;
  const hostile = () => { reads++; throw new Error(privateText); };
  const getter = {}; Object.defineProperty(getter, 'trackingSource', { enumerable: true, get: hostile });
  const signalGetter = {}; Object.defineProperty(signalGetter, 'signal', { enumerable: true, get: hostile });
  const proxy = new Proxy({}, { getPrototypeOf: hostile, ownKeys: hostile, getOwnPropertyDescriptor: hostile });
  const invalid = [null, [], new Date(), Object.create({ trackingSource: 1 }), getter, signalGetter, proxy,
    { trackingSource: '1' }, { trackingSource: NaN }, { trackingSource: Infinity }, { trackingSource: 1.5 },
    { trackingSource: -1 }, { trackingSource: 5 }, { trackingSource: new Number(1) }, { direction: 0 },
    { listNoiseIds: [] }, { pageSize: 20 }, { signal: {} }, { signal: new Proxy(new AbortController().signal, {}) }];
  for (const settings of invalid) await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, '', settings), fixed('invalid-input', { submitted: false }));
  assert.equal(reads, 0); assert.equal(f.operationCalls.length, 1);
  for (const settings of [undefined, {}, { trackingSource: undefined }, ...[0, 1, 2, 3, 4].map(trackingSource => ({ trackingSource }))]) {
    f.hooks.queue = call => { exactRequest(call, '', settings?.trackingSource ?? 0, f.key); return cloudReply(f.key, emptyPage()); };
    assert.equal((await getCloudMediaQueuePage(f.connection, f.viewer, '', settings)).hasMore, false);
  }
});

test('mutable settings are captured before await and do not alter a held request or its signal ownership', async t => {
  const f = await ready(t), entered = gate(), release = gate();
  const controller = new AbortController(), settings = { trackingSource: 1, signal: controller.signal };
  f.hooks.queue = async call => { exactRequest(call, 'stable', 1, f.key); entered.resolve(); await release.promise; return cloudReply(f.key, emptyPage('stable')); };
  const pending = getCloudMediaQueuePage(f.connection, f.viewer, 'stable', settings);
  settings.trackingSource = 4; settings.signal = new AbortController().signal;
  try { await reached(entered, pending); } finally { release.resolve(); }
  assert.equal((await pending).lastNoiseId, 'stable'); assert.equal(f.operationCalls.length, 2);
});

test('all three own response fields are required and absent or falsey useful data never fabricates an empty page', async t => {
  const f = await ready(t);
  for (const data of [undefined, null, false, 0, '', '']) {
    f.hooks.queue = () => Response.json({ error_code: 0, data });
    await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('invalid-response', { submitted: true }));
  }
  for (const raw of [null, false, 0, 'not-an-object', [], {}, { mediaItems: [], lastNoiseId: '' },
    { mediaItems: [], hasMore: false }, { lastNoiseId: '', hasMore: false }]) {
    f.hooks.queue = () => cloudReply(f.key, raw);
    await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('invalid-response', { submitted: true }));
  }
  for (const field of ['mediaItems', 'lastNoiseId', 'hasMore']) {
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, field);
    Object.defineProperty(Object.prototype, field, { configurable: true, value: emptyPage()[field] });
    try {
      const response = emptyPage(); delete response[field];
      f.hooks.queue = () => cloudReply(f.key, response);
      await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('invalid-response', { submitted: true }));
    } finally {
      if (prior) Object.defineProperty(Object.prototype, field, prior); else delete Object.prototype[field];
    }
  }
});

test('only original JSON string response cursors qualify, including through the optional extra text layer', async t => {
  const f = await ready(t);
  for (const token of ['0', '-0', '900719925474099312345678901234567890', 'true', 'false', 'null', '{}', '[]']) {
    for (const extra of [false, true]) {
      f.hooks.queue = () => rawReply(f.key, `{"mediaItems":[],"lastNoiseId":${token},"hasMore":false}`, 0, extra);
      await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('invalid-response', { submitted: true }));
    }
  }
  for (const cursor of ['', '0001', '900719925474099312345678901234567890', 'opaque/AbC +', 'é'.repeat(128)]) {
    f.hooks.queue = () => cloudReply(f.key, emptyPage(cursor), { extraString: true });
    assert.equal((await getCloudMediaQueuePage(f.connection, f.viewer, '')).lastNoiseId, cursor);
  }
  for (const cursor of ['x'.repeat(257), 'é'.repeat(129), '\n', '\u007f', '\ud800']) {
    f.hooks.queue = () => cloudReply(f.key, emptyPage(cursor));
    await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('invalid-response', { submitted: true }));
  }
});

test('empty and repeated-cursor pages remain valid even when hasMore is true without hidden progress or termination rules', async t => {
  const f = await ready(t);
  f.hooks.queue = call => { exactRequest(call, 'same', 0, f.key); return cloudReply(f.key, emptyPage('same', true)); };
  for (let index = 0; index < 2; index++) {
    const page = await getCloudMediaQueuePage(f.connection, f.viewer, 'same');
    assert.equal(page.lastNoiseId, 'same'); assert.equal(page.hasMore, true); assert.deepEqual(page.mediaItems, []);
    assert.equal(f.operationCalls.length, 2 + index);
  }
  f.hooks.queue = () => cloudReply(f.key, emptyPage('', false));
  assert.equal((await getCloudMediaQueuePage(f.connection, f.viewer, 'same')).lastNoiseId, '');
  assert.equal(f.operationCalls.length, 4);
});

test('separate cloud AES16/24/32, fresh request IVs, accepted outer statuses and no inner gate reproduce independent packets', async t => {
  for (const length of [16, 24, 32]) {
    const f = await ready(t, { cloudKey: Buffer.alloc(length, length) }), packets = [];
    assert.notDeepEqual(f.key, accountKey);
    for (const code of [0, -904, '0', '-904']) {
      f.hooks.queue = call => {
        packets.push(exactRequest(call, 'same', 2, f.key).packet);
        return cloudReply(f.key, { ...emptyPage('next'), error_code: 212, data: { noInnerUnwrap: true } }, { code, extraString: typeof code === 'string' });
      };
      const page = await getCloudMediaQueuePage(f.connection, f.viewer, 'same', { trackingSource: 2 });
      assert.equal(page.responseCode, Number(code)); assert.equal(page.raw.error_code, 212);
      assert.deepEqual(page.raw.data, { noInnerUnwrap: true });
    }
    assert.equal(new Set(packets.map(packet => packet.subarray(0, 16).toString('hex'))).size, 4);
    assert.equal(f.operationCalls.filter(call => call.url.pathname === '/api/getCloudViewerKey').length, 1);
  }
});

test('canonical owned refusals stay explicit while aliases and non200 bodies never provide status authority or trigger refresh', async t => {
  const f = await ready(t);
  for (const code of [-1, -205, 212, '-205', '212', Number.MAX_SAFE_INTEGER]) {
    f.hooks.queue = () => Response.json({ error_code: code, data: privateText });
    await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('rejected', { submitted: true, providerCode: Number(code) }));
  }
  for (const code of [undefined, null, false, [], {}, '00', '-0904', '-0', '+212', '2e2', 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    f.hooks.queue = () => Response.json({ error_code: code, data: cloudCipher(f.key, JSON.stringify(emptyPage())) });
    await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('invalid-response', { submitted: true, providerCode: undefined }));
  }
  f.hooks.queue = () => Response.json({ error_code: 212, data: privateText }, { status: 503 });
  await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('request-failed', { submitted: true, providerCode: undefined, status: 503 }));
  assert.equal(f.operationCalls.filter(call => call.url.pathname === '/api/getCloudViewerKey').length, 1);
  assert.equal(f.operationCalls.length, 20);
});

test('malformed Base64, IV, blocks, padding, UTF8 and more than one extra JSON text layer cannot yield a page', async t => {
  const f = await ready(t), cipher = createCipheriv('aes-256-cbc', f.key, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  const badPadding = Buffer.concat([Buffer.alloc(16), cipher.update(Buffer.alloc(16)), cipher.final()]).toString('base64');
  const invalidUtf8 = Buffer.concat([Buffer.from('{"mediaItems":[],"lastNoiseId":"'), Buffer.from([0xc3, 0x28]), Buffer.from('","hasMore":false}')]);
  for (const data of ['not-base64!', Buffer.alloc(15).toString('base64'), Buffer.alloc(31).toString('base64'), badPadding,
    cloudCipher(f.key, invalidUtf8), cloudCipher(f.key, JSON.stringify(JSON.stringify(JSON.stringify(emptyPage()))))]) {
    f.hooks.queue = () => Response.json({ error_code: 0, data });
    await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('invalid-response', { submitted: true }));
  }
  assert.equal(f.operationCalls.length, 7);
});

test('ordinary object rows and the 1000-row bound are enforced without fabricating per-record schemas', async t => {
  const f = await ready(t);
  const maximum = Array.from({ length: 1000 }, (_, index) => ({ unknownAction: index, nested: { kept: true } }));
  f.hooks.queue = () => cloudReply(f.key, { ...emptyPage(), mediaItems: maximum });
  assert.deepEqual((await getCloudMediaQueuePage(f.connection, f.viewer, '')).mediaItems, maximum);
  for (const rows of [undefined, null, false, {}, [null], [[]], [0], [false], ['row'], [undefined], new Array(1)]) {
    f.hooks.queue = () => cloudReply(f.key, { ...emptyPage(), mediaItems: rows });
    await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('invalid-response', { submitted: true }));
  }
  f.hooks.queue = () => cloudReply(f.key, { ...emptyPage(), mediaItems: Array.from({ length: 1001 }, () => ({})) });
  await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('response-limit', { submitted: true }));
});

test('raw depth and node budgets fail with response-limit rather than silently truncating rows or raw extras', async t => {
  const f = await ready(t);
  let deep = {}; for (let index = 0; index < 33; index++) deep = { nested: deep };
  for (const extra of [{ deep }, { tooMany: new Array(20_001).fill(0) }]) {
    f.hooks.queue = () => cloudReply(f.key, { ...emptyPage(), ...extra });
    await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('response-limit', { submitted: true }));
  }
  f.hooks.queue = () => cloudReply(f.key, { ...emptyPage(), future: { kept: [1, 2, { raw: 'value' }] } });
  const page = await getCloudMediaQueuePage(f.connection, f.viewer, '');
  assert.deepEqual(page.raw.future, { kept: [1, 2, { raw: 'value' }] });
  assert.ok(Object.isFrozen(page.raw.future.kept[2]));
});

test('headers and body deadlines and response byte caps remain owned by the approved Desktop connection', async t => {
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  for (const body of [false, true]) {
    const f = await ready(t, { requestTimeoutMs: 20 });
    f.hooks.queue = () => body ? new Response(new ReadableStream()) : new Promise(() => {});
    await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('timed-out', { submitted: true, providerCode: undefined }));
    assert.equal(f.operationCalls.length, 2);
  }
  const f = await ready(t, { maxResponseBytes: 8192 });
  f.hooks.queue = () => new Response('x'.repeat(9000));
  await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('response-limit', { submitted: true }));
});

test('first owned service prefix and full-path cookie selection/update are used without forwarding account or unrelated cookies', async t => {
  for (const base of ['https://zcloud.fixture.zalo.me/api', 'https://zcloud.fixture.zalo.me/another/prefix']) {
    const f = await ready(t, { cloudBase: base });
    let count = 0;
    f.hooks.queue = call => {
      exactRequest(call, '', 0, f.key, base); const selected = cookies(call);
      assert.equal(selected.get('queue_path'), 'queue_path'); assert.equal(selected.get('cloud_root'), 'cloud_root');
      assert.equal(selected.has('cloud_path'), false); assert.equal(selected.has('auth_root'), false);
      assert.equal(selected.has('other_host'), false); assert.equal(selected.has('bad_domain'), false);
      if (count++) assert.equal(selected.get('queue_added'), 'scoped');
      const headers = new Headers();
      headers.append('set-cookie', `queue_added=scoped; Secure; Path=${f.queuePath}`);
      headers.append('set-cookie', 'bad_domain=excluded; Secure; Domain=unrelated.invalid; Path=/');
      return cloudReply(f.key, emptyPage(), { headers });
    };
    await getCloudMediaQueuePage(f.connection, f.viewer, ''); await getCloudMediaQueuePage(f.connection, f.viewer, '');
    f.hooks.locators = call => { assert.equal(cookies(call).has('queue_added'), false); return cloudReply(f.key, { download_urls: {} }); };
    await getCloudDownloadUrls(f.connection, f.viewer, ['x']);
    assert.equal(f.operationCalls.length, 4);
  }
  for (const config of [{ omitZcloud: true }, { zcloudOrigins: [] }]) {
    const f = await ready(t, config);
    f.hooks.queue = call => { exactRequest(call, '', 0, f.key, 'https://zcld.chat.zalo.me'); return cloudReply(f.key, emptyPage()); };
    await getCloudMediaQueuePage(f.connection, f.viewer, '');
  }
});

test('public context, custom and snapshot decoys cannot replace captured service/client/account/cloud identity', async t => {
  const f = await ready(t); let decoys = 0;
  f.api.custom('__queueFixtureContextDecoy', ({ ctx }) => {
    ctx.secretKey = Buffer.alloc(32, 0x7a).toString('base64'); ctx.loginInfo.zpw_enk = ctx.secretKey;
    ctx.API_VERSION = 1; ctx.API_TYPE = 2; ctx.uid = 'different'; ctx.userAgent = 'decoy-agent';
    ctx.zpwServiceMap.zcloud[0] = 'https://unrelated.invalid';
    ctx.cookie = { getCookieString() { decoys++; throw new Error(privateText); } };
  });
  await f.api.__queueFixtureContextDecoy();
  f.connection.snapshot = () => { throw new Error(privateText); };
  f.api.getOwnId = () => { throw new Error(privateText); };
  f.api.custom = () => { throw new Error(privateText); };
  f.hooks.queue = call => { exactRequest(call, '', 0, defaultCloudKey); return cloudReply(defaultCloudKey, emptyPage('owned')); };
  assert.equal((await getCloudMediaQueuePage(f.connection, f.viewer, '')).lastNoiseId, 'owned');
  assert.equal(decoys, 0);
});

test('sealed matching reconnect uses its own current service map while fake/copied/proxy and mismatched resource bindings fail before HTTP', async t => {
  const f = await ready(t), sealed = f.viewer.sealState(wrappingKey); f.close();
  const next = await queueFixture(t, { cloudBase: 'https://next-cloud.fixture.zalo.me/owned/api' });
  const restored = restoreCloudMediaViewer(next.connection, sealed, wrappingKey); t.after(() => restored.dispose());
  next.hooks.queue = call => { exactRequest(call, 'continue', 0, defaultCloudKey, next.base); return cloudReply(defaultCloudKey, emptyPage()); };
  await getCloudMediaQueuePage(next.connection, restored, 'continue'); assert.equal(next.operationCalls.length, 1);
  let traps = 0;
  const hostile = () => { traps++; throw new Error(privateText); };
  for (const connection of [{ ...next.connection }, new Proxy(next.connection, { get: hostile, getPrototypeOf: hostile })]) {
    await assert.rejects(getCloudMediaQueuePage(connection, restored, ''), fixed('invalid-connection', { submitted: false }));
  }
  for (const viewer of [{ ...restored }, new Proxy(restored, { get: hostile, getPrototypeOf: hostile })]) {
    await assert.rejects(getCloudMediaQueuePage(next.connection, viewer, ''), fixed('invalid-viewer', { submitted: false }));
  }
  const other = await queueFixture(t, { uid: '9300000000000002802' });
  await assert.rejects(getCloudMediaQueuePage(other.connection, restored, ''), fixed('invalid-viewer', { submitted: false }));
  assert.equal(traps, 0); assert.equal(other.operationCalls.length, 0); assert.equal(next.operationCalls.length, 1);
});

test('pre-abort and propagation-resistant genuine signals avoid own property traps and never expose cancellation reasons', async t => {
  const f = await ready(t), already = new AbortController(); already.abort(privateText);
  await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, '', { signal: already.signal }), fixed('aborted', { submitted: false }));
  assert.equal(f.operationCalls.length, 1);
  const controller = new AbortController(), entered = gate(); let reads = 0, blocked = 0;
  controller.signal.addEventListener('abort', event => { blocked++; event.stopImmediatePropagation(); }, { once: true });
  for (const key of ['aborted', 'addEventListener', 'removeEventListener']) {
    Object.defineProperty(controller.signal, key, { get() { reads++; throw new Error(privateText); } });
  }
  f.hooks.queue = () => { entered.resolve(); return new Promise(() => {}); };
  const pending = getCloudMediaQueuePage(f.connection, f.viewer, '', { signal: controller.signal });
  const observed = observeRejection(pending, fixed('aborted', { submitted: true, providerCode: undefined }));
  await reached(entered, pending); controller.abort(privateText); await checkRejection(observed);
  assert.equal(reads, 0); assert.equal(blocked, 1); assert.equal(f.operationCalls.length, 2);
});

test('viewer disposal and connection closure promptly end owned work and late responses do not become pages or follow-up requests', async t => {
  for (const end of ['dispose', 'close']) {
    const f = await ready(t), entered = gate(), release = gate();
    f.hooks.queue = () => { entered.resolve(); return release.promise; };
    const pending = getCloudMediaQueuePage(f.connection, f.viewer, '');
    const observed = observeRejection(pending, fixed(end === 'close' ? 'closed' : undefined, { submitted: true, providerCode: undefined }));
    try {
      await reached(entered, pending);
      if (end === 'dispose') f.viewer.dispose(); else f.close();
      await checkRejection(observed);
    } finally { release.resolve(cloudReply(f.key, emptyPage('late', true))); }
    assert.equal(f.operationCalls.length, 2);
    await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed(end === 'close' ? 'closed' : 'disposed', { submitted: false }));
  }
});

test('concurrent independent pages do not acquire a mutation lease and disposal cannot alter an already returned frozen page', async t => {
  const f = await ready(t), firstReply = gate(), secondReply = gate(), entered = gate(); let count = 0;
  f.hooks.queue = call => {
    const request = readCloudRequest(call, f.key); if (++count === 2) entered.resolve();
    return request.params.lastNoiseId === 'first' ? firstReply.promise : secondReply.promise;
  };
  const first = getCloudMediaQueuePage(f.connection, f.viewer, 'first');
  const second = getCloudMediaQueuePage(f.connection, f.viewer, 'second');
  const secondObserved = observeRejection(second, fixed(undefined, { submitted: true }));
  try {
    await reached(entered, Promise.all([first, second]));
    firstReply.resolve(cloudReply(f.key, { ...emptyPage('kept'), mediaItems: [{ retained: true }] }));
    const result = await first; f.viewer.dispose(); await checkRejection(secondObserved);
    assert.equal(result.lastNoiseId, 'kept'); assert.deepEqual(result.mediaItems, [{ retained: true }]);
    assert.ok(Object.isFrozen(result.mediaItems[0])); assert.equal(f.operationCalls.length, 3);
  } finally { secondReply.resolve(cloudReply(f.key, emptyPage('late'))); }
});

test('connection/API binding is checked before dispatch and after await without invoking a replacement API getter', async t => {
  const f = await ready(t), other = await queueFixture(t);
  f.hooks.queue = () => { f.connection.api = other.api; return cloudReply(f.key, emptyPage('must-not-escape')); };
  try { await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('invalid-connection', { submitted: true })); }
  finally { f.connection.api = f.api; }
  let reads = 0;
  Object.defineProperty(f.connection, 'api', { configurable: true, get() { reads++; throw new Error(privateText); } });
  try { await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), fixed('invalid-connection', { submitted: false })); }
  finally { Object.defineProperty(f.connection, 'api', { configurable: true, writable: true, value: f.api }); }
  assert.equal(reads, 0); assert.equal(f.operationCalls.length, 2); assert.equal(other.operationCalls.length, 0);
});

test('fake public errors, private adapter getters and response faults cannot supply provider metadata or escape fixed errors', async t => {
  const f = await ready(t); let reads = 0;
  const forged = new CloudMediaError('rejected', 'queue', { providerCode: 212, submitted: true }); forged.message = privateText;
  Object.defineProperty(forged, 'providerCode', { get() { reads++; throw new Error(privateText); } });
  const protocol = new ZaloProtocolError('request-failed', 212); protocol.message = privateText;
  for (const reply of [() => { throw forged; }, () => { throw protocol; }, () => {
    const response = new Response('{}'); Object.defineProperty(response, 'status', { get() { throw forged; } }); return response;
  }, () => new Response(new ReadableStream({ pull() { throw forged; } }))]) {
    f.hooks.queue = reply;
    await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, ''), error => {
      assert.notEqual(error, forged); assert.notEqual(error, protocol);
      return fixed(undefined, { submitted: true, providerCode: undefined })(error);
    });
  }
  assert.equal(reads, 0); assert.equal(f.operationCalls.length, 5);
});

test('redirects and wrong response identities fail once without forwarding credentials, following URLs or changing the explicit cursor', async t => {
  const f = await ready(t);
  for (const reply of [() => new Response('', { status: 307, headers: { location: 'https://unrelated.invalid/private' } }),
    () => { const r = cloudReply(f.key, emptyPage('private')); Object.defineProperty(r, 'url', { value: 'https://unrelated.invalid/private' }); return r; },
    () => { const r = cloudReply(f.key, emptyPage('private')); Object.defineProperty(r, 'redirected', { value: true }); return r; }]) {
    f.hooks.queue = reply;
    await assert.rejects(getCloudMediaQueuePage(f.connection, f.viewer, 'unchanged'), fixed(undefined, { submitted: true, providerCode: undefined }));
  }
  assert.equal(f.operationCalls.length, 4);
  assert.ok(f.operationCalls.slice(1).every(call => call.url.origin === new URL(cloudBase).origin));
  assert.deepEqual(f.operationCalls.slice(1).map(call => readCloudRequest(call, f.key).params.lastNoiseId), ['unchanged', 'unchanged', 'unchanged']);
});
