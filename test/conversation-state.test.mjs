import assert from 'node:assert/strict';
import test from 'node:test';
import { extractConversationStateEvents } from '../dist/conversation-state.js';

const user = '9340000000000007201';
const group = '9340000000000007202';
const message = '9340000000000007203';
const revision = '9340000000000007204';
const row = (act_type, act, data, extra = {}) => ({
  controlId: revision, content: { act_type, act, ...(data === undefined ? {} : { data }), ...extra },
});
const frame = (controls, { cmd = 601, subCmd = 0, version = 1, code = 0, transportCode, ...extra } = {}) => ({
  version, cmd, subCmd, encrypt: 3, ...(transportCode === undefined ? {} : { errorCode: transportCode }),
  payload: { error_code: code, data: { controls, ...extra } },
});
const extract = controls => extractConversationStateEvents(frame(controls));
const one = control => extract([control])[0];
const unsupported = control => { const event = one(control); assert.equal(Object.hasOwn(event, 'change'), false); return event; };

test('preserves wire order, selected raw references and unknown extensions without mutating or folding input', () => {
  const controls = [
    row('mute', 'set', { toId: user, muteType: 1, duration: 3600, systemTime: 1, advanced: { future: true } }),
    row('my_settings', 'update', { opaque: 'outside this extractor' }),
    row('pinned_convers', 'update', { pinIds: [`g${group}`, `u${user}`], action: 1, ts: 10 }),
    row('label_convers', 'update'),
    row('archived_chat', 'update', { version: revision, items: [{ id: user, type: 0 }] }),
    row('mark_unread', 'add', undefined, { content: JSON.stringify({ convsUser: [{ id: user, cliMsgId: message }] }) }),
    row('conv_settings', 'update_ttl', { threadId: group, isGroup: 1, ttl: 86400000, ts: 123 }),
    row('conv_settings', 'update_block_sharing', { threadId: user, isGroup: 0, isEnabled: 1, fromId: '0', ts: 456 }),
    row('mute', 'future-act', { retained: true }),
    row('mute', 'unset', { toId: user, muteType: 1 }),
  ];
  const input = frame(controls, { cmd: 603, subCmd: 1 }); const before = structuredClone(input);
  const events = extractConversationStateEvents(input);
  assert.deepEqual(events.map(event => event.controlIndex), [0, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(events.map(event => event.change?.kind), ['mute-set', 'pins-updated', 'labels-invalidated',
    'archives-invalidated', 'unread-mark-added', 'ttl-updated', 'block-sharing-updated', undefined, 'mute-unset']);
  for (const event of events) {
    assert.equal(event.rawControl, controls[event.controlIndex]); assert.equal(event.rawContent, controls[event.controlIndex].content);
    assert.equal(Object.isFrozen(event), true);
  }
  assert.equal(events[0].change.raw.advanced, controls[0].content.data.advanced);
  assert.equal(Object.hasOwn(events[0].change.raw, 'currentTime'), false);
  assert.deepEqual(input, before); assert.equal(Object.isFrozen(events), true);
});

test('mute set/unset projects only proven types and keeps seconds, old timestamps, opaque settings and independent rows', () => {
  const a = row('mute', 'set', { toId: user, muteType: 1, duration: 0, systemTime: 0, startTime: 999, muteMode: 9 });
  const b = row('mute', 'set', { toId: group, muteType: 2, duration: -1 });
  const c = row('mute', 'unset', { toId: user, muteType: 1 });
  const values = extract([a, b, c]);
  assert.deepEqual(values[0].change, { kind: 'mute-set', thread: { threadType: 'user', threadId: user },
    durationSeconds: 0, systemTimeSeconds: 0, raw: a.content.data });
  assert.equal(values[1].change.thread.threadType, 'group'); assert.equal(values[1].change.durationSeconds, -1);
  assert.equal(Object.hasOwn(values[1].change, 'systemTimeSeconds'), false);
  assert.deepEqual(values[2].change, { kind: 'mute-unset', thread: { threadType: 'user', threadId: user }, raw: c.content.data });
  for (const data of [
    { toId: user, muteType: '1', duration: -1 }, { toId: user, muteType: 3, duration: -1 },
    { toId: `g${group}`, muteType: 2, duration: -1 }, { toId: user, muteType: 1, duration: 3600 },
    { toId: user, muteType: 1, duration: -2, systemTime: 1 }, { toId: user, muteType: 1, duration: '3600', systemTime: 1 },
    { toId: user, muteType: 1, duration: 0.5, systemTime: 1 },
  ]) unsupported(row('mute', 'set', data));
});

test('pin deltas require exact action/u-or-g tokens and retain duplicates, unsupported entries and provider timestamp', () => {
  const ids = [`u${user}`, `g${group}`, `u${user}`, user, 'u01', 'g0', 12, null];
  const control = row('pinned_convers', 'update', { pinIds: ids, action: 2, ts: revision, future: ['kept'] });
  const value = one(control).change;
  assert.equal(value.kind, 'pins-updated'); assert.equal(value.action, 'unpin'); assert.equal(value.timestamp, revision);
  assert.deepEqual(value.entries.map(entry => entry.raw), ids); assert.equal(value.entries.length, 8);
  assert.deepEqual(value.entries[0].value, { threadType: 'user', threadId: user });
  assert.deepEqual(value.entries[1].value, { threadType: 'group', threadId: group });
  assert.deepEqual(value.entries[2].value, value.entries[0].value);
  for (const entry of value.entries.slice(3)) assert.equal(Object.hasOwn(entry, 'value'), false);
  assert.equal(Object.hasOwn(value, 'priority'), false); assert.equal(Object.hasOwn(value, 'tab'), false);
  assert.deepEqual(one(row('pinned_convers', 'update', { pinIds: [], action: 1, ts: 1 })).change.entries, []);
  for (const data of [{ pinIds: [], action: 3, ts: 1 }, { pinIds: [], action: '1', ts: 1 },
    { pinIds: [], action: 1, ts: 0 }, { pinIds: [], action: 1 }, { pinIds: null, action: 1, ts: 1 }]) {
    unsupported(row('pinned_convers', 'update', data));
  }
});

test('normal data uses exact first-character one-layer lossless decoding; malformed rows remain raw and do not hide later rows', () => {
  const json = `{"toId":${user},"muteType":1,"duration":3600,"systemTime":1,"extra":{"id":${message}}}`;
  const control = row('mute', 'set', json); const event = one(control);
  assert.equal(event.rawContent.data, json); assert.equal(event.change.thread.threadId, user);
  assert.equal(event.change.raw.extra.id, message);
  for (const data of [` ${json}`, `\n${json}`, JSON.stringify(json), '[1,2]', 'null', '{bad-json']) {
    unsupported(row('mute', 'set', data));
  }
  const events = extract([row('mute', 'set', '{bad-json'), row('label_convers', 'update', '  {unparsed}')]);
  assert.equal(Object.hasOwn(events[0], 'change'), false); assert.deepEqual(events[1].change, { kind: 'labels-invalidated' });
});

test('label update is data-independent invalidation and archive update is versioned invalidation with only affected hints', () => {
  assert.deepEqual(one(row('label_convers', 'update')).change, { kind: 'labels-invalidated' });
  assert.deepEqual(one(row('label_convers', 'update', { labelData: [], version: revision })).change, { kind: 'labels-invalidated' });
  unsupported(row('label_convers', 'replace', { labelData: [] }));
  const data = { version: revision, actionType: 0, items: [{ id: group, type: 1 }, { id: user, type: 0 },
    { id: user, type: 2 }, { id: group, type: '1' }, null], future: { retained: true } };
  const change = one(row('archived_chat', 'update', data)).change;
  assert.equal(change.kind, 'archives-invalidated'); assert.equal(change.version, revision); assert.equal(change.raw, data);
  assert.deepEqual(change.items[0].value, { threadType: 'group', threadId: group });
  assert.deepEqual(change.items[1].value, { threadType: 'user', threadId: user });
  for (const item of change.items.slice(2)) assert.equal(Object.hasOwn(item, 'value'), false);
  assert.equal(Object.hasOwn(change, 'archived'), false); assert.equal(Object.hasOwn(change, 'replacement'), false);
  const missing = one(row('archived_chat', 'update', { version: 2 })).change;
  assert.equal(Object.hasOwn(missing, 'items'), false);
  assert.deepEqual(one(row('archived_chat', 'update', { version: 2, items: [] })).change.items, []);
  unsupported(row('archived_chat', 'update', { items: [] }));
});

test('unread add parses whitespace-leading content, uses exact outer controlId, preserves actor0 and never consumes data as marks', () => {
  const content = ` \n{"convsGroup":[{"id":${group},"cliMsgId":${message},"fromUid":0,"ts":123,"future":true}],"convsUser":[],"controlId":"7","extra":{"id":${user}}}`;
  const control = row('mark_unread', 'add', { convsUser: [{ id: user, cliMsgId: '8' }] }, { content, controlId: 'inner-id-ignored' });
  const value = one(control).change;
  assert.equal(value.kind, 'unread-mark-added'); assert.equal(value.updateId, revision);
  assert.deepEqual(value.groups[0].value, { threadType: 'group', threadId: group, clientMessageId: message, fromUserId: '0', timestamp: 123 });
  assert.equal(value.groups[0].raw.future, true); assert.equal(value.raw.extra.id, user); assert.deepEqual(value.users, []);
  assert.equal(value.raw.controlId, '7'); assert.equal(control.content.controlId, 'inner-id-ignored');
  const missing = one(row('mark_unread', 'add', undefined, { content: '{}' })).change;
  assert.equal(Object.hasOwn(missing, 'groups'), false); assert.equal(Object.hasOwn(missing, 'users'), false);
  for (const content of [undefined, {}, 'null', '[]', '{bad', '"{}"']) unsupported(row('mark_unread', 'add', undefined, { content }));
  for (const id of ['0', '01', '1\n', Number.MAX_SAFE_INTEGER + 1, undefined]) {
    const bad = row('mark_unread', 'add', undefined, { content: '{}' }); bad.controlId = id; unsupported(bad);
  }
  const inherited = row('mark_unread', 'add', undefined, { content: '{}' }); delete inherited.controlId;
  Object.setPrototypeOf(inherited, { controlId: revision }); unsupported(inherited);
});

test('unread remove consumes bare ID arrays, keeps missing/empty distinctions and retains add entries with unsupported metadata', () => {
  const control = row('mark_unread', 'remove', undefined, { content: JSON.stringify({
    convsUser: [user, 12, `g${group}`, null], convsGroupData: [{ retained: true }],
  }) });
  const change = one(control).change;
  assert.equal(change.kind, 'unread-mark-removed'); assert.equal(Object.hasOwn(change, 'groups'), false);
  assert.deepEqual(change.users[0].value, { threadType: 'user', threadId: user });
  assert.deepEqual(change.users[1].value, { threadType: 'user', threadId: '12' });
  assert.equal(Object.hasOwn(change.users[2], 'value'), false); assert.equal(Object.hasOwn(change.users[3], 'value'), false);
  assert.deepEqual(change.raw.convsGroupData, [{ retained: true }]);
  assert.deepEqual(one(row('mark_unread', 'remove', undefined, { content: '{"convsGroup":[],"convsUser":[]}' })).change.groups, []);
  const add = one(row('mark_unread', 'add', undefined, { content: JSON.stringify({ convsUser: [null,
    { id: user }, { id: user, cliMsgId: message, fromUid: 'future-actor', ts: 'future-time' }] }) })).change;
  assert.equal(Object.hasOwn(add.users[0], 'value'), false); assert.equal(Object.hasOwn(add.users[1], 'value'), false);
  assert.deepEqual(add.users[2].value, { threadType: 'user', threadId: user, clientMessageId: message });
});

test('TTL uses milliseconds and numeric timestamps while block sharing has strict numeric flags and no local defaults', () => {
  for (const isGroup of [true, 1, false, 0]) {
    const ttl = one(row('conv_settings', 'update_ttl', { threadId: group, isGroup, ttl: 86400000, ts: 123, isMsgInfo: 1 })).change;
    assert.equal(ttl.kind, 'ttl-updated'); assert.equal(ttl.ttlMilliseconds, 86400000); assert.equal(ttl.timestamp, 123);
    assert.equal(ttl.thread.threadType, isGroup ? 'group' : 'user'); assert.equal(Object.hasOwn(ttl, 'message'), false);
  }
  assert.equal(one(row('conv_settings', 'update_ttl', { threadId: user, isGroup: 0, ttl: 0, ts: 0 })).change.ttlMilliseconds, 0);
  for (const data of [{ threadId: user, isGroup: '0', ttl: 0, ts: 1 }, { threadId: user, isGroup: 0, ttl: -1, ts: 1 },
    { threadId: user, isGroup: 0, ttl: 0, ts: '1' }, { threadId: user, isGroup: 0, ttl: 0, ts: Number.MAX_SAFE_INTEGER + 1 }]) {
    unsupported(row('conv_settings', 'update_ttl', data));
  }
  const data = { threadId: group, isGroup: 1, isEnabled: 1, fromId: 0, ts: 456, isMsgInfo: 1, subAct: 2 };
  const enable = one(row('conv_settings', 'update_block_sharing', data)).change;
  assert.deepEqual(enable, { kind: 'block-sharing-updated', thread: { threadType: 'group', threadId: group },
    enabled: true, fromUserId: '0', timestamp: 456, raw: data });
  assert.equal(Object.hasOwn(enable, 'enabledBySelf'), false); assert.equal(Object.hasOwn(enable, 'message'), false);
  for (const ts of [undefined, 0, -1, '123', NaN]) {
    const disable = one(row('conv_settings', 'update_block_sharing', { threadId: user, isGroup: 0, isEnabled: 0, ts })).change;
    assert.equal(disable.enabled, false); assert.equal(Object.hasOwn(disable, 'timestamp'), false);
    assert.equal(Object.hasOwn(disable, 'fromUserId'), false);
  }
  for (const data of [{ threadId: user, isGroup: false, isEnabled: 1 }, { threadId: user, isGroup: 0, isEnabled: true },
    { threadId: user, isGroup: 2, isEnabled: 1 }, { threadId: user, isGroup: 0, isEnabled: 2 }]) {
    unsupported(row('conv_settings', 'update_block_sharing', data));
  }
});

test('shared frame boundary accepts only successful non-reset 601/603 and does not classify unrelated control families', () => {
  const controls = [row('label_convers', 'update')];
  for (const options of [{ cmd: 603, subCmd: 0 }, { cmd: 603, subCmd: 1 }, { cmd: 601, subCmd: 7 }, { resetLastActionId: 0 }, { resetLastActionId: '0' }]) {
    assert.equal(extractConversationStateEvents(frame(controls, options))[0].change.kind, 'labels-invalidated');
  }
  for (const options of [{ cmd: 614 }, { cmd: 610 }, { version: 2 }, { subCmd: -1 }, { code: '0' },
    { code: 212 }, { transportCode: 212 }, { transportCode: '0' }, { resetLastActionId: revision }]) {
    assert.equal(extractConversationStateEvents(frame(controls, options)), undefined);
  }
  assert.deepEqual(extract([row('my_settings', 'update'), row('voice2text', 'convert_finish'), row('unknown', 'update')]), []);
  assert.deepEqual(extract([{ content: JSON.stringify({ act_type: 'label_convers', act: 'update' }) }, null, {}]), []);
  assert.equal(extractConversationStateEvents(frame(null)), undefined);
  const inheritedStatus = frame(controls); delete inheritedStatus.payload.error_code;
  Object.setPrototypeOf(inheritedStatus.payload, { error_code: 0 }); assert.equal(extractConversationStateEvents(inheritedStatus), undefined);
  const inherited = { content: Object.assign(Object.create({ act_type: 'label_convers' }), { act: 'update' }) };
  assert.deepEqual(extract([inherited]), []);
});

test('all unsupported acts and incomplete known shapes retain selected wrappers rather than fabricating state', () => {
  for (const type of ['mute', 'pinned_convers', 'label_convers', 'archived_chat', 'mark_unread', 'conv_settings']) {
    const control = row(type, 'future-action', { future: [1, 2] }, { content: '{"future":true}' });
    const event = unsupported(control); assert.equal(event.rawControl, control); assert.equal(event.actType, type);
  }
  for (const control of [row('mute', 'set', null), row('archived_chat', 'update', []),
    row('conv_settings', 'update_ttl', { threadId: Number(user), isGroup: 0, ttl: 0, ts: 1 }),
    row('pinned_convers', 'update', { pinIds: [], action: 1, ts: '01' }),
    row('archived_chat', 'update', { version: '1\n' })]) unsupported(control);
  const inherited = Object.assign(Object.create({ toId: user, muteType: 1, duration: -1 }), { extension: true });
  unsupported(row('mute', 'set', inherited));
});

test('own-data descriptors contain accessor failures without invoking them or dropping unrelated known events', () => {
  let reads = 0;
  const accessor = target => Object.defineProperty(target, 'toId', { get() { reads++; throw Error('private-caller-data'); } });
  const data = accessor({ muteType: 1, duration: -1 });
  const values = extract([row('mute', 'set', data), row('label_convers', 'update')]);
  assert.equal(Object.hasOwn(values[0], 'change'), false); assert.equal(values[1].change.kind, 'labels-invalidated'); assert.equal(reads, 0);
  const pin = {}; Object.defineProperty(pin, 'id', { get() { reads++; throw Error('private-entry'); } });
  const hints = one(row('archived_chat', 'update', { version: 2, items: [pin] })).change.items;
  assert.equal(hints[0].raw, pin); assert.equal(Object.hasOwn(hints[0], 'value'), false); assert.equal(reads, 0);
  const selected = row('mute', 'set'); Object.defineProperty(selected.content, 'data', { get() { reads++; throw Error('private-row'); } });
  assert.equal(extract([selected]), undefined); assert.equal(reads, 0);
  const header = frame([]); Object.defineProperty(header, 'cmd', { get() { reads++; throw Error('private-header'); } });
  assert.equal(extractConversationStateEvents(header), undefined); assert.equal(reads, 0);
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('private-descriptor'); } });
  assert.doesNotThrow(() => unsupported(row('mute', 'set', proxy)));
});

test('dense indexed arrays avoid iterators, reject sparse/accessor slots and check bounds before any entry access', () => {
  let reads = 0; let iterated = 0;
  const ids = [`u${user}`]; Object.defineProperty(ids, Symbol.iterator, { value() { iterated++; throw Error('private-iterator'); } });
  const controls = [row('pinned_convers', 'update', { pinIds: ids, action: 1, ts: 1 })];
  Object.defineProperty(controls, Symbol.iterator, { value() { iterated++; throw Error('private-controls-iterator'); } });
  assert.equal(extract(controls)[0].change.entries[0].value.threadId, user); assert.equal(iterated, 0);
  unsupported(row('pinned_convers', 'update', { pinIds: new Array(1), action: 1, ts: 1 }));
  const explicit = one(row('pinned_convers', 'update', { pinIds: [undefined], action: 1, ts: 1 })).change.entries;
  assert.equal(explicit[0].raw, undefined); assert.equal(Object.hasOwn(explicit[0], 'value'), false);
  const accessor = []; Object.defineProperty(accessor, 0, { get() { reads++; throw Error('private-index'); } });
  unsupported(row('pinned_convers', 'update', { pinIds: accessor, action: 1, ts: 1 })); assert.equal(reads, 0);
  const oversized = new Array(20_001); Object.defineProperty(oversized, 0, { get() { reads++; throw Error('private-oversized'); } });
  unsupported(row('pinned_convers', 'update', { pinIds: oversized, action: 1, ts: 1 })); assert.equal(reads, 0);
  assert.equal(extract(oversized), undefined); assert.equal(reads, 0);
});

test('aggregate nested projection budget leaves raw rows intact and permits later constant-size invalidations', () => {
  const ids = Array(20_000).fill(`u${user}`); let reads = 0;
  const later = []; Object.defineProperty(later, 0, { get() { reads++; throw Error('private-budget-entry'); } });
  const controls = [row('pinned_convers', 'update', { pinIds: ids, action: 1, ts: 1 }),
    row('pinned_convers', 'update', { pinIds: later, action: 2, ts: 2 }), row('label_convers', 'update')];
  const values = extract(controls);
  assert.equal(values.length, 3); assert.equal(values[0].change.entries.length, 20_000);
  assert.equal(Object.hasOwn(values[1], 'change'), false); assert.equal(values[1].rawControl, controls[1]);
  assert.equal(values[2].change.kind, 'labels-invalidated'); assert.equal(reads, 0);
});

test('shared string budgets are UTF8-aware, selected-only and preserve raw first-character strings', () => {
  assert.equal(extract([row('label_convers', 'update', '🙂'.repeat(16_385))]), undefined);
  assert.equal(extract([row('label_convers', 'update', 'x'.repeat(65_537))]), undefined);
  assert.equal(extract(Array.from({ length: 17 }, () => row('label_convers', 'update', 'x'.repeat(65_536)))), undefined);
  const controls = [row('my_settings', 'update', 'x'.repeat(1_048_577)), row('label_convers', 'update', 'x'.repeat(65_536))];
  const values = extract(controls); assert.equal(values.length, 1); assert.equal(values[0].change.kind, 'labels-invalidated');
  assert.equal(values[0].rawContent.data, controls[1].content.data);
});
