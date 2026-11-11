import { createCipheriv, createDecipheriv } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { CookieJar } from 'tough-cookie';
import { API } from 'zalo-personal-sdk';

export const privateText = 'private-036-input-provider-or-adapter-value';
export const groupBase = 'https://group.fixture.invalid/tenant';
export const imei = 'synthetic-036-imei';
export const apiVersion = 736, apiType = 42;
export const markerText = '{"error_code":0,"data":{"__group_fixture_marker":"036-postdecode"}}';
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;

export function fixture(options = {}) {
  const key = Buffer.from(options.key ?? Buffer.alloc(32, 0x36)), base = options.base ?? groupBase;
  const sent = [], effects = { listenerStarts: 0 }, cookie = new CookieJar();
  cookie.setCookieSync('group_fixture=allowed; Path=/tenant', new URL(base).origin);
  cookie.setCookieSync('other_path=private; Path=/other', new URL(base).origin);
  cookie.setCookieSync('foreign_fixture=private; Path=/', 'https://profile.fixture.invalid');
  const names = 'aext alias auto_reply catalog chat conversation file friend friend_board group group_board group_poll label profile quick_message reaction sticker zimsg'.split(' ');
  const services = { ...Object.fromEntries(names.map(name => [name, ['https://' + name + '.fixture.invalid']])),
    group: [base, 'https://unused-group.fixture.invalid/alternate'],
    group_poll: ['https://poll-decoy.fixture.invalid'], profile: ['https://profile.fixture.invalid'] };
  const hooks = { respond: undefined };
  const api = new API({ uid: '9360000000000000001', imei, API_TYPE: apiType, API_VERSION: apiVersion,
    language: 'en', userAgent: 'GroupReadFixture036', secretKey: key.toString('base64'), cookie,
    settings: { features: { socket: { retries: {} }, sharefile: {} } },
    options: { logging: false, async polyfill(input, init) {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const call = { raw, url: new URL(raw), init }; sent.push(call);
      return hooks.respond ? hooks.respond(call) : reply(undefined);
    } },
  }, services, ['wss://unused.fixture.invalid']);
  api.listener.start = () => { effects.listenerStarts++; throw Error(privateText); };
  function encryptedText(text, { outerCode = 0, status = 200 } = {}) {
    const cipher = createCipheriv('aes-' + key.length * 8 + '-cbc', key, Buffer.alloc(16));
    const encrypted = Buffer.concat([cipher.update(text), cipher.final()]).toString('base64');
    return Response.json({ error_code: outerCode, data: encodeURIComponent(encrypted) }, { status });
  }
  function reply(data, { innerCode = 0, ...rest } = {}) {
    return encryptedText(JSON.stringify({ error_code: innerCode, data }), rest);
  }
  function dataText(text, options) {
    return encryptedText('{"error_code":0,"data":' + text + '}', options);
  }
  return { api, key, base, sent, effects, hooks, cookie, services, encryptedText, reply, dataText };
}

export function query(call, key) {
  const encoded = call.url.searchParams.get('params');
  const decipher = createDecipheriv('aes-' + key.length * 8 + '-cbc', key, Buffer.alloc(16));
  const text = Buffer.concat([decipher.update(Buffer.from(encoded, 'base64')), decipher.final()]).toString('utf8');
  return { encoded, text, data: JSON.parse(text) };
}

// TRUSTED POST-DECODE CUSTOM-OBJECT SEAM ONLY. JSON has no accessors, Proxies,
// holes or aliases. Preserve native parse/reviver arguments and substitute only
// this exact synthetic inner data. Promise assimilation may probe root "then".
export async function withDecoded(f, value, operation) {
  const nativeParse = JSON.parse, previous = f.hooks.respond; let substitutions = 0;
  f.hooks.respond = () => f.encryptedText(markerText);
  JSON.parse = function (...args) {
    const parsed = Reflect.apply(nativeParse, this, args);
    if (args[0] === markerText) {
      substitutions++;
      Object.defineProperty(parsed, 'data', { enumerable: true, configurable: true, writable: true, value });
    }
    return parsed;
  };
  try { return await operation(); }
  finally {
    JSON.parse = nativeParse; f.hooks.respond = previous;
    if (substitutions === 0) throw Error('The exact synthetic group marker was not decoded.');
  }
}

export function hostileSignal(trap, stopPropagation = false) {
  const controller = new AbortController(); let stopped = 0;
  const stop = event => { stopped++; event.stopImmediatePropagation(); };
  if (stopPropagation) add.call(controller.signal, 'abort', stop);
  for (const name of ['aborted', 'reason', 'throwIfAborted', 'addEventListener', 'removeEventListener'])
    Object.defineProperty(controller.signal, name, { get: trap });
  return { controller, signal: controller.signal, stopped: () => stopped,
    listeners: () => getEventListeners(controller.signal, 'abort').length,
    cleanup: () => { if (stopPropagation) remove.call(controller.signal, 'abort', stop); } };
}
export function onAbort(signal, listener) { add.call(signal, 'abort', listener, { once: true }); }
export function listenerCount(signal) { return getEventListeners(signal, 'abort').length; }
export const gate = () => Promise.withResolvers();
export async function bounded(promise, milliseconds = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Synthetic group fixture expected bounded progress.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
