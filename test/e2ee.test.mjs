import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceE2eeChain,
  decodeE2eeFrame,
  deriveE2eeDirectKeys,
  deriveE2eeGroupKeys,
  deriveE2eeInitialRoot,
  deriveE2eeRatchet,
  encodeE2eeFrame,
} from '../dist/e2ee.js';

const bytes = (start) => Buffer.from(Array.from({ length: 32 }, (_, index) => index + start));
const hex = (value) => value.toString('hex');

test('recognizes the observed Zalo frame layout with synthetic, unverified bodies', () => {
  const frames = [
    ['direct', 10, 'ATMBAgMEBQYHCAk='],
    ['pre-key', 2, 'AzMB'],
    ['group', 66, 'BDMBAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQQ=='],
  ];
  for (const [kind, size, encoded] of frames) {
    const body = Buffer.from(Array.from({ length: size }, (_, index) => index || 0x33));
    assert.equal(encodeE2eeFrame({ kind, body }), encoded);
    assert.deepEqual(decodeE2eeFrame(encoded), { kind, body });
  }
  assert.throws(() => decodeE2eeFrame('BzMB'), /Unknown Zalo E2EE frame kind/);
  assert.throws(() => decodeE2eeFrame('AzIB'), /version-3 frame body/);
  assert.throws(() => decodeE2eeFrame('BDMB'), /version-3 frame body/);
  assert.throws(() => decodeE2eeFrame('AzMB$'), /Invalid Zalo E2EE frame encoding/);
});

test('derives legacy Zalo direct and group keys from synthetic known inputs', () => {
  // Expected bytes were generated independently using Python hmac and RFC 5869 expansion.
  assert.equal(hex(deriveE2eeInitialRoot([bytes(0), bytes(32), bytes(64)])),
    'f811615286bb5503f0bd32de0e118e97bf433752436e724d79310ded2725cc92');
  assert.equal(hex(deriveE2eeInitialRoot([bytes(0), bytes(32), bytes(64), bytes(96)])),
    '52c8c053bdf894fb71a08869449d11809ff8f5b24ea2f5fcb827499aa0c7588d');

  const step = deriveE2eeRatchet(bytes(0), bytes(32));
  assert.equal(hex(step.rootKey), 'deb686be7410e72369f70689be80deb123a8e7c509929038d282f6b68ebcd50c');
  assert.equal(hex(step.chainKey), 'e4c82f49b4a9794336b14afe0c29a24957dd91022303ef97c649e610930d43cb');

  const chain = advanceE2eeChain(bytes(0));
  assert.equal(hex(chain.messageSeed), '9b4c8120a4823a95f47cde17a244f4507244ee6e3957d1fab9fa29b44d3829b7');
  assert.equal(hex(chain.nextChainKey), '4304c22c84a53755ab08ead8d97a8d429be5efa480682d7ad1da27f73e1fbe1d');

  const direct = deriveE2eeDirectKeys(bytes(0));
  assert.equal(hex(direct.cipherKey), '4e15c19fb951a47477903b3c4a661c3477627f05c77a1b92adb822bc5dd5fb0e');
  assert.equal(hex(direct.macKey), '7004e885691da87e2294d1f9ef7a2ef94bd40813fa0b8b8c5206540d5c9c4a84');
  assert.equal(hex(direct.iv), '1b1846024bb055ff3f1563e8860dc547');

  const group = deriveE2eeGroupKeys(bytes(0));
  assert.equal(hex(group.iv), '5f1729457bd1885d76a4f2257ba41260');
  assert.equal(hex(group.cipherKey), '19c368c2dafbf26c6a4774e5049a0aa23530c6b2293345c5af329cae086ebbca');
  assert.throws(() => deriveE2eeDirectKeys(Buffer.alloc(16)), /32-byte inputs/);
});
