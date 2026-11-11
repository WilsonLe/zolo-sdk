import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAccountProfileEvents } from '../dist/account-profile-events.js';

const user = '9340000000000007301';
const group = '9340000000000007302';
const statusId = '9340000000000007303';
const emojiId = '9340000000000007304';
const songId = '9340000000000007305';
const credential = 'synthetic-private-hidden-credential';
const row = (act_type, act, data, extra = {}) => ({
  controlId: '9340000000000007306', content: { act_type, ...(act === undefined ? {} : { act }),
    ...(data === undefined ? {} : { data }), ...extra },
});
const frame = (controls, { cmd = 601, subCmd = 0, version = 1, code = 0, transportCode, ...extra } = {}) => ({
  version, cmd, subCmd, encrypt: 3, ...(transportCode === undefined ? {} : { errorCode: transportCode }),
  payload: { error_code: code, data: { controls, ...extra } },
});
const extract = controls => extractAccountProfileEvents(frame(controls));
const one = control => extract([control])[0];
const unsupported = control => {
  const result = one(control); assert.equal(Object.hasOwn(result, 'change'), false); return result;
};
const status = extra => ({ noisedOwnerId: user, emojiStatusId: statusId, emojiId, createdTime: 1, duration: 3600000, ...extra });

test('all twelve changes preserve original wire order and raw private references without applying native local policies', () => {
  const controls = [
    row('alias', 'future-alias-action', { opaque: true }), row('profile', 'phonebook'), row('profile', 'update'),
    row('profile', 'update_status', { status: 'Synthetic status' }),
    row('my_settings', 'update', { outside: true }),
    row('profile', 'online_status', { uid: user, lastOnline: '1234567890123' }),
    row('profile', 'mode', { mode: 1 }),
    row('hidden_chat', 'add_remove', { add_items: [{ thread_id: group, is_group: 1 }], del_items: [] }),
    row('hidden_chat', 'reset'), row('hidden_chat', 'change_pin', { pin: credential }),
    row('emoji_status', 'add', { emojiStatus: status(), debounceTime: 2 }),
    row('emoji_status', 'delete', { emojiStatus: { noisedOwnerId: user, emojiStatusId: statusId } }),
    row('profile', 'biz', { retained: true }),
  ];
  const input = frame(controls, { cmd: 603, subCmd: 1 }); const before = structuredClone(input);
  const events = extractAccountProfileEvents(input);
  assert.deepEqual(events.map(event => event.controlIndex), [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(events.map(event => event.change?.kind), ['aliases-invalidated', 'phonebook-invalidated', 'own-profile-invalidated',
    'own-profile-status-updated', 'profile-last-online-updated', 'profile-mode-updated', 'hidden-chat-membership-updated',
    'hidden-chat-reset', 'hidden-chat-pin-invalidated', 'emoji-status-add-signal', 'emoji-status-delete-signal', 'own-business-profile-patch']);
  for (const event of events) {
    assert.equal(event.rawControl, controls[event.controlIndex]); assert.equal(event.rawContent, controls[event.controlIndex].content);
    assert.equal(Object.isFrozen(event), true);
  }
  assert.equal(Object.isFrozen(events), true); assert.deepEqual(input, before);
});

test('alias-any-act and profile/phonebook/update are invalidations after common normalization, not snapshots', () => {
  for (const act of [undefined, null, 'update', 'remove', 'future-action']) {
    assert.deepEqual(one(row('alias', act, { aliasData: [], version: 9 })).change, { kind: 'aliases-invalidated' });
  }
  assert.deepEqual(one(row('profile', 'phonebook')).change, { kind: 'phonebook-invalidated' });
  assert.deepEqual(one(row('profile', 'update', { avatar: 'not-an-applied-avatar', version: 9 })).change, { kind: 'own-profile-invalidated' });
  for (const type of ['alias', 'profile']) {
    const act = type === 'alias' ? 'anything' : 'update';
    unsupported(row(type, act, '{malformed-json'));
    assert.ok(one(row(type, act, ' {left-unparsed}')).change);
  }
  const events = extract([row('alias', 'update', '{bad'), row('profile', 'phonebook'), row('profile', 'update')]);
  assert.equal(Object.hasOwn(events[0], 'change'), false); assert.equal(events[1].change.kind, 'phonebook-invalidated');
  assert.equal(events[2].change.kind, 'own-profile-invalidated');
});

test('own profile status requires an actual bounded string and preserves explicit empty text without local fallback or throttle', () => {
  const a = row('profile', 'update_status', { status: '' }); const b = row('profile', 'update_status', { status: ' second ' });
  const events = extract([a, b, a]);
  assert.equal(events.length, 3); assert.deepEqual(events.map(event => event.change.status), ['', ' second ', '']);
  assert.equal(events[0].change.raw, a.content.data); assert.equal(Object.hasOwn(events[0].change, 'userId'), false);
  for (const value of [undefined, null, false, 0, {}, [], '🙂'.repeat(16_385), 'x'.repeat(65_537)]) {
    unsupported(row('profile', 'update_status', value === undefined ? {} : { status: value }));
  }
  assert.equal(one(row('profile', 'update_status', { status: 'x'.repeat(65_536) })).change.status.length, 65_536);
  unsupported(row('profile', 'update_status', ' {"status":"not-trimmed"}'));
  assert.equal(one(row('profile', 'update_status', '{"status":"decoded-once"}')).change.status, 'decoded-once');
});

test('last-online values retain milliseconds and exact identities without inferring presence, local now or feature gates', () => {
  const data = { uid: user, lastOnline: '9340000000000007307', future: { retained: true } };
  const change = one(row('profile', 'online_status', data)).change;
  assert.deepEqual(change, { kind: 'profile-last-online-updated', userId: user, lastOnlineMilliseconds: data.lastOnline, raw: data });
  assert.equal(Object.hasOwn(change, 'online'), false); assert.equal(Object.hasOwn(change, 'currentTime'), false);
  const numeric = one(row('profile', 'online_status', { uid: 12, lastOnline: 1234567890123 })).change;
  assert.equal(numeric.userId, '12'); assert.equal(numeric.lastOnlineMilliseconds, 1234567890123);
  for (const lastOnline of [0, -1, '0', '-1', '01', '1\n', NaN, Number.MAX_SAFE_INTEGER + 1, false]) {
    unsupported(row('profile', 'online_status', { uid: user, lastOnline }));
  }
  for (const uid of ['0', `g${group}`, '01', Number(user)]) unsupported(row('profile', 'online_status', { uid, lastOnline: 1 }));
});

test('mode permits the source-specific extra whitespace JSON parse once and preserves raw AWAY/future modes and self/user targets', () => {
  const inputs = [{ mode: 1 }, '{"mode":1}', ' \n{"mode":1}', `\t{"friendId":${user},"mode":2,"future":${statusId}}`];
  for (const data of inputs) {
    const event = one(row('profile', 'mode', data)); assert.equal(event.change.kind, 'profile-mode-updated');
    assert.equal(event.change.mode, typeof data === 'string' && data.includes('friendId') ? 2 : 1);
    assert.equal(event.rawContent.data, data);
  }
  const peer = one(row('profile', 'mode', inputs[3])).change;
  assert.deepEqual(peer.target, { kind: 'user', userId: user }); assert.equal(peer.raw.future, statusId);
  assert.deepEqual(one(row('profile', 'mode', { mode: 1 })).change.target, { kind: 'self' });
  assert.deepEqual(one(row('profile', 'mode', { mode: 3, friendId: null })).change.target, { kind: 'self' });
  assert.equal(one(row('profile', 'mode', { mode: -100, friendId: 12 })).change.mode, -100);
  assert.equal(one(row('profile', 'mode', { mode: 100_000_001 })).change.mode, 100_000_001);
  for (const data of [JSON.stringify('{"mode":2}'), '[{"mode":2}]', 'null', '2', '{bad', ' {bad',
    { mode: '1' }, { mode: 1.5 }, { mode: Number.MAX_SAFE_INTEGER + 1 }, { mode: 1, friendId: 0 },
    { mode: 1, friendId: '' }, { mode: 1, friendId: `g${group}` }]) unsupported(row('profile', 'mode', data));
});

test('hidden membership preserves separate overlapping/duplicate lists and raw entries without a cache-dependent merge outcome', () => {
  const repeated = { thread_id: user, is_group: 0, future: 'kept' };
  const data = { add_items: [repeated, { thread_id: group, is_group: 1 }, repeated,
    { thread_id: user, is_group: true }, { thread_id: group, is_group: '1' }, { thread_id: `g${group}`, is_group: 1 }, null],
    del_items: [repeated, { thread_id: 12, is_group: 0 }], version: 'not-consumed', ts: 'not-consumed' };
  const value = one(row('hidden_chat', 'add_remove', data)).change;
  assert.equal(value.kind, 'hidden-chat-membership-updated'); assert.equal(value.raw, data);
  assert.equal(value.additions.length, 7); assert.equal(value.removals.length, 2);
  assert.equal(value.additions[0].raw, repeated); assert.equal(value.removals[0].raw, repeated);
  assert.deepEqual(value.additions[0].value, { threadType: 'user', threadId: user });
  assert.deepEqual(value.additions[1].value, { threadType: 'group', threadId: group });
  assert.deepEqual(value.additions[2].value, value.additions[0].value);
  for (const item of value.additions.slice(3)) assert.equal(Object.hasOwn(item, 'value'), false);
  assert.deepEqual(value.removals[1].value, { threadType: 'user', threadId: '12' });
  for (const field of ['hidden', 'replacement', 'version', 'timestamp', 'lastActionId']) assert.equal(Object.hasOwn(value, field), false);
  assert.deepEqual(data.add_items, [repeated, { thread_id: group, is_group: 1 }, repeated,
    { thread_id: user, is_group: true }, { thread_id: group, is_group: '1' }, { thread_id: `g${group}`, is_group: 1 }, null]);
});

test('hidden missing/empty lists remain distinct and content resets/PIN signals do not copy credentials or invent state clearing', () => {
  const missing = one(row('hidden_chat', 'add_remove', {})).change;
  assert.equal(Object.hasOwn(missing, 'additions'), false); assert.equal(Object.hasOwn(missing, 'removals'), false);
  const empty = one(row('hidden_chat', 'add_remove', { add_items: [], del_items: [] })).change;
  assert.deepEqual(empty.additions, []); assert.deepEqual(empty.removals, []);
  for (const data of [{ add_items: null }, { del_items: {} }, { add_items: '[]' }]) unsupported(row('hidden_chat', 'add_remove', data));
  assert.deepEqual(one(row('hidden_chat', 'reset')).change, { kind: 'hidden-chat-reset' });
  assert.deepEqual(one(row('hidden_chat', 'reset', { resetLastActionId: statusId })).change, { kind: 'hidden-chat-reset' });
  const control = row('hidden_chat', 'change_pin', { pin: credential, future: 'kept' }); const event = one(control);
  assert.deepEqual(event.change, { kind: 'hidden-chat-pin-invalidated' }); assert.equal(event.rawControl, control);
  assert.equal(event.rawContent.data.pin, credential); assert.doesNotMatch(JSON.stringify(event.change), /synthetic-private|pin":|credential/);
  assert.equal(one(row('hidden_chat', 'change_pin', { pin: 'not-a-guessed-hash-format' })).change.kind, 'hidden-chat-pin-invalidated');
  for (const pin of ['', null, false, 123, {}, 'x'.repeat(65_537)]) unsupported(row('hidden_chat', 'change_pin', { pin }));
  assert.equal(extractAccountProfileEvents(frame([control], { resetLastActionId: statusId })), undefined);
});

test('emoji add exposes mechanical millisecond fields/song metadata for any owner without expiry filtering or account substitution', () => {
  const item = status({ caption: null, extraData: { song: { songId, futureSong: true }, futureExtra: true }, futureStatus: true });
  const data = { emojiStatus: item, debounceTime: 2, futureSignal: true };
  const event = one(row('emoji_status', 'add', data)); const value = event.change;
  assert.equal(value.kind, 'emoji-status-add-signal'); assert.equal(value.raw, data); assert.equal(value.status.raw, item);
  assert.deepEqual(value.status.value, { noisedOwnerId: user, emojiStatusId: statusId, emojiId,
    createdTimeMilliseconds: 1, durationMilliseconds: 3600000, caption: null, songId });
  assert.equal(value.debounceSeconds, 2); assert.equal(item.futureStatus, true); assert.equal(item.extraData.futureExtra, true);
  for (const field of ['isSelf', 'userId', 'expired', 'expiresAt', 'applied', 'cursor', 'nextPullAt']) assert.equal(Object.hasOwn(value, field), false);
  const other = one(row('emoji_status', 'add', { emojiStatus: status({ noisedOwnerId: group }) })).change;
  assert.equal(other.status.value.noisedOwnerId, group);
  const json = `{"emojiStatus":{"noisedOwnerId":${user},"emojiStatusId":${statusId},"emojiId":${emojiId},"createdTime":1,"duration":1000,"extraData":{"song":{"songId":${songId}}}}}`;
  assert.equal(one(row('emoji_status', 'add', json)).change.status.value.songId, songId);
});

test('emoji add/delete invalidation survives missing/null/unsupported records and delete does not require a full add record', () => {
  for (const act of ['add', 'delete']) {
    const missing = one(row('emoji_status', act, {})).change;
    assert.equal(missing.kind, act === 'add' ? 'emoji-status-add-signal' : 'emoji-status-delete-signal');
    assert.equal(Object.hasOwn(missing, 'status'), false);
    for (const emojiStatus of [undefined, null, false, [], 'future-status', {}, { noisedOwnerId: user }]) {
      const change = one(row('emoji_status', act, { emojiStatus })).change;
      assert.equal(change.status.raw, emojiStatus); assert.equal(Object.hasOwn(change.status, 'value'), false);
    }
  }
  const identity = { noisedOwnerId: user, emojiStatusId: statusId, future: true };
  const deleted = one(row('emoji_status', 'delete', { emojiStatus: identity })).change;
  assert.deepEqual(deleted.status.value, { noisedOwnerId: user, emojiStatusId: statusId });
  assert.equal(deleted.status.raw, identity); assert.equal(Object.hasOwn(deleted, 'removeOwner'), false);
  assert.equal(Object.hasOwn(one(row('emoji_status', 'add', { emojiStatus: identity })).change.status, 'value'), false);
  for (const extra of [{ createdTime: 0 }, { duration: 0 }, { createdTime: '1' }, { duration: '1000' },
    { emojiId: Number(emojiId) }, { noisedOwnerId: '0' }]) {
    const change = one(row('emoji_status', 'add', { emojiStatus: status(extra) })).change;
    assert.equal(Object.hasOwn(change.status, 'value'), false);
  }
});

test('emoji explicit debounce seconds have no default/scheduler, and bounded optional caption does not destroy valid identity', () => {
  for (const debounceTime of [0, 0.5, 2]) {
    const change = one(row('emoji_status', 'add', { debounceTime })).change;
    assert.equal(change.debounceSeconds, debounceTime); assert.equal(Object.hasOwn(change, 'status'), false);
  }
  for (const debounceTime of [undefined, null, -1, '2', false, NaN, Infinity]) {
    const change = one(row('emoji_status', 'delete', { debounceTime })).change;
    assert.equal(Object.hasOwn(change, 'debounceSeconds'), false);
  }
  for (const caption of ['x'.repeat(65_536), null]) assert.equal(one(row('emoji_status', 'add', { emojiStatus: status({ caption }) })).change.status.value.caption, caption);
  for (const caption of ['🙂'.repeat(16_385), 'x'.repeat(65_537), {}, false]) {
    const item = status({ caption }); const value = one(row('emoji_status', 'add', { emojiStatus: item })).change.status;
    assert.equal(value.value.noisedOwnerId, user); assert.equal(Object.hasOwn(value.value, 'caption'), false);
    assert.equal(value.raw.caption, caption);
  }
});

test('unknown/incomplete acts, data and identities retain selected raw wrappers while unrelated families remain outside scope', () => {
  for (const type of ['profile', 'hidden_chat', 'emoji_status']) {
    const control = row(type, 'future-act', { future: { retained: true } });
    const event = unsupported(control); assert.equal(event.rawControl, control); assert.equal(event.rawContent, control.content);
  }
  const businessData = {};
  const business = one(row('profile', 'biz', businessData)).change;
  assert.equal(business.kind, 'own-business-profile-patch');
  assert.deepEqual(business.target, { kind: 'self' }); assert.equal(business.raw, businessData);
  for (const control of [row('profile', 'biz', []), row('profile', 'mode', []), row('hidden_chat', 'add_remove', null),
    row('emoji_status', 'add', []), row('emoji_status', 'delete', ' {"emojiStatus":null}'), row('emoji_status', 'add', '{bad')]) unsupported(control);
  assert.deepEqual(extract([row('mute', 'set', { toId: user }), row('my_settings', 'update'), row('voice2text', 'convert_finish')]), []);
  const inherited = Object.assign(Object.create({ uid: user, lastOnline: 1 }), { future: true });
  unsupported(row('profile', 'online_status', inherited));
  const statusFromPrototype = Object.assign(Object.create({ emojiStatus: status() }), { debounceTime: 1 });
  assert.equal(Object.hasOwn(one(row('emoji_status', 'add', statusFromPrototype)).change, 'status'), false);
});

test('own descriptors never invoke selected accessors and contain private faults while leaving safe later rows available', () => {
  let reads = 0;
  const data = {}; Object.defineProperty(data, 'status', { get() { reads++; throw Error('private-status'); } });
  const events = extract([row('profile', 'update_status', data), row('alias', 'update')]);
  assert.equal(Object.hasOwn(events[0], 'change'), false); assert.equal(events[1].change.kind, 'aliases-invalidated'); assert.equal(reads, 0);
  const item = status(); Object.defineProperty(item, 'caption', { get() { reads++; throw Error('private-caption'); } });
  const observed = one(row('emoji_status', 'add', { emojiStatus: item })).change;
  assert.equal(observed.status.raw, item); assert.equal(Object.hasOwn(observed.status, 'value'), false); assert.equal(reads, 0);
  const unknown = {}; Object.defineProperty(unknown, 'unrelated', { get() { reads++; throw Error('private-unknown'); } });
  assert.equal(one(row('profile', 'update_status', { status: 'known', unknown })).change.raw.unknown, unknown); assert.equal(reads, 0);
  const selected = row('profile', 'update'); Object.defineProperty(selected.content, 'data', { get() { reads++; throw Error('private-row'); } });
  assert.equal(extract([selected]), undefined); assert.equal(reads, 0);
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('private-descriptor'); } });
  assert.doesNotThrow(() => unsupported(row('profile', 'mode', proxy)));
});

test('dense indexed hidden lists reject sparse/accessor slots and oversized counts before reads, without executing iterators', () => {
  let reads = 0; let iterated = 0;
  const list = [{ thread_id: user, is_group: 0 }];
  Object.defineProperty(list, Symbol.iterator, { value() { iterated++; throw Error('private-iterator'); } });
  const controls = [row('hidden_chat', 'add_remove', { add_items: list })];
  Object.defineProperty(controls, Symbol.iterator, { value() { iterated++; throw Error('private-controls-iterator'); } });
  assert.equal(extract(controls)[0].change.additions[0].value.threadId, user); assert.equal(iterated, 0);
  unsupported(row('hidden_chat', 'add_remove', { add_items: new Array(1) }));
  const undefinedSlot = one(row('hidden_chat', 'add_remove', { add_items: [undefined] })).change.additions[0];
  assert.equal(undefinedSlot.raw, undefined); assert.equal(Object.hasOwn(undefinedSlot, 'value'), false);
  const accessor = []; Object.defineProperty(accessor, 0, { get() { reads++; throw Error('private-entry'); } });
  unsupported(row('hidden_chat', 'add_remove', { del_items: accessor })); assert.equal(reads, 0);
  const large = new Array(20_001); Object.defineProperty(large, 0, { get() { reads++; throw Error('private-large'); } });
  unsupported(row('hidden_chat', 'add_remove', { add_items: large })); assert.equal(reads, 0);
});

test('aggregate attempted entries include unsupported hidden rows and emoji records before validation, without losing raw events', () => {
  let attempts = 0;
  const blockedStatus = new Proxy(status(), { getOwnPropertyDescriptor(target, field) { attempts++; return Object.getOwnPropertyDescriptor(target, field); } });
  const controls = [row('hidden_chat', 'add_remove', { add_items: Array(20_000).fill(null) }),
    row('emoji_status', 'add', { emojiStatus: blockedStatus }), row('emoji_status', 'delete', {}), row('alias', 'update')];
  const events = extract(controls);
  assert.equal(events[0].change.additions.length, 20_000); assert.equal(Object.hasOwn(events[0].change.additions[0], 'value'), false);
  assert.equal(Object.hasOwn(events[1], 'change'), false); assert.equal(events[1].rawControl, controls[1]); assert.equal(attempts, 0);
  assert.equal(events[2].change.kind, 'emoji-status-delete-signal'); assert.equal(events[3].change.kind, 'aliases-invalidated');
  const charged = extract([row('hidden_chat', 'add_remove', { add_items: Array(19_999).fill(null) }),
    row('emoji_status', 'delete', { emojiStatus: null }), row('hidden_chat', 'add_remove', { del_items: [user] })]);
  assert.equal(charged[1].change.status.raw, null); assert.equal(Object.hasOwn(charged[2], 'change'), false);
});

test('shared strict status/reset/header/own-row boundaries and selected UTF8 text budgets remain intact', () => {
  const controls = [row('alias', 'update')];
  for (const options of [{ cmd: 603, subCmd: 1 }, { cmd: 601, subCmd: 255 }, { resetLastActionId: null }, { resetLastActionId: 0 }, { resetLastActionId: '0' }]) {
    assert.equal(extractAccountProfileEvents(frame(controls, options))[0].change.kind, 'aliases-invalidated');
  }
  for (const options of [{ cmd: 610 }, { cmd: 614 }, { version: 2 }, { subCmd: 256 }, { code: '0' }, { code: 212 },
    { transportCode: 212 }, { transportCode: '0' }, { resetLastActionId: statusId }]) assert.equal(extractAccountProfileEvents(frame(controls, options)), undefined);
  assert.equal(extractAccountProfileEvents(frame(null)), undefined);
  assert.deepEqual(extract([{ content: JSON.stringify({ act_type: 'alias', act: 'update' }) }, null, {}]), []);
  assert.equal(extract([row('alias', 'update', '🙂'.repeat(16_385))]), undefined);
  assert.equal(extract(Array.from({ length: 17 }, () => row('alias', 'update', 'x'.repeat(65_536)))), undefined);
  const unrelated = row('my_settings', 'update', 'x'.repeat(1_048_577));
  assert.equal(extract([unrelated, ...controls]).length, 1);
  const inherited = frame(controls); delete inherited.payload.error_code; Object.setPrototypeOf(inherited.payload, { error_code: 0 });
  assert.equal(extractAccountProfileEvents(inherited), undefined);
  let reads = 0; const bad = frame(controls); Object.defineProperty(bad, 'cmd', { get() { reads++; throw Error('private-header'); } });
  assert.equal(extractAccountProfileEvents(bad), undefined); assert.equal(reads, 0);
});
