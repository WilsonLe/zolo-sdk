import assert from 'node:assert/strict';
import test from 'node:test';
import { E2EE, WK, PEER_UID, attach, content, deviceJournal, initRow, messageRow, page, peer, peerInput,
  recoveryJournal, results, serve, transportFixture, releaseOwners } from './fixtures/desktop-recovery.mjs';
const options = { timeout: 20000 };
async function partial(t, rows) {
  const f = await transportFixture(t, { queues: [{ cmd: 516, subCmd: 0 }] }), remote = peer();
  const sender = E2EE.E2eeDirectConversation.initiate({ localRegistrationId: remote.bundle.registrationId,
    localIdentityPrivateKey: remote.privateKeys.identityPrivateKey, trustedRemoteIdentityKey: f.device.getPublicBundle().identityKey,
    peerBundle: f.device.getPublicBundle() });
  const init = initRow(sender.encrypt('{"subDevice":[]}'), { id: '10' }), prefix = rows ? rows(init) : [init];
  const owner = await attach(f, [peerInput(remote)]);
  serve(f, { 516: [{ rows: prefix, more: true, lastActionId: '20', resumeActionId: '1000' }] });
  const collection = await owner.collect({ maxPages: 1 });
  assert.equal(collection.completed, false); assert.equal(collection.incompleteCollectionIds.length, 1);
  assert.equal(f.sent[0].data.first, true); assert.equal(f.sent[0].data.lastId, '1');
  assert.equal(f.device.metadata.remainingOneTimePreKeys, 12); assert.equal((await owner.readOutbox()).length, 0);
  const snapshot = await owner.checkpoint(); await owner.dispose(); await owner.closed; f.device.dispose();
  const g = await transportFixture(t, { deviceCheckpoint: snapshot.deviceCheckpoint, store: f.store,
    queues: [{ cmd: 516, subCmd: 0 }] });
  const restored = await attach(g, [peerInput(remote)]);
  assert.equal(restored.metadata.phase, 'reconciliation-required'); assert.equal(g.sent.length, 0);
  return { f, g, remote, init, prefix, collection, restored, snapshot };
}

test('044 incomplete516 restarts by explicit cold recollection with ordered duplicate-prefix preservation', options, async t => {
  const state = await partial(t, init => [init, structuredClone(init)]), { g, restored, init, collection } = state;
  const extra = { cmd: 999, msgId: '30', sessionData: { uidFrom: PEER_UID, future: true } };
  serve(g, { 516: [{ rows: [init, structuredClone(init)], more: true, lastActionId: '21', resumeActionId: '2000' }, { rows: [extra] }] });
  const replay = await restored.recollect({ incompleteCollectionId: collection.incompleteCollectionIds[0], policy: 'preserve-known-inputs' });
  assert.equal(g.sent[0].data.first, true); assert.equal(g.sent[0].data.lastId, '1');
  assert.equal(g.sent[1].data.first, false); assert.equal(g.sent[1].data.lastId, '21');
  assert.equal(replay.completed, true); assert.equal(replay.continuityUnproven, true);
  assert.equal(restored.metadata.continuityUnproven, true);
  await restored.process(); assert.equal(g.device.metadata.remainingOneTimePreKeys, 11);
  assert.equal((await results(restored)).filter(row => row.authenticated).length, 1);
  assert.equal((await restored.readBlocked()).some(row => row.raw.cmd === 999), true);
  const journal = recoveryJournal((await restored.checkpoint()).recoveryCheckpoint);
  assert.ok(journal.sections.intake.includes(Buffer.from('2000')), 'Later candidate queue watermark remains evidence, not the cold-start replacement.');
});

test('044 recollection refuses omitted, reordered, multiplicity-lost and sameID-changed known rows without crypto or ACK', options, async t => {
  for (const alteration of ['omitted', 'reordered', 'duplicate-lost', 'changed']) {
    const state = await partial(t, init => [init, structuredClone(init), { cmd: 999, msgId: '11', sessionData: { future: 'known-prefix' } }]);
    const { g, restored, prefix, collection } = state;
    try {
      let rows = structuredClone(prefix);
      if (alteration === 'omitted') rows = rows.slice(0, 2);
      if (alteration === 'reordered') rows = [rows[2], rows[0], rows[1]];
      if (alteration === 'duplicate-lost') rows = [rows[0], rows[2]];
      if (alteration === 'changed') rows[0].sessionData.future = 'changed';
      serve(g, { 516: [{ rows }] });
      const observed = await restored.recollect({ incompleteCollectionId: collection.incompleteCollectionIds[0], policy: 'preserve-known-inputs' });
      assert.equal(observed.completed, false); assert.equal(observed.blocked, true);
      assert.equal(restored.metadata.phase, 'reconciliation-required'); assert.equal(restored.metadata.continuityUnproven, true);
      assert.equal(g.device.metadata.remainingOneTimePreKeys, 12); assert.equal((await restored.readOutbox()).length, 0);
      assert.equal((await results(restored)).length, 0);
      assert.ok(recoveryJournal((await restored.checkpoint()).recoveryCheckpoint).sections.intake.includes(Buffer.from('known-prefix')));
      assert.equal(g.sent.some(row => [544, 545].includes(row.cmd)), false);
    } finally { await releaseOwners(g); }
  }
});

test('044 complete516 retained bytes process after restart with no server replay or implicit pull', options, async t => {
  const f = await transportFixture(t), remote = peer();
  const sender = E2EE.E2eeDirectConversation.initiate({ localRegistrationId: remote.bundle.registrationId,
    localIdentityPrivateKey: remote.privateKeys.identityPrivateKey, trustedRemoteIdentityKey: f.device.getPublicBundle().identityKey,
    peerBundle: f.device.getPublicBundle() });
  const owner = await attach(f, [peerInput(remote)]);
  serve(f, { 516: [{ rows: [initRow(sender.encrypt('{"subDevice":[]}'))] }] });
  assert.equal((await owner.collect()).completed, true);
  const snapshot = await owner.checkpoint(); await owner.dispose(); await owner.closed; f.device.dispose();
  const g = await transportFixture(t, { deviceCheckpoint: snapshot.deviceCheckpoint, store: f.store });
  const restored = await attach(g, [peerInput(remote)]); await restored.process();
  assert.equal(g.sent.length, 0); assert.equal((await results(restored))[0].kind, 'control');
  assert.equal((await restored.readOutbox()).length, 2); assert.equal(g.device.metadata.remainingOneTimePreKeys, 11);
});

test('044 reset and exacteviction1 are durable reconciliation barriers retaining raw input and keys', options, async t => {
  for (const mode of ['reset', 'evict']) {
    const f = await transportFixture(t, { queues: [{ cmd: 516, subCmd: 0 }] }), remote = peer();
    try {
      const sender = E2EE.E2eeDirectConversation.initiate({ localRegistrationId: remote.bundle.registrationId,
        localIdentityPrivateKey: remote.privateKeys.identityPrivateKey, trustedRemoteIdentityKey: f.device.getPublicBundle().identityKey,
        peerBundle: f.device.getPublicBundle() });
      const row = initRow(sender.encrypt('{"subDevice":[]}')), owner = await attach(f, [peerInput(remote)]);
      serve(f, { 516: [{ rows: [row], ...(mode === 'reset' ? { resetLastActionId: '999' } : { evict: 1 }) }] });
      const before = f.device.metadata.revision, observed = await owner.collect();
      assert.equal(observed.completed, false); assert.equal(observed.blocked, true);
      assert.equal(owner.metadata.phase, 'reconciliation-required'); assert.equal(f.device.metadata.revision, before);
      assert.equal((await owner.readOutbox()).length, 0); assert.equal((await results(owner)).length, 0);
      assert.equal(f.sent.some(value => [544, 545, 563, 540, 542].includes(value.cmd)), false);
      const checkpoint = await owner.checkpoint(); assert.ok(checkpoint.recoveryCheckpoint);
      assert.equal(deviceJournal(checkpoint.deviceCheckpoint).metadata.revision, before);
      assert.ok(recoveryJournal(checkpoint.recoveryCheckpoint).sections.intake.includes(Buffer.from(row.sessionData.data)));
    } finally { await releaseOwners(f); }
  }
});

test('044 intake preserves mixed unsupported lifecycle rows and no active key or downgrade operation is inferred', options, async t => {
  const f = await transportFixture(t), remote = peer(), owner = await attach(f, [peerInput(remote)]);
  const rows = [548, 549, 581, 580].map((cmd, index) => ({ cmd, msgId: String(800 + index), sessionData: {
    uidFrom: PEER_UID, uidTo: f.uid, deviceId: 0, ...(cmd === 549 ? { type: 1 } : {}), ...(cmd === 581 ? { data: 'target-other' } : {}) } }));
  rows.push({ cmd: 549, msgId: '804', sessionData: { uidFrom: PEER_UID, deviceId: 0, type: 2 } });
  rows.push({ cmd: 544, msgId: '805', sessionData: { uidFrom: PEER_UID, deviceId: 0, type: 0, iid: 'untrusted-currentness' } });
  rows.push(null, 7);
  serve(f, { 516: [{ rows }] }); const before = await owner.checkpoint(); await owner.collect(); await owner.process();
  assert.equal((await owner.readBlocked()).length, 6);
  const notices = (await results(owner)).filter(value => value.kind === 'notice');
  assert.equal(notices.length, 2); assert.ok(notices.every(value => value.authenticated === false && value.content === undefined));
  assert.equal((await owner.readOutbox()).every(value => value.command === 545), true);
  assert.equal((await owner.readOutbox()).length, 2); assert.equal(f.device.metadata.revision, deviceJournal(before.deviceCheckpoint).metadata.revision);
  const preserved = await owner.checkpoint(); assert.equal(preserved.deviceCheckpoint, before.deviceCheckpoint);
  assert.deepEqual(recoveryJournal(preserved.recoveryCheckpoint).bank, recoveryJournal(before.recoveryCheckpoint).bank);
  await owner.dispatch(); assert.equal(f.sent.some(value => [540, 541, 542, 543, 563].includes(value.cmd)), false);
});

test('044 complete516 comparator uses exact BigInt bases, local rank and truthy equal text IDs before cutoff', options, async t => {
  const cases = [
    { disable: '9007199254740992', init: '9007199254740993', processOnly: false, ignore: true },
    { disable: '.12_999', init: '12', processOnly: false, ignore: true },
    { disable: '12_0', init: '12', processOnly: true, ignore: false },
    { disable: '0012', init: '12', processOnly: true, ignore: false },
    { disable: '00012', init: '.12', processOnly: true, ignore: false },
  ];
  for (const item of cases) {
    const f = await transportFixture(t, { queues: [{ cmd: 516, subCmd: 0 }] }), remote = peer();
    try {
      const owner = await attach(f, [peerInput(remote)], { generationCutoff: { timestamp: 500, provenance: 'fixture-owned-old-generation' } });
      const disable = { cmd: 580, msgId: item.disable, sessionData: { uidFrom: PEER_UID, threadId: PEER_UID, deviceId: 0, ts: 100 } };
      const init = initRow('intentionally never decrypted because cutoff follows flags', { id: item.init, ts: 100 });
      serve(f, { 516: [{ rows: [disable], more: true }, { rows: [init] }] });
      await owner.collect(); await owner.process();
      const state = recoveryJournal((await owner.checkpoint()).recoveryCheckpoint), tuples = state.intake.records;
      assert.equal(tuples.length, 2); const disableFlags = tuples[0][8], initFlags = tuples[1][8];
      assert.equal(Boolean(disableFlags & 2), item.ignore); assert.equal(Boolean(initFlags & 1), item.processOnly);
      assert.equal(f.device.metadata.remainingOneTimePreKeys, 12);
      const notices = await results(owner); assert.equal(notices.length, 2);
      assert.ok(notices.every(value => value.kind === 'notice' && value.authenticated === false && value.content === undefined));
      const outbox = await owner.readOutbox(); assert.equal(outbox.length, 2);
      assert.ok(outbox.every(value => value.command === 545));
      await owner.dispatch();
      assert.deepEqual(f.sent.filter(value => value.cmd === 545).flatMap(value => value.data.data.info.map(info => info.cmd)), [580, 543]);
      assert.equal((await owner.readOutbox()).some(row => row.command === 544), false);
    } finally { await releaseOwners(f); }
  }
  for (const id of ['', '0', '000', '.0', '0_1', '1_9007199254740992']) {
    const f = await transportFixture(t, { queues: [{ cmd: 516, subCmd: 0 }] }), remote = peer();
    try {
      const owner = await attach(f, [peerInput(remote)]);
      serve(f, { 516: [{ rows: [{ cmd: 580, msgId: id, sessionData: { threadId: PEER_UID, uidFrom: PEER_UID, deviceId: 0 } }] }] });
      const observed = await owner.collect(); assert.equal(observed.completed, false); assert.equal(observed.blocked, true);
      assert.equal(f.device.metadata.remainingOneTimePreKeys, 12); assert.equal((await owner.readOutbox()).length, 0);
      const records = recoveryJournal((await owner.checkpoint()).recoveryCheckpoint).intake.records;
      assert.equal(records.length, 1); assert.equal(records[0][8], -1, 'Ordering outside the admitted domain cannot receive finalized flags.');
    } finally { await releaseOwners(f); }
  }
});
