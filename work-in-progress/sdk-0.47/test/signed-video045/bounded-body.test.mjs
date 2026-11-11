import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uploadSignedChatVideo } from 'zalo-personal-sdk';
import { fixture, videoInput, facts, VIDEO_URL, PROVIDER } from './fixture.mjs';
for(const mode of ['nonbyte','shadowed-byte-length']) test(`malformed ${mode} chunks cannot bypass the 64 KiB response bound`, {timeout:5000}, async t=>{
 const text=JSON.stringify({error_code:0,data:{org:VIDEO_URL,fileId:PROVIDER,padding:'x'.repeat(70000)}});
 let reads=0;const value=mode==='nonbyte'?text:Uint8Array.from(Buffer.from(text));
 if(mode==='shadowed-byte-length')Object.defineProperty(value,'byteLength',{get(){reads++;return 0;}});
 const f=await fixture(t,{upload:()=>new Response(new ReadableStream({start(c){c.enqueue(value);c.close();}}))});
 await assert.rejects(uploadSignedChatVideo(f.api,videoInput(f)),facts('submission-unknown',{stage:'upload',negotiationSubmitted:true,submitted:true,acceptedChunks:0,acceptedBytes:0,providerCode:undefined,status:200}));
 assert.equal(f.uploads.length,1);assert.equal(reads,0);
});

test('a fixed shared-backed ordinary byte range is copied without changing response semantics',{timeout:5000},async t=>{
 const text=JSON.stringify({error_code:0,data:{org:VIDEO_URL,fileId:PROVIDER}}),encoded=Buffer.from(text);
 const backing=new SharedArrayBuffer(encoded.length+16),value=new Uint8Array(backing,8,encoded.length);value.set(encoded);
 const f=await fixture(t,{upload:()=>new Response(new ReadableStream({start(c){c.enqueue(value);c.close();}}))});
 const receipt=await uploadSignedChatVideo(f.api,videoInput(f));assert.equal(receipt.videoUrl,VIDEO_URL);assert.equal(receipt.fileId,PROVIDER);assert.equal(f.uploads.length,1);
});
