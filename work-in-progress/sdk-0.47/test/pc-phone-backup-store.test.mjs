import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, lstat, chmod, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePcPhoneBackupCheckpointStore } from '../dist/pc-phone-backup-store.js';
import { sealPcPhoneBackupCheckpoint, openPcPhoneBackupCheckpoint } from '../dist/pc-phone-backup-checkpoint.js';

const key = Buffer.alloc(32, 0x31);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zalo-backup-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'state'), state: { version: 1, phase: 'creating', ownerBinding: 'a'.repeat(64),
    sourceRevision: 'revision-1', deviceName: 'Fixture', filePath: join(dir, 'archive.bin'), onUnmappable: 'error',
    chunkSize: 3145728, createdAtMilliseconds: 1, clientSalt: Buffer.alloc(32, 0x22).toString('base64') } };
}
const privateError = error => { assert.doesNotMatch(String(error), /private-store-secret|zalo-backup-store-|desktop-token/); assert.equal(Object.hasOwn(error, 'cause'), false); return true; };

test('actual encrypted checkpoints survive atomic save/load in private files and keep the wrapping key separate', async t => {
  const f = await fixture(t); const store = new FilePcPhoneBackupCheckpointStore(f.path);
  assert.equal(await store.load(), null);
  const encrypted = sealPcPhoneBackupCheckpoint(f.state, key); await store.save(encrypted);
  assert.equal(await store.load(), encrypted);
  assert.equal(openPcPhoneBackupCheckpoint(await store.load(), key).sourceRevision, 'revision-1');
  assert.doesNotMatch(await readFile(f.path, 'utf8'), /revision-1|clientSalt|ownerBinding|IiIiIi/);
  if (process.platform !== 'win32') assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
});

test('separate store instances read a complete committed ciphertext without source/account operations', async t => {
  const f = await fixture(t); const writer = new FilePcPhoneBackupCheckpointStore(f.path);
  const next = sealPcPhoneBackupCheckpoint({ ...f.state, sourceRevision: 'restart' }, key);
  await writer.save(next);
  const reader = new FilePcPhoneBackupCheckpointStore(f.path);
  assert.equal(openPcPhoneBackupCheckpoint(await reader.load(), key).sourceRevision, 'restart');
});

test('same-instance concurrent saves serialize and commit complete ciphertext in call order', async t => {
  const f = await fixture(t); const store = new FilePcPhoneBackupCheckpointStore(f.path);
  const values = Array.from({ length: 8 }, (_, i) => sealPcPhoneBackupCheckpoint({ ...f.state, sourceRevision: `r${i}` }, key));
  await Promise.all(values.map(value => store.save(value)));
  assert.equal(await store.load(), values.at(-1)); assert.equal(openPcPhoneBackupCheckpoint(await store.load(), key).sourceRevision, 'r7');
});

test('another private-file purpose is neither overwritten nor cleared', async t => {
  const f = await fixture(t); const store = new FilePcPhoneBackupCheckpointStore(f.path);
  const original = '{"desktop-token":"private-store-secret"}'; await writeFile(f.path, original, { mode: 0o600 });
  await assert.rejects(store.save(sealPcPhoneBackupCheckpoint(f.state, key)), privateError);
  await assert.rejects(store.clear(), privateError); assert.equal(await readFile(f.path, 'utf8'), original);
});

test('malformed envelopes cannot create or replace a store and explicit clear removes only a valid-purpose file', async t => {
  const f = await fixture(t); const store = new FilePcPhoneBackupCheckpointStore(f.path);
  for (const value of ['', null, {}, 'private-store-secret', 'zalo-pc-phone-backup.v1.AAAA\n']) await assert.rejects(store.save(value), privateError);
  assert.equal(await store.load(), null);
  await store.save(sealPcPhoneBackupCheckpoint(f.state, key)); await store.clear(); assert.equal(await store.load(), null);
  await store.clear();
});

test('symlink and hardlinked checkpoint paths are refused without touching the source file', async t => {
  const f = await fixture(t); const target = join(f.dir, 'target'); const content = sealPcPhoneBackupCheckpoint(f.state, key);
  await writeFile(target, content, { mode: 0o600 }); await symlink(target, f.path);
  const store = new FilePcPhoneBackupCheckpointStore(f.path);
  await assert.rejects(store.load(), privateError); await assert.rejects(store.save(content), privateError); await assert.rejects(store.clear(), privateError);
  assert.equal(await readFile(target, 'utf8'), content); await rm(f.path); await link(target, f.path);
  await assert.rejects(store.load(), privateError); await assert.rejects(store.clear(), privateError); assert.equal(await readFile(target, 'utf8'), content);
});

test('permission and size bounds reject before loading an unbounded ciphertext file', async t => {
  const f = await fixture(t); const store = new FilePcPhoneBackupCheckpointStore(f.path);
  const content = sealPcPhoneBackupCheckpoint(f.state, key); await writeFile(f.path, content, { mode: 0o600 });
  if (process.platform !== 'win32') { await chmod(f.path, 0o644); await assert.rejects(store.load(), privateError); await chmod(f.path, 0o600); }
  await writeFile(f.path, 'A'.repeat(23 * 1024 * 1024)); await assert.rejects(store.load(), privateError);
});

test('new parent directories are private and existing unrelated directory content remains intact', async t => {
  const f = await fixture(t), parent = join(f.dir, 'new', 'nested'); const store = new FilePcPhoneBackupCheckpointStore(join(parent, 'state'));
  await mkdir(join(f.dir, 'unrelated')); await writeFile(join(f.dir, 'unrelated', 'kept'), 'kept');
  await store.save(sealPcPhoneBackupCheckpoint(f.state, key));
  assert.equal(await readFile(join(f.dir, 'unrelated', 'kept'), 'utf8'), 'kept');
  if (process.platform !== 'win32') assert.equal((await lstat(parent)).mode & 0o777, 0o700);
});
