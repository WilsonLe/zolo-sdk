import assert from 'node:assert/strict';
import test from 'node:test';
import { createPcPhoneBackup, preparePcPhoneBackup, PcPhoneBackupJobError } from '../dist/pc-phone-backup-creation.js';
import { openPcPhoneBackupCheckpoint } from '../dist/pc-phone-backup-checkpoint.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

const key = () => Buffer.alloc(32, 0x59);
const source = () => ({ revision: 'synthetic-error-provenance-v1',
  async readThreads() { assert.fail('No source read is expected before initial persistence.'); },
  async readMessages() { assert.fail('No message read is expected before initial persistence.'); },
});
const options = onCheckpoint => ({ filePath: '/tmp/zalo-sdk-synthetic-error-provenance.bin', wrappingKey: key(), onCheckpoint });

async function issuedError(f) {
  let callbacks = 0, issued;
  await assert.rejects(preparePcPhoneBackup(f.connection, f.feed, source(), options(() => {
    callbacks++; throw Error('private-checkpoint-callback');
  })), error => {
    assert.ok(error instanceof PcPhoneBackupJobError); assert.equal(error.code, 'checkpoint-failed');
    assert.equal(error.stage, 'checkpoint'); assert.equal(error.submitted, false);
    assert.equal(openPcPhoneBackupCheckpoint(error.getCheckpoint(), key()).phase, 'creating');
    issued = error; return true;
  });
  assert.equal(callbacks, 1); assert.equal(f.sent.length, 0); assert.equal(f.httpCalls.length, 2);
  // A real exposed SDK error is mutable caller data once returned. Its old
  // private WeakSet membership must not grant authority at a new input boundary.
  issued.code = 'rejected'; issued.stage = 'upload'; issued.submitted = true;
  issued.outcomeUnknown = false; issued.acceptedChunks = 123; issued.sessionAllocated = true; issued.providerCode = 212;
  issued.message = 'private-reused-job-error'; issued.cause = { secret: 'private-reused-cause' };
  issued.raw = { secret: 'private-reused-response' };
  Object.defineProperty(issued, 'getCheckpoint', { value: () => 'private-stale-checkpoint-authority' });
  return issued;
}
function safeFresh(error, issued) {
  assert.ok(error instanceof PcPhoneBackupJobError); assert.notEqual(error, issued);
  assert.equal(error.code, 'invalid-input'); assert.equal(error.stage, 'preflight');
  assert.equal(error.submitted, false); assert.equal(error.outcomeUnknown, false);
  assert.equal(error.acceptedChunks, 0); assert.equal(error.sessionAllocated, false);
  assert.equal(error.providerCode, undefined); assert.equal(error.getCheckpoint(), undefined);
  for (const field of ['cause', 'raw', 'response']) assert.equal(Object.hasOwn(error, field), false);
  assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /private-reused|private-stale|private-checkpoint/);
  return true;
}

test('a previously issued mutable job error thrown by an options prototype trap is fresh preflight data', async t => {
  const f = await desktopFeedFixture(t), issued = await issuedError(f); let saves = 0, traps = 0;
  const input = new Proxy(options(() => { saves++; }), { getPrototypeOf() { traps++; throw issued; } });
  await assert.rejects(createPcPhoneBackup(f.connection, f.feed, source(), input), error => safeFresh(error, issued));
  assert.equal(traps, 1); assert.equal(saves, 0); assert.equal(f.sent.length, 0); assert.equal(f.httpCalls.length, 2);
});

test('a previously issued mutable job error thrown by an options field-descriptor trap has no stale checkpoint authority', async t => {
  const f = await desktopFeedFixture(t), issued = await issuedError(f); let saves = 0, traps = 0;
  const input = new Proxy(options(() => { saves++; }), {
    getOwnPropertyDescriptor(target, field) { if (field === 'wrappingKey') { traps++; throw issued; }
      return Reflect.getOwnPropertyDescriptor(target, field); },
  });
  await assert.rejects(createPcPhoneBackup(f.connection, f.feed, source(), input), error => safeFresh(error, issued));
  assert.equal(traps, 1); assert.equal(saves, 0); assert.equal(f.sent.length, 0); assert.equal(f.httpCalls.length, 2);
});

test('a current owned prepare failure still carries its actual encrypted journal through complete create', async t => {
  const f = await desktopFeedFixture(t); let saves = 0;
  await assert.rejects(createPcPhoneBackup(f.connection, f.feed, source(), options(() => {
    saves++; throw Error('private-current-checkpoint-callback');
  })), error => {
    assert.ok(error instanceof PcPhoneBackupJobError); assert.equal(error.code, 'checkpoint-failed');
    assert.equal(error.stage, 'checkpoint'); assert.equal(error.submitted, false); assert.equal(error.outcomeUnknown, false);
    assert.equal(error.acceptedChunks, 0); assert.equal(error.sessionAllocated, false); assert.equal(error.providerCode, undefined);
    const state = openPcPhoneBackupCheckpoint(error.getCheckpoint(), key());
    assert.equal(state.phase, 'creating'); assert.equal(state.sourceRevision, 'synthetic-error-provenance-v1');
    assert.equal(Object.hasOwn(error, 'cause'), false); assert.doesNotMatch(String(error), /private-current/);
    return true;
  });
  assert.equal(saves, 1); assert.equal(f.sent.length, 0); assert.equal(f.httpCalls.length, 2);
});
