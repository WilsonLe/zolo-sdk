import { createCipheriv, createDecipheriv } from 'node:crypto';
import { getEventListeners } from 'node:events';

export const key = Buffer.alloc(32, 0x32);
export const privateText = 'private-client-or-forward-fixture-value';
export const profileOrigin = 'https://profile.fixture.invalid';
export const fileOrigin = 'https://file.fixture.invalid';
export const imei = 'synthetic-032-imei';
export const markerText = '{"error_code":0,"data":{"__fixture_marker":"032-postdecode"}}';
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener;
export function hostileSignal(trap, stopPropagation = false) {
  const controller = new AbortController(); let stopped = 0;
  const stop = event => { stopped++; event.stopImmediatePropagation(); };
  if (stopPropagation) addListener.call(controller.signal, 'abort', stop);
  for (const name of ['aborted', 'reason', 'throwIfAborted', 'addEventListener', 'removeEventListener']) Object.defineProperty(controller.signal, name, { get: trap });
  return { controller, signal: controller.signal, stopped: () => stopped,
    listeners: () => getEventListeners(controller.signal, 'abort').length,
    cleanup: () => { if (stopPropagation) removeListener.call(controller.signal, 'abort', stop); } };
}
export function onAbort(signal, callback) { addListener.call(signal, 'abort', callback, { once: true }); }
export async function bounded(promise, milliseconds = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic API fixture expected prompt progress.')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
export function encryptedText(innerText, { status = 200, outerCode = 0 } = {}) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const encrypted = Buffer.concat([cipher.update(innerText), cipher.final()]).toString('base64');
  return Response.json({ error_code: outerCode, data: encodeURIComponent(encrypted) }, { status });
}
export function reply(data, { innerCode = 0, ...options } = {}) {
  return encryptedText(JSON.stringify({ error_code: innerCode, data }), options);
}
export function replyDataText(dataText, options) {
  return encryptedText(`{"error_code":0,"data":${dataText}}`, options);
}
export function requestParams(call) {
  const form = new URLSearchParams(call.init.body);
  const encoded = form.get('params');
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const text = Buffer.concat([decipher.update(Buffer.from(encoded, 'base64')), decipher.final()]).toString('utf8');
  return { form, encoded, text, data: JSON.parse(text) };
}
export function apiFixture(API, CookieJar, respond = () => reply({}), settings = {}) {
  const sent = [], cookie = new CookieJar();
  cookie.setCookieSync('file_fixture=allowed; Path=/', fileOrigin);
  cookie.setCookieSync('profile_fixture=allowed; Path=/', profileOrigin);
  const roots = new Proxy({ profile: [profileOrigin], file: [fileOrigin] }, {
    get(target, name) { return Object.hasOwn(target, name) ? target[name] : [`https://${String(name)}.fixture.invalid`]; },
  });
  const hooks = { respond };
  const api = new API({ uid: '9320000000000000001', imei, API_TYPE: 30, API_VERSION: 695,
    language: 'en', userAgent: 'Synthetic032', secretKey: key.toString('base64'), cookie,
    settings: { features: { socket: { retries: {} }, sharefile: { max_size_gif: 3 } }, ...settings },
    options: { logging: false, async polyfill(input, init) {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const call = { raw, url: new URL(raw), init }; sent.push(call); return hooks.respond(call);
    } },
  }, roots, ['wss://unused.fixture.invalid']);
  api.listener.start = () => { throw new Error('Synthetic032 fixture refuses any socket.'); };
  return { api, sent, hooks };
}

/** Post-decode policy seam ONLY: native JSON.parse/reviver arguments still run. */
export async function withDecodedData(fixture, decoded, operation) {
  const nativeParse = JSON.parse, previous = fixture.hooks.respond; let substitutions = 0;
  fixture.hooks.respond = () => encryptedText(markerText);
  JSON.parse = function (...args) {
    const parsed = Reflect.apply(nativeParse, this, args);
    if (args[0] === markerText) {
      substitutions++;
      Object.defineProperty(parsed, 'data', { value: decoded, writable: true, configurable: true, enumerable: true });
    }
    return parsed;
  };
  try { return await operation(); }
  finally {
    JSON.parse = nativeParse; fixture.hooks.respond = previous;
    if (substitutions === 0) throw new Error('Synthetic post-decode marker was not reached.');
  }
}
