import assert from 'node:assert/strict';
import {test} from 'node:test';
import {uploadSignedChatVideo} from 'zalo-personal-sdk';
import {fixture,videoInput,facts} from './fixture.mjs';
test('a genuine abort in the fake-event rearm gap prevents the next POST',{timeout:5000},async t=>{
 const f=await fixture(t),c=new AbortController();let armed=false,fired=false;
 const get=f.cookie.getCookieString;
 f.cookie.getCookieString=async function(...args){const value=await Reflect.apply(get,this,args);armed=true;return value;};
 const own=f.api.getOwnId;
 f.api.getOwnId=function(...args){const uid=Reflect.apply(own,this,args);if(armed&&!fired){fired=true;c.signal.dispatchEvent(new Event('abort'));c.abort();}return uid;};
 let error;try{await uploadSignedChatVideo(f.api,videoInput(f,{signal:c.signal}));}catch(value){error=value;}
 console.log(JSON.stringify({fired,nativeAborted:c.signal.aborted,code:error?.code,submitted:error?.submitted,httpCalls:f.http.length,acceptedChunks:error?.acceptedChunks}));
 assert.ok(fired);assert.equal(error?.code,'aborted');assert.equal(error?.submitted,false);assert.equal(f.http.length,0);
 assert.equal(error?.acceptedChunks,0);assert.equal(error?.acceptedBytes,0);
 const retry=await uploadSignedChatVideo(f.api,videoInput(f));assert.equal(retry.clientId,1740000045000);
 assert.equal(f.http.length,1,'only the later explicit retry may enter HTTP');
});
