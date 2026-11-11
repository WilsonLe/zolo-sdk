import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { API } from 'zca-js';
import { CookieJar } from 'tough-cookie';
import { WebSocketServer } from 'ws';
import { startNativeCallController } from '../dist/native-call-controller.js';
import { startRealtimeFrameFeed } from '../dist/realtime-feed.js';

function frame(command, subcommand, body) {
  const header = Buffer.alloc(4);
  header[0] = 1;
  header.writeUInt16LE(command, 1);
  header[3] = subcommand;
  return Buffer.concat([header, Buffer.from(JSON.stringify(body))]);
}

for (const shareFeed of [false, true]) test(`native controller connects calls and filtered controls on ${shareFeed ? 'a shared' : 'its own'} SDK feed`, { timeout: 5_000 }, async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'zcb-controller-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let controller;
  let sharedFeed;
  try {
    await once(server, 'listening');
    const helperPath = join(fixtureDirectory, 'helper.mjs');
    const codecUrl = new URL('../dist/native-call-bridge.js', import.meta.url).href;
    await writeFile(helperPath, `
      import { connect } from 'node:net';
      import { createNativeCallCodec } from ${JSON.stringify(codecUrl)};
      const [, , incomingPath, outgoingPath] = process.argv;
      const codec = createNativeCallCodec(Buffer.alloc(16, 5));
      const incoming = connect(incomingPath);
      const outgoing = connect(outgoingPath);
      const send = (message) => { for (const fragment of codec.encode(message)) incoming.write(fragment); };
      incoming.once('connect', () => send({type:'update', command:'native-ready'}));
      let initialized = false;
      outgoing.on('data', (chunk) => {
        for (const message of codec.push(chunk)) {
          if (message.type === 'update' && message.command === 'init' && message.data.local.id === 'fixture-user') initialized = true;
          if (message.type === 'request' && message.command === 'makeCall' && initialized) {
            send({type:'sendSignal', command:401, data:{calleeId:'fixture-peer', callId:23, type:1}});
            send({type:'response', command:'show', data:{error:0, extendData:''}});
          }
          if (message.type === 'request' && message.command === 'hide') {
            send({type:'response', command:'hide', data:{error:0, extendData:''}});
          }
          if (message.type === 'recvSignal') {
            send({type:'update', command:'receivedSignal', data:message});
            send({type:'update', command:'callState', data:{state:'connected'}});
          }
          if (message.type === 'control') send({type:'update', command:'receivedControl', data:message});
        }
        outgoing.write('ack');
      });
    `, { mode: 0o600 });
    const key = Buffer.alloc(32, 13);
    const wsConnection = once(server, 'connection');
    const url = `ws://127.0.0.1:${server.address().port}`;
    const requests = [];
    const api = new API({
      API_TYPE: 30, API_VERSION: 695, imei: 'fixture-imei', cookie: new CookieJar(), userAgent: 'fixture', secretKey: key.toString('base64'),
      settings: { features: { sharefile: {}, socket: { retries: {}, ping_interval: 5_000 } } },
      options: { async polyfill(input, init) {
        const request = new URL(input);
        assert.equal(request.origin, 'https://calls.fixture.zalo.me');
        assert.equal(request.pathname, '/api/voicecall/requestcall');
        assert.equal(init.method, 'GET');
        const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
        const payload = Buffer.concat([decipher.update(Buffer.from(request.searchParams.get('params'), 'base64')), decipher.final()]);
        requests.push(JSON.parse(payload.toString('utf8')));
        const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
        const encrypted = Buffer.concat([cipher.update('{"error_code":0,"data":{"id":23,"sessId":"fixture-call"}}'), cipher.final()]);
        return Response.json({ error_code: 0, data: encrypted.toString('base64') });
      } },
    }, new Proxy({}, { get: () => ['https://calls.fixture.zalo.me'] }), [url]);

    const errors = [];
    const considered = [];
    let gotSignal;
    let gotControl;
    let gotBusy;
    const signalResult = new Promise((resolve) => { gotSignal = resolve; });
    const controlResult = new Promise((resolve) => { gotControl = resolve; });
    const busyResult = new Promise((resolve) => { gotBusy = resolve; });
    if (shareFeed) {
      sharedFeed = startRealtimeFrameFeed(api);
      await assert.rejects(startNativeCallController(Object.create(api), {
        feed: sharedFeed, init: { local: { id: 'fixture-other-account' } }, shouldForwardControl: () => true,
      }), { code: 'feed-mismatch' });
    }
    controller = await startNativeCallController(api, {
      feed: sharedFeed,
      native: { source: { kind: 'external', executable: process.execPath, args: [helperPath], transportKey: Buffer.alloc(16, 5) } },
      init: { local: { id: 'fixture-user' } },
      shouldForwardControl(control) { considered.push(control.act); return control.act === 'request'; },
      onNativeMessage(message) {
        if (message.command === 'receivedSignal') gotSignal(message.data);
        if (message.command === 'callState') gotBusy();
        if (message.command === 'receivedControl') gotControl(message.data);
      },
      onError(error) { errors.push(error); },
    });
    const [ws] = await wsConnection;
    ws.send(frame(1, 1, { key: key.toString('base64') }));
    assert.equal(await controller.ready, true);
    assert.equal(requests.length, 0);
    assert.deepEqual(await controller.makeCall({ partner: [{ id: 'fixture-peer' }], type: 1 }), { error: 0, extendData: '' });
    assert.deepEqual(await signalResult, { type: 'recvSignal', command: 401, data: { id: 23, sessId: 'fixture-call' } });
    assert.deepEqual(requests, [{ calleeId: 'fixture-peer', callId: 23, typeRequest: 1, codec: '[]', imei: 'fixture-imei' }]);
    await busyResult;

    const controls = [
      { content: { act_type: 'voip', act: 'answer', data: '{}' } },
      { content: { act_type: 'voip', act: 'request', data: '{"uidFrom":9000000000000000001}' } },
    ];
    ws.send(frame(601, 0, { encrypt: 0, data: JSON.stringify({ error_code: 0, data: { controls } }) }));
    assert.deepEqual(await controlResult, { type: 'control', data: {
      act_type: 'voip', act: 'request', inCallStatus: 'zalo', data: { uidFrom: '9000000000000000001' },
    } });
    assert.deepEqual(considered, ['answer', 'request']);
    assert.equal(server.clients.size, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(await controller.hide(), { error: 0, extendData: '' });
    await controller.endCall();
    await controller.close();
    if (sharedFeed) {
      let unsubscribe;
      const observed = new Promise((resolve) => { unsubscribe = sharedFeed.subscribe(resolve); });
      ws.send(frame(603, 0, { data: { controls } }));
      assert.equal((await observed).cmd, 603);
      assert.deepEqual(considered, ['answer', 'request']);
      unsubscribe();
    }
  } finally {
    await controller?.close();
    sharedFeed?.stop();
    for (const ws of server.clients) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
