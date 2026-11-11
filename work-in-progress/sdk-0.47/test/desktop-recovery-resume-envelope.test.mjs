import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { WK, attach, hash, safeError, transportFixture } from './fixtures/desktop-recovery.mjs';

// Independent standard-crypto malformed payloads exercise the closed resume format.
const purpose='zalo-e2ee-desktop-recovery-resume.v1.';
function suffix(checkpoint,mask,{length=33,digest=hash(checkpoint)}={}){
  const body=Buffer.alloc(length);Buffer.from(digest,'hex').copy(body);if(length>32)body[32]=mask;
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',WK,nonce);cipher.setAAD(Buffer.from(purpose));
  const encrypted=Buffer.concat([cipher.update(body),cipher.final()]);
  return checkpoint+'~'+purpose+Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');
}
test('044 opaque resume binds the exact candidate, fixed payload and closed cause mask before acquiring a claim',async t=>{
  const f=await transportFixture(t,{uid:'9300000000000000991',queues:[]}),owner=await attach(f);
  let fail=true;f.store.hooks.beforeCommit=tx=>{if(tx.kind==='consumer-ack'&&fail){fail=false;throw Error('synthetic write failure');}};
  await assert.rejects(owner.acknowledgeResults([]),error=>{safeError(error);return error.code==='persistence-required';});
  let deep={};for(let i=0;i<48;i++)deep={next:deep};f.emit(549,deep,1);
  let state;await assert.rejects(owner.dispose(),error=>{state=error.recoveryState();safeError(error);return error.code==='persistence-required';});await owner.closed;
  const checkpoint=state.transaction.next.recoveryCheckpoint,before=f.store.attempts.length;
  for(const value of [suffix(checkpoint,0),suffix(checkpoint,4),suffix(checkpoint,1,{length:32}),suffix(checkpoint,1,{length:34}),
    suffix(checkpoint,1,{digest:'f'.repeat(64)}),state.resumeCheckpoint+'~x',checkpoint+'~',checkpoint+'~'+purpose+'A'.repeat(256)]){
    await assert.rejects(attach(f,[],{recoveryCheckpoint:value}),error=>{safeError(error);return error.code==='invalid-state';});
    assert.equal(f.store.attempts.length,before);assert.equal(f.sent.length,0);
  }
  const restored=await attach(f,[],{recoveryCheckpoint:state.resumeCheckpoint});
  assert.equal(restored.metadata.phase,'reconciliation-required');assert.equal((await restored.process()).accepted,0);assert.equal(f.sent.length,0);
});
