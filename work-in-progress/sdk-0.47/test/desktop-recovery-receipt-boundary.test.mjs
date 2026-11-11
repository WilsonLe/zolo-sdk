import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { E2EE, WK, PURPOSE, attach, canonical, fence, hash, initRow, initial, peer, peerInput, recoveryJournal, serve, transportFixture } from './fixtures/desktop-recovery.mjs';

// Boundary fixture: seed the documented ciphertext-only file format, not 65k fsyncs.
// The retained receipt count/revision and linked fences match a natural initialized
// history. Only this bounded private file-format test constructs old history.
function sealSections(journal, metadata) {
  const chunks = [Buffer.from('ZDR1')];
  for (const name of ['metadata', 'device', 'bank', 'intake', 'results', 'outbox']) {
    const bytes = name === 'metadata' ? Buffer.from(canonical(metadata)) : journal.sections[name];
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); chunks.push(length, bytes);
  }
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', WK, nonce);
  cipher.setAAD(Buffer.from(PURPOSE));
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat(chunks)), cipher.final()]);
  return PURPOSE + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

async function seedNearCapacity(path, saved, count) {
  const journal = recoveryJournal(saved.recoveryCheckpoint), m = structuredClone(journal.metadata);
  const deviceFence = { deviceRevision: m.deviceRevision, deviceCheckpointSha256: hash(saved.deviceCheckpoint) };
  let previous = { ...deviceFence, recoveryRevision: null, recoveryCheckpointSha256: null };
  const receipts = [];
  for (let i = 0; i < count - 1; i++) {
    const next = { ...deviceFence, recoveryRevision: i, recoveryCheckpointSha256: hash('synthetic bounded receipt ' + i) };
    receipts.push({ kind: 'committed', transactionId: (i + 1).toString(16).padStart(32, '0'),
      payloadSha256: hash('synthetic historical body ' + i), expected: previous, next });
    previous = next;
  }
  const transactionId = count.toString(16).padStart(32, '0');
  m.revision = count - 1; m.lastTransaction = { transactionId, kind: 'consumer-ack', expected: previous };
  const current = { deviceCheckpoint: saved.deviceCheckpoint, recoveryCheckpoint: sealSections(journal, m) };
  const body = { transactionId, kind: 'consumer-ack', expected: previous, next: current };
  receipts.push({ kind: 'committed', transactionId, payloadSha256: hash(canonical(body)), expected: previous, next: fence(current) });
  assert.equal(receipts.length, count); assert.equal(fence(current).recoveryRevision + 1, count);
  await writeFile(path, canonical({ format: 'desktop-e2ee-recovery-store.v1', current, fence: fence(current), receipts }), { mode: 0o600 });
}

for (const [command, seededReceipts, uid] of [
  [545, 65534, '9300000000000000987'], [544, 65534, '9300000000000000988'],
  [545, 65531, '9300000000000000989'], [544, 65531, '9300000000000000990'],
]) test('044 first-party receipt capacity for '+command+' after '+seededReceipts+' existing receipts', { timeout: 90000 }, async t => {
  const f = await transportFixture(t, { uid, queues: [{ cmd: 516, subCmd: 0 }] });
  const remote = command === 544 ? peer() : undefined;
  const owner = await attach(f, remote ? [peerInput(remote)] : []);
  const row = remote ? initRow(initial(f, remote).frame, { recipient: f.uid })
    : initRow(undefined, { recipient: f.uid, cmd: 544, id: '101', type: 0 });
  serve(f, { 516: [{ rows: [row] }] });
  await owner.collect(); await owner.process();
  const prepared = await owner.readOutbox();
  assert.equal(prepared[0].command, command);
  const snapshot = await owner.checkpoint(); await owner.dispose(); await owner.closed;
  const path = join(f.directory, 'bounded-first-party.json');
  // Attach adds its documented restart terminal receipt.
  await seedNearCapacity(path, snapshot, seededReceipts);
  const store = new E2EE.FileDesktopE2eeRecoveryStore(path);
  const restored = await attach(f, remote ? [peerInput(remote)] : [], { store });
  assert.equal(restored.metadata.recoveryRevision, seededReceipts);
  assert.equal((await restored.readOutbox())[0].status, 'prepared');
  const before = f.sent.filter(row => row.cmd === 544 || row.cmd === 545).length;
  if (seededReceipts === 65534) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(restored.dispatch({ maxControls: 1 }), error => error.code === 'limit-exceeded');
      assert.equal(f.sent.filter(row => row.cmd === 544 || row.cmd === 545).length, before);
      assert.equal((await restored.readOutbox())[0].status, 'prepared');
    }
  } else {
    const dispatched = await restored.dispatch({ maxControls: 1 });
    assert.equal(dispatched.attempted, 1); assert.equal(dispatched.acknowledged, 1);
    assert.equal((await restored.readOutbox())[0].status, 'acknowledged');
    assert.equal(f.sent.filter(row => row.cmd === 544 || row.cmd === 545).length, before + 1);
    const file = JSON.parse(await readFile(path, 'utf8')), last = file.receipts.at(-1);
    assert.equal(file.receipts.length, seededReceipts + 3);
    assert.deepEqual(await store.lookup(last.transactionId), last);
    assert.deepEqual(await store.lookup(last.transactionId), last);
    if (command === 544) await assert.rejects(restored.dispatch(), error => error.code === 'limit-exceeded');
    else assert.equal((await restored.dispatch()).attempted, 0);
    assert.equal(f.sent.filter(row => row.cmd === 544 || row.cmd === 545).length, before + 1);
  }
  assert.equal(restored.metadata.phase, 'ready');
});
