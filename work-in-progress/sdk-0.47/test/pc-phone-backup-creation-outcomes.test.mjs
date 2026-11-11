import assert from 'node:assert/strict';
import test from 'node:test';
import { createPcPhoneBackupSession, pcPhoneBackupCreationFailure, PcPhoneBackupCreationError } from '../dist/pc-phone-backup.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

test('only actual private creation outcomes classify provider origin, regardless of public error mutation', async t => {
  const f = await desktopFeedFixture(t);
  f.onSend(request => f.emit(631, { error_code: 0, data: { reqId: request.data.reqId, err: 212 } }));
  let actual;
  await assert.rejects(createPcPhoneBackupSession(f.connection, f.feed), error => { actual = error; return true; });
  const expected = { code: 'rejected', operation: 'create-session', submitted: true, outcomeUnknown: false, providerCode: 212 };
  assert.deepEqual(pcPhoneBackupCreationFailure(actual), expected);
  actual.code = 'submission-unknown'; actual.providerCode = 999; actual.submitted = false;
  assert.deepEqual(pcPhoneBackupCreationFailure(actual), expected);
  assert.ok(Object.isFrozen(pcPhoneBackupCreationFailure(actual)));
  assert.equal(pcPhoneBackupCreationFailure(new PcPhoneBackupCreationError('rejected', 'create-session', true, false, 212)), undefined);
});

test('a caller error or proxy cannot publish private creation metadata through property or prototype traps', () => {
  let reads = 0;
  const forged = new Proxy(new PcPhoneBackupCreationError('rejected', 'initialize', true, false, 212), {
    get() { reads++; throw Error('private-outcome-property'); },
    getPrototypeOf() { reads++; throw Error('private-outcome-prototype'); },
    getOwnPropertyDescriptor() { reads++; throw Error('private-outcome-descriptor'); },
  });
  for (const error of [forged, null, undefined, 7, 'private-error', {}, () => undefined]) {
    assert.equal(pcPhoneBackupCreationFailure(error), undefined);
  }
  assert.equal(reads, 0);
});
