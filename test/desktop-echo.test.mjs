import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const target = '9330000000000000901';
const adapter = String.raw`
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
export const ThreadType = { User: 0, Group: 1 };
const report = { loads: 0, mutations: 0, created: 0, closeCounts: [], replies: [], removed: [], options: null, lateRejected: false, lateApiReturned: false };
process.on('exit', () => writeFileSync(process.env.ECHO_FIXTURE_REPORT, JSON.stringify(report), { mode: 0o600 }));
export class FileDesktopSessionStore {
  async load() { report.loads++; return { credentials: { uid: 'private-fixture-uid', sessionToken: 'private-fixture-cookie' } }; }
  async save() { report.mutations++; throw Error('private-fixture-save'); }
  async clear() { report.mutations++; throw Error('private-fixture-clear'); }
}
export async function connectDesktopSession(credentials, options) {
  if (process.env.ECHO_FIXTURE_SCENARIO === 'late') await delay(25);
  const index = report.created++;
  report.closeCounts[index] = 0;
  const api = { listener: new EventEmitter(),
    async sendMessage(text, threadId, type) {
      report.replies.push({ text, threadId, type });
      throw Error('private-fixture-message-and-provider-error');
    },
  };
  // Model bootstrap detaching its signal. Only the example may retire this API.
  return { api, close() { report.closeCounts[index]++; } };
}
export function startManagedRealtime(connect, options) {
  report.options = { startupTimeoutMs: options.startupTimeoutMs, maxRetries: options.maxRetries,
    initialRetryMs: options.initialRetryMs, maxRetryMs: options.maxRetryMs, stableAfterMs: options.stableAfterMs };
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  const closed = (async () => {
    const scenario = process.env.ECHO_FIXTURE_SCENARIO;
    if (scenario === 'late') {
      const startup = new AbortController();
      const pending = connect(startup.signal);
      startup.abort();
      void pending.then(() => { report.lateApiReturned = true; }, () => { report.lateRejected = true; });
      return { reason: 'stopped' };
    }
    const count = scenario === 'normal' ? 2 : 1;
    for (let attempt = 1; attempt <= count; attempt++) {
      const startup = new AbortController();
      const lifetime = new AbortController();
      const finish = () => { startup.abort(); lifetime.abort(); };
      signal.addEventListener('abort', finish, { once: true });
      const api = await connect(startup.signal);
      if (scenario === 'before') {
        startup.abort();
        signal.removeEventListener('abort', finish);
        return { reason: 'account-changed' };
      }
      await options.onConnection({ api, signal: lifetime.signal, attempt });
      options.onStatus({ state: 'authenticated', attempt });
      if (scenario === 'signal') {
        // Real sockets keep Node alive while OS signal delivery is pending.
        const keepAlive = setInterval(() => {}, 1000);
        const stopped = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        setImmediate(() => process.kill(process.pid, 'SIGINT'));
        try { await stopped; } finally { clearInterval(keepAlive); }
        report.removed.push(api.listener.listenerCount('message') === 0);
        signal.removeEventListener('abort', finish);
        return { reason: 'stopped' };
      }
      const base = { type: ThreadType.User, isSelf: false, threadId: process.env.ZALO_ECHO_THREAD_ID,
        data: { content: '!echo private-fixture-reply' } };
      for (const message of [
        { ...base, isSelf: true }, { ...base, isSelf: undefined }, { ...base, type: ThreadType.Group },
        { ...base, threadId: 'private-fixture-other-thread' }, { ...base, data: { content: 'unrelated private-fixture-message' } },
        { ...base, data: { content: '!echo ' } }, { ...base, data: { content: { private: true } } }, base,
      ]) api.listener.emit('message', message);
      options.onFrameError(Error('private-fixture-frame-error'));
      await nextTurn();
      lifetime.abort();
      report.removed.push(api.listener.listenerCount('message') === 0);
      api.listener.emit('message', base);
      startup.abort();
      signal.removeEventListener('abort', finish);
      if (attempt < count) options.onStatus({ state: 'retrying', attempt });
    }
    return { reason: 'displaced' };
  })();
  return { closed, stop() { stop.abort(); } };
}
`;

async function runFixture(t, scenario, threadId = target) {
  const directory = await mkdtemp(join(tmpdir(), 'zalo-desktop-echo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageDirectory = join(directory, 'node_modules', 'zalo-personal-sdk');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
  await writeFile(join(packageDirectory, 'index.mjs'), adapter);
  const entry = join(directory, 'desktop-echo.mjs');
  await writeFile(entry, await readFile(new URL('../examples/desktop-echo.mjs', import.meta.url)));
  const reportPath = join(directory, 'report.json');
  const environment = { ...process.env, ECHO_FIXTURE_SCENARIO: scenario, ECHO_FIXTURE_REPORT: reportPath,
    ZALO_ECHO_THREAD_ID: threadId, ZALO_DESKTOP_SESSION_PATH: join(directory, 'never-read-private-session.json') };
  let result;
  try { result = await execute(process.execPath, [entry], { cwd: directory, env: environment, timeout: 5000 }); }
  catch (error) {
    if (typeof error.code !== 'number') throw error;
    result = { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.doesNotMatch(result.stdout + result.stderr, /private-fixture|9330000000000000901|never-read-private-session/);
  assert.equal(report.mutations, 0);
  return { ...result, report };
}

test('Desktop example entrypoint filters recipients and owns retry, early-end, late-bootstrap and signal cleanup', async t => {
  const normal = await runFixture(t, 'normal');
  assert.equal(normal.code, 1);
  assert.deepEqual(normal.report.replies, [0, 1].map(() => ({ text: 'private-fixture-reply', threadId: target, type: 0 })));
  assert.deepEqual(normal.report.closeCounts, [1, 1]);
  assert.deepEqual(normal.report.removed, [true, true]);
  assert.equal(normal.report.loads, 1);
  assert.deepEqual(normal.report.options, { startupTimeoutMs: 20000, maxRetries: 3,
    initialRetryMs: 1000, maxRetryMs: 8000, stableAfterMs: 30000 });
  assert.match(normal.stdout, /ended \(displaced\)/);
  for (const scenario of ['before', 'late', 'signal']) {
    const result = await runFixture(t, scenario);
    assert.equal(result.report.created, 1);
    assert.deepEqual(result.report.closeCounts, [1], scenario);
    assert.deepEqual(result.report.replies, []);
    if (scenario === 'late') {
      assert.equal(result.report.lateRejected, true);
      assert.equal(result.report.lateApiReturned, false);
    }
    if (scenario === 'signal') assert.deepEqual(result.report.removed, [true]);
  }
});

test('Desktop example requires an explicit positive decimal target before loading credentials or connecting', async t => {
  for (const value of ['', '0', 'g123', '1.5', '-1', '01', ' 123', '1'.repeat(41)]) {
    const result = await runFixture(t, 'normal', value);
    assert.equal(result.code, 1);
    assert.equal(result.report.loads, 0);
    assert.equal(result.report.created, 0);
    assert.equal(result.report.options, null);
    assert.match(result.stderr, /could not start/);
  }
});
