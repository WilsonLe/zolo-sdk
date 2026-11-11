import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPcPhoneBackupArchive, pcPhoneBackupArchiveState, restorePcPhoneBackupArchive } from '../dist/pc-phone-backup-archive.js';
import { preparePcPhoneBackupMessageBatch } from '../dist/pc-phone-backup-encoding.js';

async function prepared(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zalo-backup-filetype-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'archive.bin');
  const batch = preparePcPhoneBackupMessageBatch({ partitionId: '2', localUserId: '1',
    messages: [{ fromUid: '1', msgId: '3', cliMsgId: '4', message: 'synthetic-filetype-control' }],
  }).encode({ users: { 1: 'SELF', 2: 'PEER' }, groups: {} });
  const archive = await createPcPhoneBackupArchive({ filePath, serverKey: Buffer.alloc(32, 0x11),
    clientSalt: Buffer.alloc(32, 0x22), batches: { async *[Symbol.asyncIterator]() { yield batch; } },
  });
  const state = pcPhoneBackupArchiveState(archive); archive.close();
  return { directory, filePath, state };
}

// This child executes only the authored SDK restore on a synthetic archive state.
// No target app/WASM, account files, network, or subprocesses are used by it.
const childScript = `
import { restorePcPhoneBackupArchive, PcPhoneBackupArchiveError } from ${JSON.stringify(new URL('../dist/pc-phone-backup-archive.js', import.meta.url).href)};
const allowed = new Set(['invalid-input', 'invalid-batch', 'invalid-state', 'limit-exceeded', 'file-exists',
  'file-invalid', 'file-changed', 'io-failed', 'source-failed', 'compression-unavailable', 'compression-failed',
  'crypto-failed', 'aborted', 'closed']);
let archive;
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 16384) throw 0; chunks.push(chunk); }
  const state = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const controller = new AbortController();
  process.stdout.write(JSON.stringify({ phase: 'started' }) + '\\n');
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    archive = await restorePcPhoneBackupArchive(state, controller.signal);
    process.stdout.write(JSON.stringify({ phase: 'complete', kind: 'restored' }) + '\\n');
  } catch (error) {
    const code = error instanceof PcPhoneBackupArchiveError && allowed.has(error.code) ? error.code : 'other';
    process.stdout.write(JSON.stringify({ phase: 'complete', kind: 'error', code }) + '\\n');
  } finally { clearTimeout(timer); }
} catch { process.stdout.write(JSON.stringify({ phase: 'setup-failed' }) + '\\n'); }
finally { archive?.close(); }
`;

function boundedRestore(state) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      env: { PATH: '/usr/bin:/bin', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderrBytes = 0, timedOut = false, spawnFailed = false, oversized = false, exited = false;
    const kill = () => { if (!exited) child.kill('SIGKILL'); };
    // A blocking FIFO open cannot hold the root test runner indefinitely.
    const timer = setTimeout(() => { timedOut = true; kill(); }, 1000);
    child.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > 4096) { oversized = true; kill(); return; }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 4096) kill(); });
    child.on('error', () => { spawnFailed = true; kill(); });
    child.stdin.on('error', () => { /* A terminated child may close its input first. */ });
    child.on('close', (exitCode, signal) => {
      exited = true; clearTimeout(timer);
      let records = [];
      try { records = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch {}
      resolve({ timedOut, spawnFailed, oversized, stderrBytes, exitCode, signal, records });
    });
    child.stdin.end(JSON.stringify(state));
  });
}

test('an unchanged private regular archive remains restorable and readable', async t => {
  const f = await prepared(t), archive = await restorePcPhoneBackupArchive(f.state);
  t.after(() => archive.close());
  await archive.verify();
  const chunk = await archive.readChunk(1);
  assert.equal(chunk.length, archive.metadata.sizeBytes);
  assert.equal(archive.metadata.messageCount, 1);
  assert.equal((await lstat(f.filePath)).isFile(), true);
});

test('an unwritten FIFO replacing the prepared leaf is rejected without blocking restore or abort',
  { skip: process.platform === 'win32' }, async t => {
    const f = await prepared(t);
    await rename(f.filePath, join(f.directory, 'original-archive.bin'));
    // Fixed POSIX system utility, owned fresh temporary leaf; no shell expansion.
    await new Promise((resolve, reject) => execFile('/usr/bin/mkfifo', ['-m', '600', f.filePath], { timeout: 500 },
      error => error ? reject(new Error('Synthetic FIFO setup failed.')) : resolve()));
    await chmod(f.filePath, 0o600);
    assert.equal((await lstat(f.filePath)).isFIFO(), true);
    const result = await boundedRestore(f.state);
    assert.equal(result.spawnFailed, false); assert.equal(result.oversized, false); assert.equal(result.stderrBytes, 0);
    assert.equal(result.records[0]?.phase, 'started', 'The child must reach the SDK restore boundary.');
    assert.equal(result.timedOut, false, 'Restore must reject the FIFO before the bounded child watchdog kills a blocking open.');
    assert.equal(result.exitCode, 0); assert.equal(result.signal, null);
    const completion = result.records.find(row => row.phase === 'complete');
    assert.equal(completion?.kind, 'error');
    assert.ok(['file-invalid', 'file-changed'].includes(completion.code), 'A nonregular leaf must be a fixed file-type rejection.');
  });
