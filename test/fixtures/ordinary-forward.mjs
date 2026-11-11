import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { inspect } from 'node:util';
import { CookieJar } from 'tough-cookie';
import * as SDK from 'zalo-personal-sdk';

export { SDK };
export const privateText = 'private-041-source-provider-adapter-value';
export const fileBase = 'https://file.fixture.invalid/tenant';
export const imei = 'synthetic-041-imei';
export const apiVersion = 741, apiType = 41;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
export const gate = () => Promise.withResolvers();
export const target = (clientId = 11, threadId = '00041', ttl = 0) => ({ threadId, clientId, ttl });
export const intent = (patch = {}) => ({ threadType: 'user', targets: [target()], source: { kind: 'text', text: 'ordinary text' }, ...patch });

export function fixture(options = {}) {
  const key = Buffer.from(options.key ?? Buffer.alloc(32, 0x41));
  const sent = [], cookie = new CookieJar(), effects = { listenerStarts: 0 };
  cookie.setCookieSync('root_fixture=allowed; Path=/', fileBase);
  cookie.setCookieSync('tenant_fixture=matching; Path=/tenant', fileBase);
  cookie.setCookieSync('wrong_path=private; Path=/elsewhere', fileBase);
  cookie.setCookieSync('foreign_host=private; Path=/', 'https://profile.fixture.invalid');
  const names = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');
  const services = Object.fromEntries(names.map(name => [name, [`https://${name}.fixture.invalid`]]));
  services.file = [fileBase, 'https://unused-file.fixture.invalid/alternate'];
  const hooks = { respond: undefined };
  const api = new SDK.API({ uid: '9410000000000000001', imei, API_TYPE: apiType, API_VERSION: apiVersion,
    language: 'en', userAgent: 'OrdinaryForwardFixture041', secretKey: key.toString('base64'), cookie,
    settings: { features: { socket: { retries: {} }, sharefile: {} } },
    options: { logging: false, async polyfill(input, init) {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const call = { raw, url: new URL(raw), init }; sent.push(call);
      return hooks.respond ? hooks.respond(call) : reply({});
    } },
  }, services, ['wss://unused.fixture.invalid']);
  api.listener.start = () => { effects.listenerStarts++; throw Error(privateText); };
  function encryptedText(text, { outerCode = 0, status = 200 } = {}) {
    const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, Buffer.alloc(16));
    const ciphertext = Buffer.concat([cipher.update(text), cipher.final()]).toString('base64');
    return Response.json({ error_code: outerCode, data: encodeURIComponent(ciphertext) }, { status });
  }
  function reply(data, { innerCode = 0, ...options } = {}) {
    return encryptedText(JSON.stringify({ error_code: innerCode, data }), options);
  }
  function dataText(text, options) { return encryptedText(`{"error_code":0,"data":${text}}`, options); }
  return { api, key, cookie, sent, effects, services, hooks, reply, dataText, encryptedText };
}

export function forward(api, input) {
  assert.equal(typeof SDK.forwardOrdinaryMessage, 'function', 'The public ordinary batch operation must exist.');
  return SDK.forwardOrdinaryMessage(api, input);
}
export function request(f, call) {
  const form = new URLSearchParams(call.init.body);
  assert.deepEqual([...form.keys()], ['params']);
  const encrypted = form.get('params');
  const decipher = createDecipheriv(`aes-${f.key.length * 8}-cbc`, f.key, Buffer.alloc(16));
  const text = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
  return { form, encrypted, text, data: JSON.parse(text) };
}
export function exact(f, call, expected, group = false) {
  assert.equal(call.raw, `${fileBase}/api/${group ? 'group' : 'message'}/mforward?zpw_ver=${apiVersion}&zpw_type=${apiType}`);
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'error');
  const headers = new Headers(call.init.headers);
  assert.match(headers.get('content-type'), /^application\/x-www-form-urlencoded/);
  const cookies = new Map((headers.get('cookie') ?? '').split(';').filter(Boolean).map(part => {
    const [name, ...value] = part.trim().split('='); return [name, value.join('=')];
  }));
  assert.equal(cookies.get('root_fixture'), 'allowed'); assert.equal(cookies.get('tenant_fixture'), 'matching');
  assert.equal(cookies.has('wrong_path'), false); assert.equal(cookies.has('foreign_host'), false);
  const decoded = request(f, call); assert.deepEqual(decoded.data, expected);
  assert.notEqual(decoded.encrypted, decoded.text);
  for (const name of ['clientId', 'zsource', 'visibility']) assert.equal(Object.hasOwn(decoded.data, name), false);
  if (group) assert.equal(Object.hasOwn(decoded.data, 'imei'), false);
  return decoded;
}
export function privacy(error) {
  const text = `${error} ${error.stack} ${JSON.stringify(error)} ${inspect(error)}`;
  for (const secret of [privateText, 'https://private.fixture.invalid/secret', 'private-adapter-field']) assert.equal(text.includes(secret), false);
  for (const name of ['cause', 'raw', 'data', 'body', 'input', 'source', 'url', 'targets']) assert.equal(Object.hasOwn(error, name), false);
}
export function invalid(error) { assert.ok(error instanceof TypeError); privacy(error); return true; }
export function fixed(code, submitted, outcomeUnknown, details = {}) {
  return error => {
    assert.equal(typeof SDK.OrdinaryMessageForwardError, 'function');
    assert.ok(error instanceof SDK.OrdinaryMessageForwardError);
    assert.equal(error.code, code); assert.equal(error.submitted, submitted); assert.equal(error.outcomeUnknown, outcomeUnknown);
    for (const [name, expected] of Object.entries(details)) assert.equal(error[name], expected);
    if (error.providerCode !== undefined) assert.ok(Number.isSafeInteger(error.providerCode));
    if (error.status !== undefined) assert.ok(Number.isSafeInteger(error.status) && error.status >= 100 && error.status <= 599);
    privacy(error); return true;
  };
}
// Compare JSON content without inventing an Object.prototype requirement.
export const jsonContent = value => JSON.parse(JSON.stringify(value));
export function frozenTree(value) {
  if (value !== null && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if ('value' in descriptor) frozenTree(descriptor.value);
  }
}
export async function bounded(promise, milliseconds = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic ordinary forward expected bounded progress.')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
export async function entered(start, pending) {
  assert.equal(await bounded(Promise.race([start.promise.then(() => true), pending.then(() => false, () => false)])), true);
}
export function hostileSignal(trap, resistant = false) {
  const controller = new AbortController(); let stopped = 0;
  const stop = event => { stopped++; event.stopImmediatePropagation(); };
  if (resistant) add.call(controller.signal, 'abort', stop);
  for (const name of ['aborted', 'reason', 'throwIfAborted', 'addEventListener', 'removeEventListener']) Object.defineProperty(controller.signal, name, { get: trap });
  return { controller, signal: controller.signal, stopped: () => stopped,
    count: () => getEventListeners(controller.signal, 'abort').length,
    cleanup: () => { if (resistant) remove.call(controller.signal, 'abort', stop); } };
}
export function onAbort(signal, callback) { add.call(signal, 'abort', callback, { once: true }); }
