import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { uploadPcPhoneBackupChunk } from '../dist/pc-phone-backup-upload.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

test('nonzero signed-safe provider backup IDs reach the exact multipart contract without conversion', async t => {
  const calls = [];
  const f = await desktopFeedFixture(t, { startFeed: false, async onHttpRequest(raw, init, { key }) {
    assert.equal(new URL(raw).pathname, '/api/backuppc2mb/upload'); assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error'); assert(init.body instanceof ArrayBuffer);
    const form = await new Response(init.body, { headers: init.headers }).formData();
    const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
    const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(form.get('param'), 'base64')), decipher.final()]).toString('utf8'));
    assert.deepEqual(JSON.parse(params.batch_data), { last: 1, chunk_id: 1, total_chunk: 1, size: 3 });
    assert.deepEqual(Buffer.from(await form.get('file_data').arrayBuffer()), Buffer.from([1, 2, 3]));
    calls.push(params.bkid); return Response.json({ error_code: 0 });
  } });
  f.api.zpwServiceMap.backuppcmobile = ['https://backup.fixture.zalo.me'];
  for (const bkid of [17, -17, -9, -Number.MAX_SAFE_INTEGER, 'opaque-backup==']) {
    const result = await uploadPcPhoneBackupChunk(f.connection, { bkid, chunkId: 1, totalChunks: 1, wholeFileBytes: 3, bytes: Uint8Array.of(1, 2, 3) });
    assert.equal(result.acknowledged, true); assert.equal(result.outcomeUnknown, false); assert.equal(calls.at(-1), bkid);
  }
  assert.deepEqual(calls, [17, -17, -9, -Number.MAX_SAFE_INTEGER, 'opaque-backup==']);
  assert.equal(f.sent.length, 0);
});
