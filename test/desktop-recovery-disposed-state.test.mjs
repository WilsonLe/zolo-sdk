import assert from 'node:assert/strict';
import test from 'node:test';
import { SDK, attach, fixed, transportFixture } from './fixtures/desktop-recovery.mjs';

for(const [inputLoss,uid] of [[false,'9300000000000000995'],[true,'9300000000000000996']])
test('044 disposed public failures preserve a restorable frozen recovery snapshot: inputLoss='+inputLoss,async t=>{
  const f=await transportFixture(t,{uid,queues:[{cmd:516,subCmd:0},{cmd:510,subCmd:1}]}),owner=await attach(f);
  let fail=true,first;f.store.hooks.beforeCommit=tx=>{if(tx.kind==='consumer-ack'&&fail){fail=false;throw Error('synthetic write rejection');}};
  await assert.rejects(owner.acknowledgeResults([]),error=>{first=error.recoveryState();return fixed('persistence-required')(error);});
  let retained=first;
  if(inputLoss){let deep={};for(let i=0;i<48;i++)deep={next:deep};f.emit(549,deep,1);
    await assert.rejects(owner.dispose(),error=>{retained=error.recoveryState();return fixed('persistence-required')(error);});}
  else await owner.dispose();
  await owner.closed;
  assert.equal(typeof retained.resumeCheckpoint,inputLoss?'string':'undefined');
  f.hooks.socket=request=>f.emit(510,{error_code:0,data:{reqId:request.data.reqId,resetLastActionId:'999'}},1);
  assert.equal((await SDK.requestChatOfflinePage(f.feed,{cmd:510,subCmd:1})).resetActionId,'999');
  const before={writes:f.store.attempts.length,loads:f.store.loads,sent:f.sent.length};
  for(const operation of [()=>owner.repair(),()=>owner.readResults(),()=>owner.readBlocked(),()=>owner.readOutbox(),()=>owner.checkpoint(),
    ()=>owner.collect(),()=>owner.process(),()=>owner.dispatch(),()=>owner.acknowledgeResults([]),()=>owner.admitPeers([])]){
    await assert.rejects(operation(),error=>{const state=error.recoveryState();
      assert.equal(state.resumeCheckpoint===retained.resumeCheckpoint,true,'closed recovery must not seal a new resume');
      assert.equal(state.transaction.next.recoveryCheckpoint===retained.transaction.next.recoveryCheckpoint,true);
      assert.equal(state.transaction.payloadSha256,retained.transaction.payloadSha256);
      return fixed('disposed')(error);});
  }
  assert.equal(owner.metadata.phase,'closed');assert.equal(f.store.attempts.length,before.writes);assert.equal(f.store.loads,before.loads);assert.equal(f.sent.length,before.sent);
  const restored=await attach(f,[],{recoveryCheckpoint:retained.resumeCheckpoint??retained.transaction.next.recoveryCheckpoint});
  assert.equal(restored.metadata.phase,inputLoss?'reconciliation-required':'idle');
  assert.equal((await restored.process()).accepted,0);assert.deepEqual(await restored.readResults(),[]);assert.deepEqual(await restored.readOutbox(),[]);
  assert.equal(f.sent.length,before.sent);
});
