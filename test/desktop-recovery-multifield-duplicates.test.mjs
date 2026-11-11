import assert from 'node:assert/strict';
import test from 'node:test';
import { attach, content, messageRow, peer, peerInput, recoveryJournal, serve, transportFixture, until } from './fixtures/desktop-recovery.mjs';

for(const [sameField,uid] of [[false,'9300000000000000992'],[true,'9300000000000000993']])
test('044 acknowledged RTF offline/live duplicate reuses every confirmed field: sameField='+sameField,async t=>{
  const f=await transportFixture(t,{uid}),remote=peer(),established=await f.receiving(remote),keys=f.device.metadata.remainingOneTimePreKeys;
  const body=sameField?'{}':'retained rich text',title=established.remote.encrypt(body),params=sameField?title:established.remote.encrypt('{}');
  const row=messageRow({action:'rtf',title,params});
  const owner=await attach(f,[peerInput(remote,{current:established.checkpoint})]);
  serve(f,{513:[{rows:[row],resumeActionId:'888'}]});await owner.collect();await owner.process();
  const output=await owner.readResults();assert.equal(output.length,1);assert.equal(content(output[0]),body);assert.equal(Buffer.from(output[0].styles).toString(),'{}');
  await owner.acknowledgeResults([output[0].resultId]);assert.deepEqual(await owner.readResults(),[]);
  f.emit(551,{error_code:0,data:{msgs:[structuredClone(row)]}});await until(()=>owner.metadata.recordCount===2);
  const processed=await owner.process();assert.equal(processed.processed,1);assert.equal(processed.accepted,0);assert.equal(processed.blocked,0);
  assert.equal(owner.metadata.blockedCount,0);assert.deepEqual(await owner.readResults(),[]);assert.deepEqual(await owner.readBlocked(),[]);assert.deepEqual(await owner.readOutbox(),[]);
  assert.equal(f.device.metadata.remainingOneTimePreKeys,keys);assert.equal((await owner.process()).processed,0);
  const saved=recoveryJournal((await owner.checkpoint()).recoveryCheckpoint);
  assert.equal(saved.metadata.selectors.find(s=>s.cmd===513).stable,'888');assert.equal(saved.output.results.length,1);
  assert.equal(saved.output.results[0].resultId,output[0].resultId);assert.equal(saved.output.results[0].acknowledged,true);
  assert.equal(saved.intake.records.filter(r=>r[6]===2).length,2);
});
