import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { E2EE, WK, UID, PRIVATE, PEER_UID, attach, bounded, children, clone, content, deviceJournal, gate,
  initRow, messageRow, page, peer, peerInput, recoveryJournal, results, serve, transportFixture, assertNoUnexpectedCommands } from './fixtures/desktop-recovery.mjs';
const options = { timeout: 20000 };

test('044 complete global multi-page516 precedes cryptography and durably prepares exact544 then dependent545', options, async t => {
  const f = await transportFixture(t), remote = peer();
  const sending = E2EE.E2eeDirectConversation.initiate({ localRegistrationId: remote.bundle.registrationId,
    localIdentityPrivateKey: remote.privateKeys.identityPrivateKey, trustedRemoteIdentityKey: f.device.getPublicBundle().identityKey,
    peerBundle: f.device.getPublicBundle() });
  const init = initRow(sending.encrypt('{"subDevice":[1]}'));
  const text = messageRow(sending.encrypt('confirmed synthetic message'));
  const rtf = messageRow({ action: 'rtf', title: sending.encrypt('confirmed rich title'), params: sending.encrypt('{"styles":[]}') }, { id: '202' });
  const unknown = { cmd: 999, msgId: '999', sessionData: { uidFrom: PEER_UID, deviceId: 0, future: [PRIVATE] } };
  const held = gate(); let finalRequest;
  const owner = await attach(f, [peerInput(remote)], { initialTrackedSelfDevices: [1] });
  serve(f, { 513: [{ rows: [text, rtf], resumeActionId: '513100' }], 713: [{ rows: [], resumeActionId: '713100' }],
    516: [{ rows: [init], more: true, lastActionId: '10', resumeActionId: '900' },
      { hold(request) { finalRequest = request; held.resolve(); } }] });
  const revision = f.device.metadata.revision, count = f.device.metadata.remainingOneTimePreKeys;
  const collecting = owner.collect(); await bounded(held.promise);
  assert.equal(f.device.metadata.revision, revision); assert.equal(f.device.metadata.remainingOneTimePreKeys, count);
  assert.equal(owner.metadata.outboxPendingCount, 0); assert.equal(f.sent.some(request => request.cmd === 544 || request.cmd === 545), false);
  assert.equal(finalRequest.data.first, false); assert.equal(finalRequest.data.lastId, '10');
  f.emit(516, page(finalRequest, [unknown], { more: false, lastActionId: '20', resumeActionId: '1000' }));
  const collected = await collecting; assert.equal(collected.completed, true); assert.equal(collected.records, 4);
  const intake = await f.store.current(); assert.equal(intake.deviceCheckpoint, (await owner.checkpoint()).deviceCheckpoint);
  const processed = await owner.process(); assert.equal(processed.accepted, 3); assert.equal(processed.blocked, 1);
  const inbox = await results(owner); assert.deepEqual(inbox.map(value => value.kind), ['control', 'message', 'message']);
  assert.equal(content(inbox[1]), 'confirmed synthetic message'); assert.equal(content(inbox[2]), 'confirmed rich title');
  assert.equal(Buffer.from(inbox[2].styles).toString(), '{"styles":[]}');
  const blocked = await owner.readBlocked(); assert.equal(blocked.length, 1); assert.deepEqual(blocked[0].raw, unknown);
  assert.equal(f.device.metadata.remainingOneTimePreKeys, count - 1); assert.equal(f.device.metadata.revision, revision + 1);
  const prepared = await f.store.current(), outbox = await owner.readOutbox();
  assert.equal(recoveryJournal(prepared.recoveryCheckpoint).metadata.selectors.find(value => value.cmd === 516).stable, '1', 'Blocked global row prevents processed watermark crossing.');
  assert.deepEqual(outbox.map(value => [value.command, value.subCommand, value.status]), [[544, 0, 'prepared'], [545, 1, 'prepared']]);
  assert.equal(outbox[1].dependency, outbox[0].outboxId); assert.equal(f.sent.some(request => request.cmd === 544), false);
  const replySeen = [];
  serve(f, {}, request => {
    assert.equal(f.store.attempts.at(-1).kind, 'outbox-intent', 'Durable intent must precede each sender invocation.');
    if (request.cmd === 544) {
      assert.equal(request.version, 1); assert.equal(request.subCmd, 0); assert.deepEqual(Object.keys(request.data).sort(), ['data', 'reqId']);
      assert.equal(request.data.data.type, 1); assert.equal(request.data.data.uidTo, PEER_UID);
      assert.equal(request.data.data.data.length, 1); assert.equal(request.data.data.data[0].deviceId, 0);
      assert.equal(request.data.data.data[0].ts, 200);
      const plaintext = sending.decrypt(request.data.data.data[0].data).toString();
      assert.equal(plaintext, '{"subDevice":[1]}'); replySeen.push(plaintext);
      assert.notEqual(f.store.attempts.at(-1).expected.recoveryCheckpointSha256, undefined);
    } else {
      assert.equal(replySeen.length, 1); assert.equal(request.subCmd, 1); assert.equal(request.version, 1);
      assert.deepEqual(request.data.data, { queueName: '', info: [{ gid: '101', cmd: 543, subCmd: 0, sid: PEER_UID, deviceId: 0 }] });
      assert.ok(f.store.attempts.some(value => value.kind === 'outbox-outcome'));
    }
  });
  const dispatched = await owner.dispatch(); assert.equal(dispatched.attempted, 2); assert.equal(dispatched.acknowledged, 2);
  assert.deepEqual((await owner.readOutbox()).map(value => value.status), ['acknowledged', 'acknowledged']);
  assert.ok(children(prepared).length >= 1); assertNoUnexpectedCommands(f);
  const disk = await readFile(f.store.path, 'utf8'); assert.equal(disk.includes('confirmed synthetic message'), false); assert.equal(disk.includes(PRIVATE), false);
});

test('044 whole516 processOnly derives across pages and suppresses544 without discarding accepted session state', options, async t => {
  const f = await transportFixture(t, { queues: [{ cmd: 516, subCmd: 0 }] }), remote = peer();
  const sender = E2EE.E2eeDirectConversation.initiate({ localRegistrationId: remote.bundle.registrationId,
    localIdentityPrivateKey: remote.privateKeys.identityPrivateKey, trustedRemoteIdentityKey: f.device.getPublicBundle().identityKey, peerBundle: f.device.getPublicBundle() });
  const owner = await attach(f, [peerInput(remote)]);
  serve(f, { 516: [{ rows: [initRow(sender.encrypt('{"subDevice":[]}'), { id: '10', processOnly: false })], more: true },
    { rows: [{ cmd: 580, msgId: '20', sessionData: { threadId: PEER_UID, uidFrom: PEER_UID, deviceId: 0 } }] }] });
  await owner.collect(); await owner.process();
  assert.equal(f.device.metadata.remainingOneTimePreKeys, 11); assert.ok(children(await owner.checkpoint()).length > 0);
  const outbox = await owner.readOutbox(); assert.equal(outbox.some(value => value.command === 544), false);
  assert.equal(outbox.filter(value => value.command === 545).length, 1);
  assert.equal((await owner.readBlocked()).length, 1, 'The active disable request is retained, not applied as an automatic downgrade.');
  await owner.dispatch(); assert.equal(f.sent.filter(value => value.cmd === 544).length, 0); assert.equal(f.sent.filter(value => value.cmd === 545).length, 1);
});

test('044 offline545 init alias does not acquire543 preprocessing influence and cannot become a live545 init', options, async t => {
  const f = await transportFixture(t, { queues: [{ cmd: 516, subCmd: 0 }] }), remote = peer();
  const sender = E2EE.E2eeDirectConversation.initiate({ localRegistrationId: remote.bundle.registrationId,
    localIdentityPrivateKey: remote.privateKeys.identityPrivateKey, trustedRemoteIdentityKey: f.device.getPublicBundle().identityKey, peerBundle: f.device.getPublicBundle() });
  const owner = await attach(f, [peerInput(remote)]);
  serve(f, { 516: [{ rows: [initRow(sender.encrypt('{"subDevice":[]}'), { cmd: 545, id: '10' }),
    { cmd: 580, msgId: '20', sessionData: { threadId: PEER_UID, uidFrom: PEER_UID, deviceId: 0 } }] }] });
  await owner.collect(); await owner.process();
  assert.deepEqual((await owner.readOutbox()).map(value => value.command), [544, 545]);
  assert.equal((await owner.readBlocked()).length, 1);
  const revision = f.device.metadata.revision;
  f.emit(545, { error_code: 0, data: { eesession: [initRow(sender.encrypt('not a permitted live init'), { cmd: 545, id: '11' })] } }, 1);
  await owner.process(); assert.equal(f.device.metadata.revision, revision);
  assert.equal((await owner.readOutbox()).length, 2);
});

test('044 locally derived ignore beats raw provider flags and generation cutoff is applied after the complete decision', options, async t => {
  const f = await transportFixture(t, { queues: [{ cmd: 516, subCmd: 0 }] }), remote = peer();
  const sender = E2EE.E2eeDirectConversation.initiate({ localRegistrationId: remote.bundle.registrationId,
    localIdentityPrivateKey: remote.privateKeys.identityPrivateKey, trustedRemoteIdentityKey: f.device.getPublicBundle().identityKey, peerBundle: f.device.getPublicBundle() });
  const owner = await attach(f, [peerInput(remote)], { generationCutoff: { timestamp: '150', provenance: 'explicit synthetic local E2EE generation' } });
  const disable = { cmd: 580, msgId: '10', sessionData: { threadId: PEER_UID, uidFrom: PEER_UID, deviceId: 0, ignore: false, ts: '200' } };
  serve(f, { 516: [{ rows: [disable], more: true }, { rows: [initRow(sender.encrypt('{"subDevice":[]}'), { id: '20', ts: '100', reqServerTs: '900', ignore: false })] }] });
  await owner.collect(); await owner.process();
  assert.equal(f.device.metadata.remainingOneTimePreKeys, 12, 'Old init is skipped only after it supplied the final full-collection ordering decision.');
  assert.equal((await owner.readBlocked()).length, 0);
  assert.equal((await owner.readOutbox()).some(value => value.command === 544), false);
  assert.equal((await owner.readOutbox()).filter(value => value.command === 545).length, 2);
});

test('044 self phone copies share a crypto address across distinct displayed conversations and self notes', options, async t => {
  const f = await transportFixture(t), remote = peer(), established = await f.receiving(remote, 'self');
  const owner = await attach(f, [peerInput(remote, { userId: f.uid, current: established.checkpoint })]);
  const values = ['first friend copy', 'second friend copy', 'self note'];
  serve(f, { 513: [{ rows: values.map((value, index) => messageRow(established.remote.encrypt(value), {
    uid: '0', idTo: ['93001', '93002', '0'][index], id: String(300 + index) })) }] });
  const revision = f.device.metadata.revision; await owner.collect(); await owner.process();
  const inbox = await results(owner); assert.deepEqual(inbox.map(content), values);
  assert.deepEqual(inbox.map(value => value.cryptoUserId), [UID, UID, UID]);
  assert.deepEqual(inbox.map(value => value.cryptoDeviceId), [0, 0, 0]);
  assert.deepEqual(inbox.map(value => value.displayThreadId), ['93001', '93002', UID]);
  assert.equal(f.device.metadata.revision, revision); assert.equal((await owner.readBlocked()).length, 0);
});

test('044 ownPC text and RTF are explicit unauthenticated echoes while UNDO and numeric string aliases remain blocked', options, async t => {
  const f = await transportFixture(t), remote = peer(), owner = await attach(f, [peerInput(remote)]);
  const echoText = messageRow('not Signal plaintext', { uid: '0', deviceId: 2, idTo: '93001', id: '401' });
  const echoRtf = messageRow({ action: 'rtf', title: 'opaque echo', params: 'opaque styles' }, { uid: '0', deviceId: 2, idTo: '93002', id: '402' });
  serve(f, { 513: [{ rows: [echoText, echoRtf,
    messageRow('opaque undo', { uid: '0', deviceId: 2, type: 'chat.undo', id: '403' }),
    messageRow('opaque numeric alias', { uid: '0', deviceId: 2, type: '1', id: '404' })] }] });
  const before = f.device.sealState(WK); await owner.collect(); await owner.process();
  const inbox = await results(owner); assert.deepEqual(inbox.map(value => [value.kind, value.authenticated, value.content]), [['echo', false, undefined], ['echo', false, undefined]]);
  assert.equal((await owner.readBlocked()).length, 2); assert.equal((await owner.readOutbox()).length, 0);
  assert.equal(deviceJournal(before).metadata.revision, f.device.metadata.revision);
});

test('044 private ingress snapshots precede earlier public frame mutation and continuous551 accepts byte subtypes', options, async t => {
  const f = await transportFixture(t), remote = peer(), established = await f.receiving(remote, 'live');
  const original = ['live subtype zero', 'live subtype byte255'];
  f.feed.subscribe(frame => { if (frame.cmd === 551) { frame.payload.data.msgs[0].content = PRIVATE; frame.payload.data.msgs[0].uidFrom = '999999'; } });
  const owner = await attach(f, [peerInput(remote, { current: established.checkpoint })]);
  serve(f); await owner.collect();
  f.emit(551, { error_code: 0, data: { msgs: [messageRow(established.remote.encrypt(original[0]), { id: '501' })] } }, 0);
  f.emit(551, { error_code: 0, data: { msgs: [messageRow(established.remote.encrypt(original[1]), { id: '502' })] } }, 255);
  await owner.process(); assert.deepEqual((await results(owner)).map(content), original);
  for (const [cmd, version, id] of [[551, 2, '503'], [552, 1, '504'], [535, 1, '505']])
    f.emit(cmd, { error_code: 0, data: { msgs: [messageRow('unsupported ciphertext', { id })] } }, 1, version);
  await owner.process(); assert.equal((await owner.readBlocked()).length, 3);
  assert.deepEqual((await results(owner)).map(content), original); assertNoUnexpectedCommands(f);
});

test('044 result copies are isolated, stable after restart reads and acknowledgment never rolls back replay state', options, async t => {
  const f = await transportFixture(t), remote = peer(), established = await f.receiving(remote, 'consumer');
  const owner = await attach(f, [peerInput(remote, { current: established.checkpoint })]);
  serve(f, { 513: [{ rows: [messageRow(established.remote.encrypt('durable consumer message'))] }] });
  await owner.collect(); await owner.process(); const first = (await results(owner))[0];
  const stableId = first.resultId, next = clone(first); first.content.fill(0);
  assert.equal(content((await results(owner))[0]), 'durable consumer message');
  assert.equal((await results(owner))[0].resultId, stableId);
  const before = await owner.checkpoint(); await owner.acknowledgeResults([stableId]);
  assert.equal((await results(owner)).length, 0); assert.equal(owner.metadata.unreadResultCount, 0);
  const after = await owner.checkpoint(); assert.equal(before.deviceCheckpoint, after.deviceCheckpoint);
  assert.equal(content(next), 'durable consumer message');
  assert.equal(recoveryJournal(after.recoveryCheckpoint).metadata.revision, owner.metadata.recoveryRevision);
});
