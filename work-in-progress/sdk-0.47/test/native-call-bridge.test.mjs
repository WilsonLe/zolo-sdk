import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createNativeCallCodec, startNativeCallBridge } from '../dist/native-call-bridge.js';

const fixtureKey = Buffer.alloc(16, 37);
const fixtureEncrypt = (plaintext) => {
  const cipher = createCipheriv('aes-128-cbc', fixtureKey, Buffer.alloc(16));
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('hex');
};

test('native codec decodes a fragmented stream and emits the observed multipart format', () => {
  const codec = createNativeCallCodec(fixtureKey);
  const ready = fixtureEncrypt('{"type":"update","command":"native-ready"}');
  const update = fixtureEncrypt('{"type":"update","command":"callState","data":{"peerId":9000000000000000001}}');
  assert.deepEqual(codec.push(ready.slice(0, 3)), []);
  assert.deepEqual(codec.push(`${ready.slice(3)}$${update}$`), [
    { type: 'update', command: 'native-ready' },
    { type: 'update', command: 'callState', data: { peerId: '9000000000000000001' } },
  ]);
  const payload = { type: 'update', command: 'init', data: { description: 'ệ'.repeat(1_900) } };
  const frames = codec.encode(payload);
  assert.equal(frames.length, 3);
  const parts = frames.map((frame, index) => {
    const match = /^([0-9a-f]+)#(\d+)#3#(\d)#\$$/.exec(frame);
    assert.ok(match);
    assert.equal(Number(match[3]), index);
    return match;
  });
  assert.equal(new Set(parts.map((match) => match[2])).size, 1);
  assert.equal(parts[0][1].length, 4_000);
  const decipher = createDecipheriv('aes-128-cbc', fixtureKey, Buffer.alloc(16));
  const decoded = Buffer.concat([decipher.update(Buffer.from(parts.map((match) => match[1]).join(''), 'hex')), decipher.final()]);
  assert.deepEqual(JSON.parse(decoded.toString('utf8')), payload);
  assert.deepEqual(frames.flatMap((frame) => codec.push(frame)), [payload]);
  assert.throws(() => codec.push(`${'z'.repeat(32)}$`), { code: 'invalid-frame' });
  codec.close();
  assert.throws(() => codec.encode(payload), { code: 'closed' });
});

const helperScript = `
  import { createCipheriv, createDecipheriv } from 'node:crypto';
  import { connect } from 'node:net';
  import { writeFileSync } from 'node:fs';
  const [mode, metadataPath, sendToHost, receiveFromHost] = process.argv.slice(2);
  const key = Buffer.alloc(16, 37);
  const send = connect(sendToHost);
  const receive = connect(receiveFromHost);
  writeFileSync(metadataPath, JSON.stringify({ sendToHost, receiveFromHost, pid: process.pid }));
  const encode = (value) => {
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
    return Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString('hex') + '$';
  };
  if (mode !== 'silent') send.on('connect', () => {
    const frame = encode({type:'update', command:'native-ready'});
    send.write(frame.slice(0, 7));
    setTimeout(() => send.write(frame.slice(7)), 5);
  });
  let pending = '';
  let fragments = [];
  receive.on('data', (chunk) => {
    if (mode === 'no-ack') return;
    pending += chunk.toString('ascii');
    const end = pending.indexOf('$');
    if (end < 0) return;
    if (end !== pending.length - 1) process.exit(8);
    const [hex, , count] = pending.slice(0, end).split('#');
    pending = '';
    fragments.push(hex);
    if (!count || fragments.length === Number(count)) {
      const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16));
      const clear = Buffer.concat([decipher.update(Buffer.from(fragments.join(''), 'hex')), decipher.final()]);
      const message = JSON.parse(clear.toString('utf8'));
      if (message.command === 'hide') {
        setTimeout(() => send.write(encode({type:'response', command:'hide', data:{error:0, extendData:''}})), 100);
      } else if (message.command === 'endCall') {
        // An idle native helper only acknowledges the socket write.
      } else if (message.command === 'makeCall') {
        send.write(encode({type:'response', command:'show', data:{error:-1, extendData:'fixture rejection'}}));
      } else {
        send.write(encode({type:'response', command:message.command, data:{length:message.data.length, fragments:fragments.length}}));
      }
      fragments = [];
    }
    receive.write('a');
    setTimeout(() => receive.write('ck'), 5);
  });
`;

async function fakeHelper(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), 'zcb-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helper = join(directory, 'helper.mjs');
  const metadata = join(directory, 'metadata.json');
  await writeFile(helper, helperScript, { mode: 0o600 });
  return {
    source: { kind: 'external', executable: process.execPath, args: [helper, mode, metadata], transportKey: fixtureKey },
    paths: async () => JSON.parse(await readFile(metadata, 'utf8')),
  };
}

test('bridge waits for native readiness and serializes socket writes until each fragmented ack', { timeout: 4_000 }, async (t) => {
  const fixture = await fakeHelper(t, 'normal');
  const responses = [];
  let resolveResponses;
  const received = new Promise((resolve) => { resolveResponses = resolve; });
  const bridge = await startNativeCallBridge({ source: fixture.source, onMessage(message) {
    responses.push(message);
    if (responses.length === 3) resolveResponses();
  } });
  try {
    assert.deepEqual(responses, [{ type: 'update', command: 'native-ready' }]);
    const paths = await fixture.paths();
    assert.notEqual(paths.sendToHost, paths.receiveFromHost);
    assert.equal((await stat(dirname(paths.sendToHost))).mode & 0o777, 0o700);
    await Promise.all([
      bridge.send({ type: 'request', command: 'first', data: 'e'.repeat(4_100) }),
      bridge.send({ type: 'request', command: 'second', data: 'short' }),
    ]);
    await received;
    assert.deepEqual(responses.slice(1), [
      { type: 'response', command: 'first', data: { length: 4_100, fragments: 3 } },
      { type: 'response', command: 'second', data: { length: 5, fragments: 1 } },
    ]);
    await bridge.close();
    assert.equal(await bridge.closed, undefined);
    await assert.rejects(stat(dirname(paths.sendToHost)), { code: 'ENOENT' });
    assert.throws(() => process.kill(paths.pid, 0), { code: 'ESRCH' });
    await assert.rejects(bridge.send({ type: 'request', command: 'third' }), { code: 'closed' });
  } finally { await bridge.close(); }
});

test('startup and write timeout close the sockets and owned helper', { timeout: 4_000 }, async (t) => {
  const silent = await fakeHelper(t, 'silent');
  await assert.rejects(startNativeCallBridge({ source: silent.source, startupTimeoutMs: 350 }), { code: 'startup-timeout' });
  const silentPaths = await silent.paths();
  await assert.rejects(stat(dirname(silentPaths.sendToHost)), { code: 'ENOENT' });

  const noAck = await fakeHelper(t, 'no-ack');
  const bridge = await startNativeCallBridge({ source: noAck.source, ackTimeoutMs: 50 });
  try {
    await assert.rejects(bridge.send({ type: 'request', command: 'no-ack' }), { code: 'ack-timeout' });
    assert.equal((await bridge.closed).code, 'ack-timeout');
    const noAckPaths = await noAck.paths();
    await assert.rejects(stat(dirname(noAckPaths.sendToHost)), { code: 'ENOENT' });
  } finally { await bridge.close(); }
});

test('native requests correlate application replies and quarantine an expired response name', { timeout: 4_000 }, async (t) => {
  const fixture = await fakeHelper(t, 'normal');
  let resolveLate;
  const late = new Promise((resolve) => { resolveLate = resolve; });
  const bridge = await startNativeCallBridge({ source: fixture.source, onMessage(message) {
    if (message.type === 'response' && message.command === 'hide') resolveLate();
  } });
  try {
    await assert.rejects(bridge.request('hide', null, { timeoutMs: 35 }), { code: 'response-timeout' });
    await assert.rejects(bridge.request('hide', null), { code: 'request-pending' });
    await late;
    assert.deepEqual(await bridge.request('hide', null), { error: 0, extendData: '' });
    assert.equal(await bridge.send({ type: 'request', command: 'endCall', data: null }), undefined);
    assert.deepEqual(await bridge.request('makeCall', { type: 1, partner: [{ id: '42' }] }), {
      error: -1, extendData: 'fixture rejection',
    });
  } finally { await bridge.close(); }
});
