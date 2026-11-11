import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { API } from 'zca-js';
import { CookieJar } from 'tough-cookie';
import {
  getReactionLastSeen, markDirectReactionsSeen, markGroupReactionsSeen,
  ReactionReceiptError, sendGroupReactionDelivered, sendReactionDelivered,
} from '../dist/reaction-receipts.js';

const key = Buffer.alloc(32, 113);
const self = '9340000000000004101';
const peer = '9340000000000004102';
const other = '9340000000000004103';
const group = '9340000000000004104';
const otherGroup = '9340000000000004105';
const reactionId = '9340000000000004106';
const laterReactionId = '9340000000000004107';

function encryptedText(text) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return Response.json({ error_code: 0, data: encodeURIComponent(Buffer.concat([cipher.update(text), cipher.final()]).toString('base64')) });
}
const encrypted = (data, error_code = 0) => encryptedText(JSON.stringify({ error_code, data }));
const empty = () => Response.json({ error_code: 0, data: '' });

function fixture(respond = empty, missingService = false) {
  const requests = [];
  let initialized = false;
  const api = new API({
    API_TYPE: 30, API_VERSION: 695, uid: self, imei: 'fixture-imei', userAgent: 'Fixture', language: 'en',
    secretKey: key.toString('base64'), cookie: new CookieJar(), settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(url.origin, 'https://reaction.fixture.invalid');
      assert.equal(init.redirect, 'error');
      assert.equal(url.searchParams.get('zpw_type'), '30');
      assert.equal(url.searchParams.get('zpw_ver'), '695');
      const encoded = init.method === 'POST' ? init.body.get('params') : url.searchParams.get('params');
      assert.deepEqual([...url.searchParams.keys()].sort(), init.method === 'POST' ? ['zpw_type', 'zpw_ver'] : ['params', 'zpw_type', 'zpw_ver']);
      if (init.method === 'POST') assert.deepEqual([...init.body.keys()], ['params']);
      else assert.equal(init.body, undefined);
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(encoded, 'base64')), decipher.final()]).toString();
      const request = { method: init.method, path: url.pathname, params: JSON.parse(plaintext), signal: init.signal };
      requests.push(request);
      return respond(request, requests.length);
    } },
  }, new Proxy({}, { get: (_, service) => initialized && missingService && service === 'reaction'
    ? undefined : [`https://${String(service)}.fixture.invalid`] }), ['wss://fixture.invalid']);
  initialized = true;
  return { api, requests };
}

function safe(error) {
  assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${error.stack}`, /93400000000000041|private-|fixture-imei|secretKey|receipt-secret/);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
}

test('submits direct/group delivery once with outer reaction IDs and exact source fields', async () => {
  const { api, requests } = fixture((_, count) => count === 1 ? empty() : encrypted({ opaque: { receipt: 'not-a-per-ID-confirmation' } }));
  assert.deepEqual(await sendReactionDelivered(api, [reactionId, laterReactionId]), { raw: undefined });
  assert.deepEqual(await sendGroupReactionDelivered(api, `g${group}`, [reactionId]), { raw: { opaque: { receipt: 'not-a-per-ID-confirmation' } } });
  assert.deepEqual(requests.map(({ signal, ...request }) => request), [
    { method: 'POST', path: '/api/message/react_delivered', params: { msg_ids: [reactionId, laterReactionId], imei: 'fixture-imei' } },
    { method: 'POST', path: '/api/group/react_delivered', params: { grid: group, msg_ids: [reactionId], imei: 'fixture-imei' } },
  ]);
});

test('submits one reaction read high-water ID per direct/group row without message metadata', async () => {
  const { api, requests } = fixture();
  const direct = [{ userId: peer, reactionId }, { userId: other, reactionId: laterReactionId }];
  const groups = [{ groupId: `g${group}`, reactionId }, { groupId: otherGroup, reactionId: laterReactionId }];
  const savedDirect = structuredClone(direct);
  const savedGroups = structuredClone(groups);
  await markDirectReactionsSeen(api, direct);
  await markGroupReactionsSeen(api, groups);
  assert.deepEqual(direct, savedDirect); assert.deepEqual(groups, savedGroups);
  assert.deepEqual(requests.map(({ signal, ...request }) => request), [
    { method: 'POST', path: '/api/message/react_seen', params: { seenInfos: [
      { msgIds: [reactionId], uid: peer }, { msgIds: [laterReactionId], uid: other },
    ], imei: 'fixture-imei' } },
    { method: 'POST', path: '/api/group/react_seen', params: { seenInfos: [
      { msgIds: [reactionId], groupId: group }, { msgIds: [laterReactionId], groupId: otherGroup },
    ], imei: 'fixture-imei' } },
  ]);
});

test('preserves opaque acknowledged bodies including empty outer success without fabricating per-ID results', async () => {
  const responses = [undefined, null, false, 0, '', 'opaque', [], { future: 1 }];
  for (const raw of responses) {
    const { api, requests } = fixture(() => encrypted(raw));
    assert.deepEqual(await markDirectReactionsSeen(api, [{ userId: peer, reactionId }]), { raw });
    assert.equal(requests.length, 1);
  }
  for (const data of [undefined, null, false, 0, '']) {
    const { api, requests } = fixture(() => Response.json({ error_code: 0, data }));
    assert.deepEqual(await sendReactionDelivered(api, [reactionId]), { raw: undefined });
    assert.equal(requests.length, 1);
  }
});

test('reads exact last-seen GET arrays and preserves missing requests, row order, duplicates and unknown extensions', async () => {
  const rows = [
    { type: 1, idTo: peer, lastMsgId: reactionId, isGroup: false, providerOnly: ['kept'] },
    { type: 1, idTo: group, lastMsgId: laterReactionId, isGroup: 1 },
    { type: 1, idTo: peer, lastMsgId: reactionId, isGroup: false },
    { type: 17, idTo: other, lastMsgId: reactionId, future: true },
  ];
  const { api, requests } = fixture(() => encrypted({ clearUnreadInfo: rows, future: { revision: 'opaque' } }));
  const result = await getReactionLastSeen(api, { userIds: [peer, other], groupIds: [`g${group}`, otherGroup] });
  assert.deepEqual(result.raw, { clearUnreadInfo: rows, future: { revision: 'opaque' } });
  assert.deepEqual(result.entries, [
    { raw: rows[0], marker: { threadType: 'direct', threadId: peer, reactionId } },
    { raw: rows[1], marker: { threadType: 'group', threadId: group, reactionId: laterReactionId } },
    { raw: rows[2], marker: { threadType: 'direct', threadId: peer, reactionId } },
    { raw: rows[3] },
  ]);
  assert.deepEqual(requests.map(({ signal, ...request }) => request), [{ method: 'GET', path: '/api/react/gLastSn',
    params: { group: [group, otherGroup], oneone: [peer, other] } }]);
  assert.equal(result.entries.length, 4); // No manufactured rows for requested threads missing from the response.
});

test('last-seen projection is mechanical numeric type1/Boolean(group) with bounded lossless identities', async () => {
  const maximalId = '9'.repeat(40);
  const rows = [
    { type: 1, idTo: JSON.rawJSON(peer), lastMsgId: JSON.rawJSON(reactionId) },
    { type: 1, idTo: 7, lastMsgId: 8, isGroup: 0 },
    { type: 1, idTo: group, lastMsgId: maximalId, isGroup: 'false' },
    { type: '1', idTo: peer, lastMsgId: reactionId },
    { type: 1, idTo: `g${group}`, lastMsgId: reactionId, isGroup: true },
    { type: 1, idTo: peer, lastMsgId: '0' },
    { type: 1, idTo: peer, lastMsgId: '01' },
    { type: 1, idTo: peer, lastMsgId: '9'.repeat(41) },
    { type: 1, idTo: peer }, null, 0, 'future row', [],
  ];
  const { api } = fixture(() => encrypted({ clearUnreadInfo: rows }));
  const result = await getReactionLastSeen(api, { userIds: [peer] });
  assert.deepEqual(result.entries.slice(0, 3).map(row => row.marker), [
    { threadType: 'direct', threadId: peer, reactionId },
    { threadType: 'direct', threadId: '7', reactionId: '8' },
    { threadType: 'group', threadId: group, reactionId: maximalId },
  ]);
  assert.equal(result.entries[0].raw.idTo, peer); assert.equal(result.entries[0].raw.lastMsgId, reactionId);
  for (let index = 3; index < result.entries.length; index++) assert.equal(Object.hasOwn(result.entries[index], 'marker'), false);
  assert.equal(result.entries.length, rows.length);
});

test('rejects malformed top-level read results but permits a real empty marker array', async () => {
  for (const raw of [undefined, null, false, '', [], {}, { clearUnreadInfo: null }, { clearUnreadInfo: {} },
    { clearUnreadInfo: Array.from({ length: 20_001 }, () => null) }]) {
    const { api, requests } = fixture(() => encrypted(raw));
    await assert.rejects(getReactionLastSeen(api, { groupIds: [group] }), error => error.code === 'invalid-response' && safe(error));
    assert.equal(requests.length, 1);
  }
  const { api, requests } = fixture(() => encrypted({ clearUnreadInfo: [] }));
  assert.deepEqual(await getReactionLastSeen(api, { groupIds: [group] }), { entries: [], raw: { clearUnreadInfo: [] } });
  assert.deepEqual(requests[0].params, { group: [group], oneone: [] });
});

test('missing last-seen rows cannot inherit an apparent empty state from an application prototype', async () => {
  const { api, requests } = fixture(() => encrypted({}));
  assert.equal(Object.hasOwn(Object.prototype, 'clearUnreadInfo'), false);
  Object.defineProperty(Object.prototype, 'clearUnreadInfo', { configurable: true, writable: true, value: [] });
  try {
    await assert.rejects(getReactionLastSeen(api, { userIds: [peer] }), error => error.code === 'invalid-response' && safe(error));
    assert.equal(requests.length, 1);
  } finally { delete Object.prototype.clearUnreadInfo; }
});

test('all mutation outcomes separate provider refusal from uncertain transport/HTTP/body outcomes with fixed errors', async () => {
  const cases = [
    [() => Response.json({ error_code: 212, error_message: 'private-refusal' }), 'rejected', 212, undefined],
    [() => encrypted({ private: 'receipt-secret' }, 166), 'rejected', 166, undefined],
    [() => encrypted(null, 100_000_001), 'rejected', 100_000_001, undefined],
    [() => new Response('private-http', { status: 503 }), 'submission-unknown', undefined, 503],
    [() => new Response('private-malformed'), 'submission-unknown', undefined, undefined],
    [() => Response.json({ error_code: 0, data: 'private-ciphertext' }), 'submission-unknown', undefined, undefined],
    [() => { throw Error('private-network'); }, 'submission-unknown', undefined, undefined],
    [() => encryptedText('{"data":{"private":"receipt-secret"}}'), 'submission-unknown', undefined, undefined],
  ];
  const methods = [
    [api => sendReactionDelivered(api, [reactionId]), 'direct-delivered'],
    [api => sendGroupReactionDelivered(api, group, [reactionId]), 'group-delivered'],
    [api => markDirectReactionsSeen(api, [{ userId: peer, reactionId }]), 'direct-seen'],
    [api => markGroupReactionsSeen(api, [{ groupId: group, reactionId }]), 'group-seen'],
  ];
  for (const [respond, code, providerCode, status] of cases) for (const [run, operation] of methods) {
    const { api, requests } = fixture(respond);
    await assert.rejects(run(api), error => {
      assert.ok(error instanceof ReactionReceiptError);
      assert.equal(error.code, code); assert.equal(error.operation, operation);
      assert.equal(error.providerCode, providerCode); assert.equal(error.status, status);
      return safe(error);
    });
    assert.equal(requests.length, 1);
  }
});

test('missing service and pre-aborted mutations are not submitted; reads retain ordinary protocol errors', async () => {
  const missing = fixture(() => assert.fail('No missing-service request.'), true);
  await assert.rejects(sendReactionDelivered(missing.api, [reactionId]), error => {
    assert.equal(error.code, 'not-submitted'); assert.equal(error.reason, 'unsupported-service'); return safe(error);
  });
  await assert.rejects(getReactionLastSeen(missing.api, { userIds: [peer] }), { code: 'unsupported-service' });
  assert.equal(missing.requests.length, 0);
  const { api, requests } = fixture(() => assert.fail('No pre-aborted request.'));
  await assert.rejects(markGroupReactionsSeen(api, [{ groupId: group, reactionId }], AbortSignal.abort()), error => {
    assert.equal(error.code, 'not-submitted'); assert.equal(error.reason, 'aborted'); return safe(error);
  });
  await assert.rejects(getReactionLastSeen(api, { userIds: [peer], signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(requests.length, 0);
});

test('cancellation after transport handoff remains uncertain and never retries', async () => {
  const observed = Promise.withResolvers();
  const { api, requests } = fixture(({ signal }) => new Promise((_, reject) => {
    observed.resolve(signal);
    signal.addEventListener('abort', () => reject(Error('private-abort-reason')), { once: true });
  }));
  const controller = new AbortController();
  const pending = sendGroupReactionDelivered(api, group, [reactionId], controller.signal);
  const signal = await observed.promise;
  controller.abort('private-abort-reason');
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'submission-unknown'); assert.equal(error.reason, 'aborted'); return safe(error);
  });
  assert.equal(signal.aborted, true); assert.equal(requests.length, 1);
});

test('invalid IDs, sparse arrays, normalized duplicates and unsupported intents fail safely before I/O', async () => {
  const { api, requests } = fixture(() => assert.fail('Invalid input must not submit.'));
  const invalidIds = [undefined, null, 1, Number.MAX_SAFE_INTEGER + 1, '', '0', '01', '-1', '+1', '1.0', '1e3', ' 1', '1\n', `g${peer}`, '9'.repeat(41), { toString() { throw Error('private-coercion'); } }];
  for (const value of invalidIds) {
    await assert.rejects(sendReactionDelivered(api, [value]), error => error instanceof TypeError && safe(error));
    await assert.rejects(markDirectReactionsSeen(api, [{ userId: peer, reactionId: value }]), error => error instanceof TypeError && safe(error));
    await assert.rejects(getReactionLastSeen(api, { userIds: [value] }), error => error instanceof TypeError && safe(error));
  }
  for (const run of [
    () => sendReactionDelivered(api, []), () => sendReactionDelivered(api, [reactionId, reactionId]),
    () => sendGroupReactionDelivered(api, `gg${group}`, [reactionId]),
    () => markDirectReactionsSeen(api, new Array(1)), () => markDirectReactionsSeen(api, [null]),
    () => markDirectReactionsSeen(api, [{ userId: peer, reactionId }, { userId: peer, reactionId: laterReactionId }]),
    () => markGroupReactionsSeen(api, [{ groupId: group, reactionId }, { groupId: `g${group}`, reactionId: laterReactionId }]),
    () => getReactionLastSeen(api, {}), () => getReactionLastSeen(api, { userIds: [], groupIds: [] }),
    () => getReactionLastSeen(api, { groupIds: [group, `g${group}`] }),
    () => getReactionLastSeen(api, { userIds: [peer], signal: {} }),
    () => getReactionLastSeen(api, undefined),
  ]) await assert.rejects(run(), error => error instanceof TypeError && safe(error));
  assert.equal(requests.length, 0);
});

test('checks array bounds before element reads and never executes caller-owned array iterators', async () => {
  const { api, requests } = fixture(() => encrypted({ clearUnreadInfo: [] }));
  const calls = [
    values => sendReactionDelivered(api, values), values => sendGroupReactionDelivered(api, group, values),
    values => markDirectReactionsSeen(api, values), values => markGroupReactionsSeen(api, values),
    values => getReactionLastSeen(api, { userIds: values }), values => getReactionLastSeen(api, { groupIds: values }),
  ];
  for (const size of [51, 1001]) for (const run of calls) {
    let indexed = 0;
    const values = new Array(size);
    Object.defineProperty(values, 0, { get() { indexed++; throw Error('private-oversized-index'); } });
    await assert.rejects(run(values), error => error instanceof TypeError && safe(error));
    assert.equal(indexed, 0);
  }
  assert.equal(requests.length, 0);
  const samples = [[reactionId], [reactionId], [{ userId: peer, reactionId }], [{ groupId: group, reactionId }], [peer], [`g${group}`]];
  for (let index = 0; index < calls.length; index++) {
    let iterated = 0;
    Object.defineProperty(samples[index], Symbol.iterator, { value() { iterated++; throw Error('private-iterator'); } });
    await calls[index](samples[index]);
    assert.equal(iterated, 0);
  }
  assert.equal(requests.length, calls.length);
});

test('sanitizes throwing input accessors and snapshots mutable intent once before transport', async () => {
  const { api, requests } = fixture(() => empty());
  const throwing = new Array(1);
  Object.defineProperty(throwing, 0, { get() { throw Error('private-array-accessor'); } });
  const row = { reactionId };
  Object.defineProperty(row, 'userId', { get() { throw Error('private-row-accessor'); } });
  const groupRow = { groupId: group };
  Object.defineProperty(groupRow, 'reactionId', { get() { throw Error('private-reaction-accessor'); } });
  const options = {};
  Object.defineProperty(options, 'userIds', { get() { throw Error('private-options-accessor'); } });
  const lengthTrap = new Proxy([reactionId], { get(target, field) { if (field === 'length') throw Error('private-length'); return Reflect.get(target, field); } });
  for (const run of [() => sendReactionDelivered(api, throwing), () => sendReactionDelivered(api, lengthTrap),
    () => markDirectReactionsSeen(api, [row]), () => markGroupReactionsSeen(api, [groupRow]), () => getReactionLastSeen(api, options)]) {
    await assert.rejects(run(), error => error instanceof TypeError && safe(error));
  }
  assert.equal(requests.length, 0);
  let userReads = 0;
  let reactionReads = 0;
  const changing = { get userId() { userReads++; return userReads === 1 ? peer : other; },
    get reactionId() { reactionReads++; return reactionReads === 1 ? reactionId : laterReactionId; } };
  const pending = markDirectReactionsSeen(api, [changing]);
  await pending;
  assert.equal(userReads, 1); assert.equal(reactionReads, 1);
  assert.deepEqual(requests[0].params.seenInfos, [{ msgIds: [reactionId], uid: peer }]);
  const observed = Promise.withResolvers();
  const response = Promise.withResolvers();
  const held = fixture(request => { observed.resolve(request); return response.promise; });
  const mutable = [{ userId: peer, reactionId }];
  const heldPending = markDirectReactionsSeen(held.api, mutable);
  mutable[0].userId = other; mutable[0].reactionId = laterReactionId;
  mutable.push({ userId: self, reactionId: laterReactionId });
  const submitted = await observed.promise;
  assert.deepEqual(submitted.params.seenInfos, [{ msgIds: [reactionId], uid: peer }]);
  response.resolve(empty());
  await heldPending;
  assert.equal(held.requests.length, 1);
});
