import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopSessionAccountAccess } from '../dist/desktop-session.js';
import { desktopFeedFixture } from './fixtures/desktop-feed.mjs';

test('private account/device binding is stable across connection instances and distinct across accounts or devices', async t => {
  const first = await desktopFeedFixture(t);
  const same = await desktopFeedFixture(t);
  const account = await desktopFeedFixture(t, { accountId: '9300000000000000902' });
  const device = await desktopFeedFixture(t, { imei: 'another-synthetic-imei' });
  const a = desktopSessionAccountAccess(first.connection), b = desktopSessionAccountAccess(same.connection);
  assert.equal(a.identityBinding, b.identityBinding);
  assert.match(a.identityBinding, /^[0-9a-f]{64}$/);
  assert.notEqual(a.identityBinding, desktopSessionAccountAccess(account.connection).identityBinding);
  assert.notEqual(a.identityBinding, desktopSessionAccountAccess(device.connection).identityBinding);
  assert.equal(a.accountId, first.uid); assert.equal(a.computerName, 'Synthetic Desktop');
  for (const name of ['accountId', 'identityBinding', 'computerName']) assert.equal(Object.hasOwn(first.connection, name), false);
});

test('the internal approved identity does not consult a caller-replaced API self method or a credential snapshot', async t => {
  const f = await desktopFeedFixture(t); const original = desktopSessionAccountAccess(f.connection);
  f.api.getOwnId = () => { throw Error('private-self-override'); };
  f.connection.snapshot = () => { throw Error('private-credential-snapshot'); };
  const current = desktopSessionAccountAccess(f.connection);
  assert.equal(current.accountId, f.uid); assert.equal(current.identityBinding, original.identityBinding);
  assert.equal(f.httpCalls.length, 2);
});
