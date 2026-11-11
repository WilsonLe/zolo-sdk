import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { API } from 'zca-js';
import { recoverChatOfflineQueue, recoverReactionOfflineQueue, startManagedRealtime } from '../dist/index.js';

const key = Buffer.alloc(32, 9).toString('base64');

function frame(cmd, value, subCmd = 0) {
  const bytes = Buffer.of(1, cmd & 255, cmd >> 8, subCmd);
  return Buffer.concat([bytes, Buffer.from(JSON.stringify(value))]);
}

async function fixture(t) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const makeApi = (uid = '9007199254741000') => new API({
    API_VERSION: 695, API_TYPE: 30, uid, cookie: new CookieJar(), userAgent: 'fixture',
    settings: { features: { socket: { retries: {}, ping_interval: 60_000 } } },
    options: { selfListen: false, logging: false }, secretKey: Buffer.alloc(32).toString('base64'),
  }, new Proxy({}, { get: () => ['https://fixture.zalo.me'] }), [`ws://127.0.0.1:${server.address().port}`]);
  return { server, makeApi };
}

test('reconnects after a transient close, scopes setup to each socket and stops on displacement', { timeout: 4000 }, async (t) => {
  const { server, makeApi } = await fixture(t);
  const setups = [];
  const statuses = [];
  const payloads = [];
  const endedFirst = Promise.withResolvers();
  let opened = 0;
  server.on('connection', (socket) => {
    assert.equal(server.clients.size, 1);
    const generation = ++opened;
    socket.send(frame(1, { key }, 1));
    socket.send(frame(900, { generation }));
    if (generation === 1) socket.close(1012, 'private fixture close detail');
    else socket.send(frame(3000, {}));
  });
  const managed = startManagedRealtime(async () => makeApi(), {
    initialRetryMs: 1, maxRetryMs: 2, maxRetries: 3,
    onConnection(connection) {
      setups.push(connection);
      connection.feed.subscribe(({ payload }) => { payloads.push(payload); }, [900]);
      if (connection.attempt === 1) connection.signal.addEventListener('abort', endedFirst.resolve, { once: true });
    },
    onStatus(status) { statuses.push(status); },
  });
  t.after(() => managed.stop());
  assert.equal((await managed.ready).attempt, 1);
  assert.deepEqual(await managed.closed, { reason: 'displaced', closeCode: 3000, attempts: 2 });
  await endedFirst.promise;
  assert.equal(opened, 2);
  assert.ok(setups.every((entry) => entry.signal.aborted));
  assert.ok(setups.every((entry) => entry.api.listener.listenerCount('closed') === 0));
  assert.deepEqual(payloads, [{ generation: 1 }, { generation: 2 }]);
  assert.deepEqual(statuses.map(({ state }) => state), ['connecting', 'authenticated', 'retrying', 'connecting', 'authenticated', 'ended']);
  assert.doesNotMatch(JSON.stringify(statuses), /private fixture|cipher_key/);
});

test('refuses to start the second socket when bootstrap changes the account', { timeout: 4000 }, async (t) => {
  const { server, makeApi } = await fixture(t);
  let opened = 0;
  let loaded = 0;
  server.on('connection', (socket) => {
    opened++;
    socket.send(frame(1, { key }, 1));
    socket.close(1012);
  });
  const managed = startManagedRealtime(async () => makeApi(String(++loaded)), { initialRetryMs: 1 });
  t.after(() => managed.stop());
  await managed.ready;
  assert.deepEqual(await managed.closed, { reason: 'account-changed', closeCode: undefined, attempts: 2 });
  assert.equal(opened, 1);
  assert.equal(loaded, 2);
});

test('bounds startup retries and aborts an outstanding retry delay', { timeout: 4000 }, async () => {
  const inputSignals = [];
  const exhausted = startManagedRealtime((signal) => {
    inputSignals.push(signal);
    return new Promise(() => {});
  }, { startupTimeoutMs: 5, initialRetryMs: 1, maxRetries: 1 });
  assert.equal(await exhausted.ready, null);
  assert.deepEqual(await exhausted.closed, { reason: 'retries-exhausted', closeCode: undefined, attempts: 2 });
  assert.ok(inputSignals.every((signal) => signal.aborted));

  const controller = new AbortController();
  let attempts = 0;
  const stopped = startManagedRealtime(async () => {
    attempts++;
    throw new Error('private fixture failure');
  }, { signal: controller.signal, initialRetryMs: 10_000, onStatus(status) {
    if (status.state === 'retrying') controller.abort();
  } });
  assert.equal(await stopped.ready, null);
  assert.deepEqual(await stopped.closed, { reason: 'stopped', attempts: 1 });
  assert.equal(attempts, 1);
});

test('closes the socket and stops when extension setup fails', { timeout: 4000 }, async (t) => {
  const { makeApi } = await fixture(t);
  const managed = startManagedRealtime(async () => makeApi(), {
    async onConnection() { throw new Error('private fixture handler detail'); },
  });
  t.after(() => managed.stop());
  assert.equal(await managed.ready, null);
  assert.deepEqual(await managed.closed, { reason: 'handler-failed', closeCode: undefined, attempts: 1 });
});

test('waits for the previous connection handler to finish before starting a retry', { timeout: 4000 }, async (t) => {
  const { server, makeApi } = await fixture(t);
  const release = Promise.withResolvers();
  const cleanup = Promise.withResolvers();
  let opened = 0;
  server.on('connection', (socket) => {
    opened++;
    socket.send(frame(1, { key }, 1));
    socket.close(opened === 1 ? 1012 : 1000);
  });
  const managed = startManagedRealtime(async () => makeApi(), { initialRetryMs: 1, async onConnection(connection) {
    if (connection.attempt !== 1) return;
    await new Promise((resolve) => connection.signal.addEventListener('abort', resolve, { once: true }));
    cleanup.resolve();
    await release.promise;
  } });
  t.after(() => { release.resolve(); managed.stop(); });
  await cleanup.promise;
  assert.equal(opened, 1);
  release.resolve();
  assert.deepEqual(await managed.closed, { reason: 'closed', attempts: 2, closeCode: 1000 });
  assert.equal(opened, 2);
});

test('uses the socket close code when recovery notices the socket closing before the close event', { timeout: 4000 }, async (t) => {
  const { server, makeApi } = await fixture(t);
  let opened = 0;
  server.on('connection', (socket) => {
    opened++;
    socket.send(frame(1, { key, encrypt: 0, data: '{"error_code":0,"data":{"qCmds":[{"cmd":510,"subCmd":0}]}}' }, 1));
    if (opened === 2) socket.close(1000);
  });
  const managed = startManagedRealtime(async () => makeApi(), { initialRetryMs: 1, async onConnection({ api, attempt, feed }) {
    if (attempt !== 1) return;
    assert.equal(await feed.ready, true);
    api.listener.ws.close(1012);
    await recoverChatOfflineQueue(feed, { cmd: 510 }, { onPage() { assert.fail('closed socket returned a page'); } });
  } });
  t.after(() => managed.stop());
  assert.deepEqual(await managed.closed, { reason: 'closed', attempts: 2, closeCode: 1000 });
  assert.equal(opened, 2);
});

test('uses the socket close code when reaction recovery notices CLOSING before the close event', { timeout: 4000 }, async (t) => {
  const { server, makeApi } = await fixture(t);
  let opened = 0;
  server.on('connection', (socket) => {
    opened++;
    socket.send(frame(1, { key, encrypt: 0, data: '{"error_code":0,"data":{"ctrl_qCmds":[{"cmd":610,"subCmd":0}]}}' }, 1));
    if (opened === 2) socket.close(1000);
  });
  const managed = startManagedRealtime(async () => makeApi(), { initialRetryMs: 1, async onConnection({ api, attempt, feed }) {
    if (attempt !== 1) return;
    assert.equal(await feed.ready, true);
    assert.deepEqual(await feed.authenticatedControlQueues, [{ cmd: 610, subCmd: 0 }]);
    api.listener.ws.close(1012);
    await recoverReactionOfflineQueue(feed, { cmd: 610 }, { onPage() { assert.fail('closed socket returned a reaction page'); } });
  } });
  t.after(() => managed.stop());
  assert.deepEqual(await managed.closed, { reason: 'closed', attempts: 2, closeCode: 1000 });
  assert.equal(opened, 2);
});
