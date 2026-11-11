import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProtocolAbortScope } from '../dist/protocol-request.js';
const tick = () => new Promise(resolve => queueMicrotask(resolve));

test('fabricated abort does not cancel and cannot consume the later native abort', async () => {
 const c = new AbortController(), s = createProtocolAbortScope(c.signal);
 try { c.signal.dispatchEvent(new Event('abort')); assert.equal(s.signal.aborted,false); await tick(); c.abort('private'); await tick(); assert.equal(s.signal.aborted,true); }
 finally { s.stop(); }
});
test('native abort in the fabricated-event rearm gap is observed', async () => {
 const c = new AbortController(), s = createProtocolAbortScope(c.signal);
 try { c.signal.dispatchEvent(new Event('abort')); assert.equal(s.signal.aborted,false); c.abort(); await tick(); assert.equal(s.signal.aborted,true); }
 finally { s.stop(); }
});
test('repeated fabricated events retain exactly the native cancellation meaning', async () => {
 const c = new AbortController(), s = createProtocolAbortScope(c.signal);
 try { for(let i=0;i<12;i++){ c.signal.dispatchEvent(new Event('abort')); await tick(); assert.equal(s.signal.aborted,false); } c.abort(); await tick(); assert.equal(s.signal.aborted,true); }
 finally { s.stop(); }
});
test('stop cancels queued rearming and detaches native cancellation', async () => {
 const c = new AbortController(), s = createProtocolAbortScope(c.signal);
 c.signal.dispatchEvent(new Event('abort')); s.stop(); await tick(); c.abort(); await tick(); assert.equal(s.signal.aborted,false); s.stop();
});
test('already aborted native state is mirrored synchronously without exposing caller reason', () => {
 const c = new AbortController(); c.abort({secret:'fixture'}); const s=createProtocolAbortScope(c.signal);
 try {assert.equal(s.signal.aborted,true);assert.notEqual(s.signal.reason,c.signal.reason);} finally{s.stop();}
});
test('native state survives hostile public signal properties and methods', async () => {
 const c = new AbortController(); Object.defineProperties(c.signal,{aborted:{value:false},addEventListener:{value(){throw Error('untrusted');}},removeEventListener:{value(){throw Error('untrusted');}},throwIfAborted:{value(){throw Error('untrusted');}}});
 const s=createProtocolAbortScope(c.signal); try{c.signal.dispatchEvent(new Event('abort'));await tick();assert.equal(s.signal.aborted,false);c.abort();await tick();assert.equal(s.signal.aborted,true);}finally{s.stop();}
});
test('earlier stopImmediatePropagation does not suppress native abort', async () => {
 const c=new AbortController();c.signal.addEventListener('abort',event=>event.stopImmediatePropagation());const s=createProtocolAbortScope(c.signal);
 try{c.abort();await tick();assert.equal(s.signal.aborted,true);}finally{s.stop();}
});
test('nongenuine and proxy signals reject without reading public accessors',()=>{
 const c=new AbortController();for(const value of [{},new Proxy(c.signal,{get(){throw Error('trap');}}),{get aborted(){throw Error('getter');}}])assert.throws(()=>createProtocolAbortScope(value),TypeError);
});

test('fake then genuine abort in one synchronous stack mirrors before any next side effect', () => {
 const c=new AbortController(),s=createProtocolAbortScope(c.signal);
 try {c.signal.dispatchEvent(new Event('abort'));assert.equal(s.signal.aborted,false);c.abort();assert.equal(s.signal.aborted,true);}finally{s.stop();}
});
