import assert from 'node:assert/strict';
import test from 'node:test';
import { initializePcPhoneBackup, PcPhoneBackupCreationError } from '../dist/index.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

for (const [label, suffix] of [['LF', '\n'], ['CR', '\r'], ['CRLF', '\r\n'], ['line separator', '\u2028'], ['paragraph separator', '\u2029']]) {
  test(`init refuses a checksum with trailing ${label} before any application handoff`, async t => {
    const f = await desktopFeedFixture(t);
    f.onSend(request => f.emit(630, { error_code: 0, data: { reqId: request.data.reqId, err: 0, bkid: 'fixture-initialized' } }));
    const fields = { bkid: 'fixture-created', clientSalt: Buffer.alloc(32, 0x22).toString('base64'), deviceName: 'Fixture',
      sizeBytes: 31, originalSizeBytes: 2, messageCount: 1, threadCount: 1, checksum: 'a'.repeat(64) + suffix };
    await assert.rejects(initializePcPhoneBackup(f.connection, f.feed, fields, { timeoutMs: 100 }),
      error => error instanceof PcPhoneBackupCreationError && error.code === 'invalid-input'
        && error.submitted === false && error.outcomeUnknown === false);
    assert.equal(f.sent.length, 0);
    fields.checksum = 'a'.repeat(64);
    assert.equal((await initializePcPhoneBackup(f.connection, f.feed, fields)).bkid, 'fixture-initialized');
    assert.equal(f.sent.length, 1);
  });
}
