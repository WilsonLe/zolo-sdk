// V2: affected existing public caller of the shared ordinary abort owner.
// V1 used an abort-ignoring adapter outside this older caller contract.
// This synthetic adapter now rejects on genuine native abort like fetch.
// Historical V1 remains unchanged; this file is authored but not executed.
// No private abort helper import, implementation inspection or parse substitution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { CookieJar } from 'tough-cookie';
import { API, getGroupListPage, ZaloProtocolError } from 'zalo-personal-sdk';
import { KEY, PRIVATE, encrypted, gate, bounded, delay, assertPrivate } from './fixture.mjs';

for (const mode of ['plain', 'shadowed', 'stopped']) test(`AB01 ${mode}: fake abort event does not consume later native abort`, { timeout: 5000 }, async () => {
  const entered = gate(), release = gate(), controller = new AbortController();
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
  const stop = event => event.stopImmediatePropagation();
  if (mode === 'stopped') add.call(controller.signal, 'abort', stop);
  let reads = 0;
  if (mode === 'shadowed') for (const name of ['aborted', 'reason', 'throwIfAborted', 'addEventListener', 'removeEventListener'])
    Object.defineProperty(controller.signal, name, { configurable: true, get() { reads++; throw Error(PRIVATE); } });
  const baselineListeners = getEventListeners(controller.signal, 'abort').length;
  const calls = [], api = new API({ API_VERSION: 695, API_TYPE: 30, uid: '1', imei: 'independent-fixture-imei',
    language: 'en', userAgent: 'Independent045Abort', secretKey: KEY.toString('base64'), cookie: new CookieJar(),
    settings: { features: { socket: { retries: {} }, sharefile: {} } },
    options: { logging: false, polyfill(url, init) {
      calls.push({ url: new URL(url), init });
      return new Promise((resolve, reject) => {
        let finished = false;
        const signal = init.signal;
        const cleanup = () => remove.call(signal, 'abort', onAbort);
        function finish(callback, value) {
          if (finished) return; finished = true; cleanup(); callback(value);
        }
        function onAbort() {
          if (nativeAborted.call(signal)) finish(reject, Error(PRIVATE));
        }
        // Not once: a fabricated event cannot consume later native observation.
        add.call(signal, 'abort', onAbort);
        if (nativeAborted.call(signal)) onAbort();
        release.promise.then(value => finish(resolve, value), error => finish(reject, error));
        entered.resolve();
      });
    } },
  }, new Proxy({}, { get: (_target, name) => ['https://' + String(name) + '.fixture.invalid'] }), ['wss://unused.fixture.invalid']);
  let starts = 0; api.listener.start = () => { starts++; throw Error('No listener is allowed for this existing read.'); };
  let settled = false;
  const operation = getGroupListPage(api, { signal: controller.signal });
  operation.then(() => { settled = true; }, () => { settled = true; });
  try {
    await bounded(entered.promise);
    EventTarget.prototype.dispatchEvent.call(controller.signal, new Event('abort'));
    await delay(20);
    assert.equal(settled, false, 'fabricated event alone must not cancel the existing read');
    controller.abort(Error(PRIVATE));
    await bounded(assert.rejects(operation, error => {
      assert.ok(error instanceof ZaloProtocolError); assert.equal(error.code, 'aborted'); assertPrivate(error); return true;
    }));
    assert.equal(reads, 0); assert.equal(starts, 0); assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, '/api/group/getlg/v3');
    assert.equal(getEventListeners(controller.signal, 'abort').length, baselineListeners);
  } finally {
    release.resolve(encrypted({ groups: [] })); await operation.catch(() => {});
    if (mode === 'stopped') remove.call(controller.signal, 'abort', stop);
  }
});
