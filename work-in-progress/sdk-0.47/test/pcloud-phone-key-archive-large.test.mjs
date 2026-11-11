import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { E2eeDirectConversation, decodeE2eeFrame } from 'zalo-personal-sdk/e2ee';
import { atomic } from './fixtures/pcloud-phone-key.mjs';
import { receivingSet, storedBank, winnerOnly, WK, vector, accountReply,
  assertUsable, bounded, childMaximum, bankMaximum } from './fixtures/pcloud-phone-key-archives.mjs';

const skipped = 2000, legacyCap = 384 * 1024;
const withheldText = (label, index) => 'independent archived withheld ' + label + ' ' + index + '\0';

function openText(receiver, frame, text) {
  const plaintext = receiver.decrypt(frame);
  try { assert.deepEqual(plaintext, Buffer.from(text)); } finally { plaintext.fill(0); }
}

function assertAllAvailable(checkpoint, prepared) {
  const clone = E2eeDirectConversation.restoreSealedState(checkpoint, WK);
  assert.equal(clone.pendingPreKey, false); assert.deepEqual(clone.acceptedRemoteBaseKey, prepared.base);
  let opened = 0;
  for (let index = 0; index < skipped; index++) {
    openText(clone, prepared.frames[index], withheldText(prepared.label, index)); opened++;
  }
  assert.throws(() => clone.decrypt(prepared.frames[0]), { code: 'replayed' });
  assert.throws(() => clone.decrypt(prepared.catchup), { code: 'replayed' });
  assert.equal(opened, 2000); return opened;
}

test('039 authentic receiving container larger than384KiB preserves two complete2000-key caches through a historical acquisition',
  { timeout: 60000 }, async t => {
    const f = await receivingSet(t), original = await f.store.load(), prepared = [];
    assert.equal(f.calls.length, 2); assert.deepEqual(f.sent, []);
    const deviceRevision = f.device.metadata.revision, otks = f.device.metadata.remainingOneTimePreKeys;
    const confirmation = join(f.directory, 'independent-large-receiving-confirmed.json');
    for (const entry of [f.current, f.archives[0]]) {
      const anchorText = 'independent first ordinary receive ' + entry.label;
      const anchor = entry.remote.encrypt(anchorText); assert.equal(decodeE2eeFrame(anchor).kind, 'direct');
      openText(entry.receiver, anchor, anchorText);
      const frames = [];
      // The existing public recipe separates a2000-key retained cache from the
      // per-call lookahead bound:1999 withheld, delivered anchor,1 withheld, anchor.
      for (let index = 0; index < skipped - 1; index++) {
        const frame = entry.remote.encrypt(withheldText(entry.label, index));
        assert.equal(decodeE2eeFrame(frame).kind, 'direct'); frames.push(frame);
      }
      const intermediateText = 'independent bounded-hop middle ' + entry.label;
      openText(entry.receiver, entry.remote.encrypt(intermediateText), intermediateText);
      frames.push(entry.remote.encrypt(withheldText(entry.label, skipped - 1)));
      const catchupText = 'independent final cache anchor ' + entry.label;
      const catchup = entry.remote.encrypt(catchupText); openText(entry.receiver, catchup, catchupText);
      assert.equal(frames.length, 2000); assert.equal(entry.receiver.pendingPreKey, false);
      assert.deepEqual(entry.receiver.acceptedRemoteBaseKey, entry.base);
      entry.checkpoint = entry.receiver.sealState(WK);
      assert.ok(Buffer.byteLength(entry.checkpoint) <= childMaximum);
      const record = { label: entry.label, base: entry.base, frames, catchup };
      assert.equal(assertAllAvailable(entry.checkpoint, record), 2000); prepared.push(record);
      // Latest per-lineage receiving states are durably confirmed by this
      // synthetic caller before import; no padding/private-state rewrite exists.
      await atomic(confirmation, { deviceCheckpoint: original.deviceCheckpoint,
        children: f.entries.map(value => value.checkpoint) });
    }
    const rsa = await vector(), approval = f.archives[0].remote.encrypt(rsa.text);
    assert.equal(decodeE2eeFrame(approval).kind, 'direct');
    const coordinator = await f.attachSet({ maxSkippedMessages: skipped }), before = await f.store.load();
    const imported = storedBank(before), beforeBytes = Buffer.byteLength(imported.text);
    assert.deepEqual(imported.children, f.entries.map(entry => entry.checkpoint));
    assert.ok(beforeBytes > legacyCap, 'An authentic container must cross the legacy standalone section cap.');
    assert.ok(beforeBytes <= bankMaximum); assert.equal(before.deviceCheckpoint, original.deviceCheckpoint);
    assert.equal(f.promptCalls().length, 0);
    let handoff = false;
    f.hooks.http = call => {
      handoff = true; assert.equal(call.url.pathname, '/prefix/personalcloud_key/req_cloud_key');
      assert.equal(call.init.method, 'GET'); f.approve(call, approval, rsa); return accountReply(undefined, { key: f.key });
    };
    // Only this intentionally large case gets a5000ms phone wait and a15000ms
    // external operation bound. No global positive/negative fixture is changed.
    const result = await bounded(coordinator.request({ timeoutMs: 5000 }), 15000);
    t.after(() => result.enrollment.dispose()); assert.equal(handoff, true); assertUsable(result.enrollment, rsa);
    const after = await f.store.load(), committed = winnerOnly(before, after, 1);
    const afterBytes = Buffer.byteLength(committed.text);
    assert.ok(afterBytes > legacyCap && afterBytes <= bankMaximum);
    assert.equal(f.device.metadata.revision, deviceRevision); assert.equal(f.device.metadata.remainingOneTimePreKeys, otks);
    assert.equal(after.deviceCheckpoint, original.deviceCheckpoint); assert.deepEqual(f.sent, []);
    assert.equal(f.promptCalls().length, 1); assert.ok(committed.opened.plain.length <= 8 * 1024 * 1024);
    assert.equal(assertAllAvailable(committed.children[0], prepared[0]), 2000);
    assert.equal(assertAllAvailable(committed.children[1], prepared[1]), 2000);
    const consumed = E2eeDirectConversation.restoreSealedState(committed.children[1], WK);
    assert.throws(() => consumed.decrypt(approval), { code: 'replayed' });
    assert.equal(f.store.attempts.filter(transaction => transaction.kind === 'signal-result').length, 1);
    t.diagnostic(JSON.stringify({ beforeContainerBytes: beforeBytes, afterContainerBytes: afterBytes,
      aggregatePlaintextBytes: committed.opened.plain.length, preparedReceivingCaches: prepared.length,
      skippedKeysPerCacheBeforeAndAfter: 2000, firstHopWithheld: 1999, finalHopWithheld: 1,
      historicalWinnerIndex: 1, promptGets: 1, signalResultCommits: 1 }));
  });
