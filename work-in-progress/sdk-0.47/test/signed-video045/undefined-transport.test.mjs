// Root regression for the configured adapter's Response | undefined contract.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uploadSignedChatVideo } from 'zalo-personal-sdk';
import { fixture, videoInput, facts, noForward } from './fixture.mjs';
test('an adapter returning no Response preserves uncertain handoff without a receipt or retry', { timeout: 5000 }, async t => {
 const f=await fixture(t,{ upload:()=>undefined });
 await assert.rejects(uploadSignedChatVideo(f.api,videoInput(f)), facts('submission-unknown',{
  stage:'upload',negotiationSubmitted:true,submitted:true,acceptedChunks:0,acceptedBytes:0,providerCode:undefined,status:undefined,
 }));
 assert.equal(f.uploads.length,1); assert.equal(f.observed.length,1); noForward(f);
 await assert.rejects(uploadSignedChatVideo(f.api,videoInput(f)),{code:'action-reused'});
 assert.equal(f.uploads.length,1); await f.push();
});
