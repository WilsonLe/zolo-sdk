import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openHistoryArchive } from '../dist/history-archive.js';

const thread = '9320000000000000001';
const group = 'g9320000000000000002';
const nestedId = '9123456789012345678';
const schema = `
  CREATE TABLE message (
    msgId TEXT PRIMARY KEY, cliMsgId TEXT, toUid TEXT, msgType INTEGER, sendDttm TEXT,
    message TEXT, fromUid TEXT, quote TEXT, mentions TEXT, e2eeStatus INTEGER, ev INTEGER
  );
  CREATE UNIQUE INDEX Message_userId_sendDttm_msgId ON message (toUid, sendDttm, msgId);
`;

async function fixture(t, name = 'message #1?.sqlite') {
  const directory = await mkdtemp(join(tmpdir(), 'zalo-sdk-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, name);
}

function createArchive(path, setup) {
  const db = new DatabaseSync(path);
  try {
    db.exec(schema);
    setup(db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'));
  } finally { db.close(); }
}

function row(insert, {
  id, to = thread, time = '1793870000000', value = 'hello', cli = '923', sender = thread,
  quote = null, mentions = null, e2eeStatus = null, version = null,
}) {
  insert.run(id, cli, to, 1, time, JSON.stringify(value), sender, quote, mentions, e2eeStatus, version);
}

const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

test('pages a supplied snapshot with exact indexed ordering and preserves nested IDs without writing to the source', async (t) => {
  const path = await fixture(t);
  createArchive(path, (insert) => {
    row(insert, { id: '9', value: { kind: 'attachment', msgId: JSON.rawJSON(nestedId) }, quote: `{"globalMsgId":${nestedId}}` });
    row(insert, { id: '10', value: 'same timestamp', cli: '', sender: '' });
    row(insert, { id: '.local-1', time: '1793860000000', value: 'oldest' });
    row(insert, { id: '11', to: group, value: 'group message' });
  });
  const before = await digest(path);
  const archive = await openHistoryArchive(path);
  t.after(() => archive.close());
  const first = archive.readConversation(thread, { limit: 1 });
  assert.deepEqual(first, {
    messages: [{
      threadId: thread, sendDttm: '1793870000000', msgId: '9', msgType: 1, cliMsgId: '923',
      fromUid: thread, message: { kind: 'attachment', msgId: nestedId }, quote: { globalMsgId: nestedId },
    }],
    nextCursor: { threadId: thread, sendDttm: '1793870000000', msgId: '9' },
  });
  const second = archive.readConversation(thread, { before: first.nextCursor, limit: 1 });
  assert.equal(second.messages[0].msgId, '10');
  assert.equal(second.messages[0].cliMsgId, '');
  const last = archive.readConversation(thread, { before: second.nextCursor, limit: 1 });
  assert.equal(last.messages[0].msgId, '.local-1');
  assert.equal(last.nextCursor, undefined);
  assert.deepEqual(archive.readConversation(group).messages.map(({ message }) => message), ['group message']);
  assert.throws(() => archive.readConversation(group, { before: first.nextCursor }), /cursor returned for this thread/);
  archive.close();
  assert.throws(() => archive.readConversation(thread), { code: 'archive-closed' });
  assert.equal(await digest(path), before);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await assert.rejects(lstat(path + suffix), { code: 'ENOENT' });
  }
});

test('only decodes version 0 field encoding with an explicit key', async (t) => {
  const path = await fixture(t);
  const fieldKey = 'synthetic 🔑';
  const plaintext = `{"text":"xin chào 👋","msgId":${nestedId}}`;
  const obfuscated = plaintext.split('').map((char, index) =>
    String.fromCharCode(char.charCodeAt(0) ^ fieldKey.charCodeAt(index % fieldKey.length))).join('');
  createArchive(path, (insert) => {
    row(insert, { id: '8', value: obfuscated, version: 0, e2eeStatus: 2 });
    row(insert, { id: '7', value: 'decoded export row' });
    row(insert, { id: '9', to: group, value: 'unsupported', version: 1 });
  });
  const defaultArchive = await openHistoryArchive(path);
  const wrongArchive = await openHistoryArchive(path, { messageEncoding: { kind: 'legacy-xor', key: 'different key' } });
  const archive = await openHistoryArchive(path, { messageEncoding: { kind: 'legacy-xor', key: fieldKey } });
  t.after(() => { archive.close(); wrongArchive.close(); defaultArchive.close(); });
  assert.throws(() => defaultArchive.readConversation(thread), { code: 'field-key-required' });
  assert.throws(() => wrongArchive.readConversation(thread), { code: 'invalid-record' });
  assert.deepEqual(archive.readConversation(thread).messages[0].message, { text: 'xin chào 👋', msgId: nestedId });
  assert.equal(archive.readConversation(thread).messages[1].message, 'decoded export row');
  assert.equal(archive.readConversation(thread).messages[0].e2eeStatus, 2);
  assert.throws(() => archive.readConversation(group), { code: 'unsupported-field-encoding' });
});

test('requires a standalone file and the expected message table without executing a view', async (t) => {
  const path = await fixture(t);
  createArchive(path, () => {});
  await writeFile(path + '-wal', 'sidecar');
  await assert.rejects(openHistoryArchive(path), { code: 'snapshot-required' });
  await rm(path + '-wal');
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE message; CREATE VIEW message AS SELECT 1;');
  db.close();
  await assert.rejects(openHistoryArchive(path), { code: 'unsupported-schema' });
  await writeFile(path, Buffer.alloc(100, 0xA5));
  await assert.rejects(openHistoryArchive(path), { code: 'unsupported-format' });
});

test('importing the archive module does not initialize node:sqlite', () => {
  const moduleUrl = new URL('../dist/history-archive.js', import.meta.url);
  const result = spawnSync(process.execPath, [
    '--trace-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl.href)})`,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
});
