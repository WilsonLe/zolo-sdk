import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { API } from 'zca-js';
import { extractAttachmentRenewalEvents, renewAttachmentLinks, startRealtimeFrameFeed } from '../dist/index.js';

const key = Buffer.alloc(32, 41);
const threadId = '9007199254741001';
const sourceUrl = 'https://files.fixture.invalid/jxl/a.jxl?quality=3&jxlstatus=1';
const renewed = 'https://files.fixture.invalid/renewed';

function response(data) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const body = JSON.stringify({ error_code: 0, data });
  return Response.json({ error_code: 0, data: Buffer.concat([cipher.update(body), cipher.final()]).toString('base64') });
}

function requestFields(url, options) {
  assert.equal(new URL(url).pathname, '/api/message/renewlink');
  assert.equal(new URL(url).host, 'file.fixture.invalid');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(options.body.get('params'), 'base64')), decipher.final()]));
}

function makeApi(polyfill, socketUrl = 'ws://127.0.0.1:1') {
  return new API({
    API_VERSION: 695, API_TYPE: 30, uid: '1', imei: 'fixture-imei', userAgent: 'fixture', cookie: new CookieJar(),
    settings: { features: { socket: { retries: {}, ping_interval: 60_000 } } },
    options: { logging: false, polyfill }, secretKey: key.toString('base64'), loginInfo: { send2me_id: threadId },
  }, new Proxy({}, { get: () => ['https://file.fixture.invalid'] }), [socketUrl]);
}

function frame(cmd, payload, subCmd = 0) {
  return Buffer.concat([Buffer.of(1, cmd & 255, cmd >> 8, subCmd), Buffer.from(JSON.stringify(payload))]);
}

function controls(rows, kind = 'photo') {
  return { error_code: 0, data: { controls: [{ content: { act_type: kind, act: 'renew_link', data: JSON.stringify(rows) } }] } };
}

async function fixture(t, fetch, authenticate = true) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const api = makeApi(fetch, `ws://127.0.0.1:${server.address().port}`);
  const waiting = once(server, 'connection');
  const feed = startRealtimeFrameFeed(api);
  const [socket] = await waiting;
  if (authenticate) socket.send(frame(1, { key: key.toString('base64') }, 1));
  t.after(async () => {
    feed.stop();
    await feed.closed;
    await new Promise((resolve) => server.close(resolve));
  });
  return { api, feed, socket };
}

const photo = { threadType: 'group', threadId, kind: 'photo', clientId: '9007199254741002', content: { oriUrl: sourceUrl } };
const matching = { img: sourceUrl, destId: threadId, destType: 2, errorCode: 0, normal: renewed };

test('matches the two AES envelopes and uses the observed original photo normalization', async () => {
  const content = Object.freeze({ oriUrl: sourceUrl, hdUrl: sourceUrl, thumbUrl: sourceUrl, normalUrl: sourceUrl, size: 123 });
  const api = makeApi(async (url, options) => {
    const { msgInfo, ...fields } = requestFields(url, options);
    assert.deepEqual(fields, { toId: threadId, clientId: photo.clientId, msgType: 2, isGroup: 1, imei: 'fixture-imei' });
    const unsigned = sourceUrl.replace('&jxlstatus=1', '');
    assert.deepEqual(JSON.parse(msgInfo), { oriUrl: sourceUrl, hdUrl: unsigned, thumbUrl: unsigned, normalUrl: unsigned,
      size: 123, isE2EE: 0, isOriginal: 1, url: unsigned });
    return response({ normal: renewed, hd: `${renewed}/hd`, thumb: `${renewed}/thumb` });
  });
  assert.deepEqual(await renewAttachmentLinks(api, { ...photo, threadType: 'saved', content, isOriginalPhoto: true }), {
    status: 'ready', links: { url: renewed, hdUrl: `${renewed}/hd`, thumbUrl: `${renewed}/thumb` },
  });
  await assert.rejects(renewAttachmentLinks(api, { ...photo, content: { oriUrl: `${sourceUrl}?e2esessionfixture` } }), TypeError);
});

test('returns a deferred status without a feed and builds the video thumbnail request', async () => {
  const api = makeApi(async (url, options) => {
    const { msgInfo, ...fields } = requestFields(url, options);
    assert.deepEqual(fields, { toId: '2', clientId: 8, msgType: 5, isGroup: 0, imei: 'fixture-imei' });
    assert.deepEqual(JSON.parse(msgInfo), { thumbUrl: sourceUrl.replace('&jxlstatus=1', ''), renewType: 0, isE2EE: 0, isOriginal: 1 });
    return response({ async: 1 });
  });
  assert.deepEqual(await renewAttachmentLinks(api, { threadType: 'user', threadId: '2', kind: 'video', clientId: 8,
    content: { thumbUrl: sourceUrl }, videoThumbnail: true }), { status: 'pending' });
});

test('accepts an early socket completion only for the same feed, destination, kind and source URL', { timeout: 4000 }, async (t) => {
  const submitted = Promise.withResolvers();
  const acknowledged = Promise.withResolvers();
  const { api, feed, socket } = await fixture(t, async () => { submitted.resolve(); return acknowledged.promise; });
  await assert.rejects(renewAttachmentLinks(makeApi(async () => assert.fail()), photo, { feed }), { code: 'feed-unavailable' });
  const request = renewAttachmentLinks(api, { ...photo, threadType: 'saved' }, { feed });
  await submitted.promise;
  await assert.rejects(renewAttachmentLinks(api, photo, { feed }), { code: 'busy' });
  const observed = Promise.withResolvers();
  feed.subscribe(() => observed.resolve(), [601]);
  socket.send(frame(601, controls([
    { ...matching, destId: '2', normal: 'https://files.fixture.invalid/wrong-destination' },
    { ...matching, img: `${sourceUrl}&other=1`, normal: 'https://files.fixture.invalid/wrong-source' },
    { ...matching, destType: 1 },
  ])));
  await observed.promise;
  acknowledged.resolve(response({ async: true }));
  assert.deepEqual(await request, { status: 'ready', links: { url: renewed } });
});

test('reserves a timed-out renewal until the matching late event and exposes safe provider failures', { timeout: 4000 }, async (t) => {
  const { api, feed, socket } = await fixture(t, async () => response({ async: 1 }));
  await assert.rejects(renewAttachmentLinks(api, photo, { feed, timeoutMs: 60 }), { code: 'timeout' });
  await assert.rejects(renewAttachmentLinks(api, photo, { feed }), { code: 'busy' });
  const drained = Promise.withResolvers();
  feed.subscribe(() => drained.resolve(), [603]);
  socket.send(frame(603, controls([matching])));
  await drained.promise;
  const request = renewAttachmentLinks(api, photo, { feed });
  await new Promise(setImmediate);
  socket.send(frame(603, controls([{ ...matching, errorCode: 739, normal: undefined }])));
  await assert.rejects(request, { code: 'rejected', providerCode: 739, message: 'Zalo rejected the attachment renewal.' });
  assert.deepEqual(extractAttachmentRenewalEvents({ version: 1, cmd: 603, payload: controls([{
    destType: 1, destId: threadId, error: 0, originalUrl: sourceUrl, renewUrl: renewed,
  }], 'file') }), [{ kind: 'file', threadId, sourceUrl, group: false, status: 'ready', links: { url: renewed } }]);
});

test('applies the deadline while waiting for an unauthenticated feed', { timeout: 4000 }, async (t) => {
  const { api, feed } = await fixture(t, async () => assert.fail('renewal dispatched before the key frame'), false);
  await assert.rejects(renewAttachmentLinks(api, photo, { feed, timeoutMs: 30 }), { code: 'timeout' });
});
