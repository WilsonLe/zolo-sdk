import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeE2eeSigner, NativeE2eeSignerError } from '../dist/e2ee-native-signer.js';
import { verifyE2eeCurveSignature } from '../dist/e2ee-key-agreement.js';

// Published Signal JS signing KAT, also matched by the confined stock oracle.
const privateHex = '48a8892cc4e49124b7b57d94fa15becfce071830d6449004685e387c62409973';
const publicHex = '0555f1bfede27b6a03e0dd389478ffb01462e5c52dbbac32cf870f00af1ed9af3a';
const messageHex = '617364666173646661736466';
const signatureHex = '2bc06c745acb8bae10fbc607ee306084d0c28e2b3bb819133392473431291fd0dfa9c7f11479996cf520730d2901267387e08d85bbf2af941590e3035a545285';
const NativeUint8Array = Uint8Array;
const nativeIsView = ArrayBuffer.isView, originalToString = Object.prototype.toString;
const typedLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(NativeUint8Array.prototype), 'byteLength').get;
const message = () => Buffer.from(messageHex, 'hex');

test('dependency type-tag callbacks cannot replace the captured message and publish a self-consistently verified different-message signature', () => {
  const signer = createNativeE2eeSigner(Buffer.from(privateHex, 'hex'));
  const callerMessage = message(), before = Buffer.from(callerMessage);
  let changed = 0, callbackCount = 0, returned, failure;
  // Exact0.0.4 checkArrayTypes uses Object.prototype.toString.call(arg),
  // not instanceof. Its call receiver exposes the owned dependency input.
  Object.prototype.toString = function (...args) {
    callbackCount++;
    if (nativeIsView(this) && changed === 0 && Reflect.apply(typedLength, this, []) === before.length) {
      // Mutate once so verification sees the same altered value instead of
      // accidentally toggling it back. The original caller buffer stays separate.
      this[0] ^= 1; changed++;
    }
    return Reflect.apply(originalToString, this, args);
  };
  try { returned = signer.sign(callerMessage); }
  catch (error) { failure = error; }
  finally { Object.prototype.toString = originalToString; }
  try {
    assert.ok(callbackCount > 0, 'The actual dependency callback seam must execute.');
    assert.equal(changed, 1); assert.deepEqual(callerMessage, before);
    assert.ok(failure instanceof NativeE2eeSignerError, 'A changed dependency input must reject rather than return a different-message signature.');
    assert.equal(failure.code, 'signing-failed'); assert.equal(returned, undefined);
    assert.equal(Object.hasOwn(failure, 'cause'), false);
    assert.doesNotMatch(`${String(failure)} ${JSON.stringify(failure)}`, /48a8892cc4e49124|6173646661736466/);
    assert.equal(Buffer.from(signer.publicKey).toString('hex'), publicHex);
    assert.equal(Buffer.from(signer.sign(message())).toString('hex'), signatureHex);
  } finally { signer.dispose(); }
});

test('restored native constructors preserve the original KAT and fixed captured-message signatures', () => {
  assert.equal(globalThis.Uint8Array, NativeUint8Array);
  assert.equal(Object.prototype.toString, originalToString);
  const signer = createNativeE2eeSigner(Buffer.from(privateHex, 'hex'));
  try {
    const original = message(), before = Buffer.from(original), signature = signer.sign(original);
    assert.equal(Buffer.from(signer.publicKey).toString('hex'), publicHex);
    assert.equal(Buffer.from(signature).toString('hex'), signatureHex);
    assert.equal(verifyE2eeCurveSignature(signer.publicKey, before, signature), true);
    const changedMessage = Buffer.from(before); changedMessage[0] ^= 1;
    assert.equal(verifyE2eeCurveSignature(signer.publicKey, changedMessage, signature), false);
    assert.deepEqual(original, before);
  } finally { signer.dispose(); }
});
