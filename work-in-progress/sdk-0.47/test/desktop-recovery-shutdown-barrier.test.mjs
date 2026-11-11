import assert from 'node:assert/strict';
import test from 'node:test';
import { SDK, attach, fixed, gate, initial, initRow, peer, peerInput, recoveryJournal, serve, transportFixture } from './fixtures/desktop-recovery.mjs';

function loss(f) { let value={sentinel:true};for(let i=0;i<48;i++)value={next:value};f.emit(549,value,1); }
async function reset(f) {
  f.hooks.socket=request=>{assert.equal(request.cmd,510);f.emit(510,{error_code:0,data:{reqId:request.data.reqId,resetLastActionId:'999'}},1);};
  assert.equal((await SDK.requestChatOfflinePage(f.feed,{cmd:510,subCmd:1})).resetActionId,'999');
}
async function pending(promise) { let failure;await assert.rejects(promise,error=>{failure=error;return fixed('persistence-required')(error);});return failure; }

test('044 a persistence error snapshots an already qualified reset before retaining its resume value',async t=>{
  const f=await transportFixture(t,{uid:'9300000000000000980',queues:[{cmd:510,subCmd:1}]}),owner=await attach(f);
  let reject=true;f.store.hooks.beforeCommit=tx=>{if(tx.kind==='consumer-ack'&&reject){reject=false;throw Error('synthetic local write rejection');}};
  const original=(await pending(owner.acknowledgeResults([]))).recoveryState().transaction;
  f.store.hooks.beforeLookup=async()=>{await reset(f);throw Error('synthetic receipt service rejection after reset');};
  const failure=await pending(owner.repair()),state=failure.recoveryState();f.store.hooks.beforeLookup=undefined;
  assert.deepEqual(state.transaction,original);assert.equal(typeof state.resumeCheckpoint,'string');
  const shutdown=await pending(owner.dispose());await owner.closed;
  assert.equal(shutdown.recoveryState().resumeCheckpoint,state.resumeCheckpoint);
  const restored=await attach(f,[],{recoveryCheckpoint:state.resumeCheckpoint});
  assert.equal(restored.metadata.phase,'reconciliation-required');assert.equal((await restored.process()).accepted,0);assert.equal((await restored.dispatch()).attempted,0);
  assert.equal(f.sent.filter(tx=>tx.cmd===544||tx.cmd===545).length,0);
});

test('044 concurrent disposal shares one quiescent barrier write and closes only after its confirmation',async t=>{
  const f=await transportFixture(t,{uid:'9300000000000000981',queues:[]}),owner=await attach(f),entered=gate(),release=gate();
  f.hooks.releases.push(release);
  let writes=0;f.store.hooks.beforeCommit=async tx=>{if(tx.kind==='terminal'){writes++;entered.resolve();await release.promise;}};
  loss(f);let closed=false;void owner.closed.then(()=>{closed=true;});
  const first=owner.dispose(),second=owner.dispose();assert.equal(first,second);await entered.promise;
  assert.equal(writes,1);assert.equal(closed,false);release.resolve();await Promise.all([first,second]);await owner.closed;
  assert.equal(closed,true);assert.equal(writes,1);
  const next=await attach(f);assert.equal(next.metadata.phase,'reconciliation-required');
  assert.equal((await next.process()).accepted,0);assert.equal(f.sent.length,0);
});

test('044 terminal barrier persistence failure retains an exact recoverable shutdown candidate',async t=>{
  const f=await transportFixture(t,{uid:'9300000000000000982',queues:[]}),owner=await attach(f);
  let reject=true;f.store.hooks.beforeCommit=tx=>{if(tx.kind==='terminal'&&reject){reject=false;throw Error('synthetic terminal persistence failure');}};
  loss(f);const failure=await pending(owner.dispose());await owner.closed;const state=failure.recoveryState();
  assert.equal(state.transaction.kind,'terminal');assert.equal(state.resumeCheckpoint,undefined);
  const restored=await attach(f,[],{recoveryCheckpoint:state.transaction.next.recoveryCheckpoint});
  assert.equal(restored.metadata.phase,'reconciliation-required');assert.equal(restored.metadata.continuityUnproven,true);
  const attempts=f.store.attempts.filter(tx=>tx.transactionId===state.transaction.transactionId);assert.equal(attempts.length,2);assert.deepEqual(attempts[0],attempts[1]);
  assert.equal((await restored.process()).accepted,0);assert.equal(f.sent.length,0);
});

test('044 intake queued before disposal cannot silently lose its continuity obligation',async t=>{
  const f=await transportFixture(t,{uid:'9300000000000000983',queues:[]}),owner=await attach(f);
  f.emit(549,{error_code:0,data:{eesession:[initRow(undefined,{cmd:544,recipient:f.uid,type:0})]}},1);
  await owner.dispose();await owner.closed;const restored=await attach(f);
  assert.equal(restored.metadata.phase,'reconciliation-required');assert.equal(restored.metadata.continuityUnproven,true);
  assert.equal((await restored.process()).accepted,0);assert.equal((await restored.dispatch()).attempted,0);assert.equal(f.sent.length,0);
});

for(const [mode,uid] of [['fresh-store-device','9300000000000000984'],['retained-staged-device','9300000000000000985']])
test('044 key-consuming exact candidate and late barriers restore with '+mode,async t=>{
  const f=await transportFixture(t,{uid,queues:[{cmd:516,subCmd:0},{cmd:510,subCmd:1}]}),remote=peer();
  const offered=initial(f,remote),owner=await attach(f,[peerInput(remote)]),keys=f.device.metadata.remainingOneTimePreKeys;
  serve(f,{516:[{rows:[initRow(offered.frame,{recipient:f.uid})]}]});await owner.collect();
  let reject=true;f.store.hooks.beforeCommit=tx=>{if(tx.kind==='record-result'&&reject){reject=false;throw Error('synthetic accepted record persistence failure');}};
  const originalFailure=await pending(owner.process()),original=originalFailure.recoveryState().transaction;
  assert.equal(original.kind,'record-result');loss(f);await reset(f);if(mode==='fresh-store-device'){f.feed.stop();await f.feed.closed;}
  const shutdownFailure=await pending(owner.dispose());await owner.closed;const latest=shutdownFailure.recoveryState();
  assert.deepEqual(latest.transaction,original);assert.equal(typeof latest.resumeCheckpoint,'string');
  // Fresh processes restore the confirmed device from the store, then reconcile the exact pending candidate.
  const saved=await f.store.current();
  const next=mode==='fresh-store-device'?await transportFixture(t,{uid:f.uid,imei:f.imei,queues:[],deviceCheckpoint:saved.deviceCheckpoint,store:f.store}):f;
  const sentBefore=next.sent.length;
  const restored=await attach(next,[peerInput(remote)],{recoveryCheckpoint:latest.resumeCheckpoint});
  assert.equal(restored.metadata.phase,'reconciliation-required');assert.equal((await restored.process()).accepted,0);assert.equal((await restored.dispatch()).attempted,0);
  const output=await restored.readResults();assert.equal(output.length,1);assert.equal(output[0].authenticated,true);
  assert.equal(Buffer.from(output[0].content).toString(),'{"subDevice":[]}');assert.equal(next.device.metadata.remainingOneTimePreKeys,keys-1);
  const attempts=f.store.attempts.filter(tx=>tx.transactionId===original.transactionId);assert.equal(attempts.length,2);for(const tx of attempts)assert.deepEqual(tx,original);
  const adopted=recoveryJournal(original.next.recoveryCheckpoint),barrier=recoveryJournal((await restored.checkpoint()).recoveryCheckpoint);
  for(const name of ['device','bank','intake','results','outbox'])assert.deepEqual(barrier.sections[name],adopted.sections[name]);
  assert.ok(barrier.metadata.reconciliationCauses.includes('input-loss'));assert.ok(barrier.metadata.reconciliationCauses.includes('epoch-reset'));
  assert.equal(next.sent.length,sentBefore);assert.equal(f.sent.filter(tx=>tx.cmd===544||tx.cmd===545).length,0);
});
