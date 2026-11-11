import test from 'node:test';
import assert from 'node:assert/strict';
import { getGroupListPage, getGroupMemberPage, getEncryptedGroupIds,
  getProfileVerificationStatus } from 'zalo-personal-sdk';
import { fixture } from './fixtures/group-pages.mjs';

const cases = [
  { name: 'group list page', data: { groups: [] }, read: f => getGroupListPage(f.api) },
  { name: 'group member page', data: {}, read: f => getGroupMemberPage(f.api, '1') },
  { name: 'encrypted group IDs', data: [], read: f => getEncryptedGroupIds(f.api) },
  { name: 'existing profile verification', data: { status: 1 }, profile: true,
    read: f => getProfileVerificationStatus(f.api) },
];
const cookies = text => new Map((text ?? '').split(';').filter(Boolean).map(pair => {
  const at = pair.indexOf('='); return [pair.slice(0, at).trim(), pair.slice(at + 1)];
}));

for (const item of cases) test(item.name + ' sends only cookies applicable to the full request URL', async () => {
  const f = fixture();
  if (item.profile) {
    f.cookie.setCookieSync('profile_path=allowed; Path=/api/social/profile', 'https://profile.fixture.invalid');
    f.cookie.setCookieSync('wrong_profile_path=excluded; Path=/other', 'https://profile.fixture.invalid');
  } else {
    f.cookie.setCookieSync('group_root=allowed; Path=/', new URL(f.base).origin);
  }
  f.hooks.respond = () => f.reply(item.data);
  await item.read(f);
  assert.equal(f.sent.length, 1);
  const call = f.sent[0];
  // The independent jar and actual destination decide applicability. No
  // production header builder supplies this expected value.
  const expected = cookies(f.cookie.getCookieStringSync(call.raw));
  const actual = cookies(new Headers(call.init.headers).get('Cookie'));
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [name, value] of expected) assert.equal(actual.get(name), value);
  assert.equal(actual.has('other_path'), false);
  assert.equal(actual.has('wrong_profile_path'), false);
  assert.equal(actual.has(item.profile ? 'group_fixture' : 'foreign_fixture'), false);
  assert.equal(actual.get(item.profile ? 'profile_path' : 'group_fixture'), 'allowed');
  assert.equal(f.effects.listenerStarts, 0);
});
