import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { CookieJar } from 'tough-cookie';
import { API } from 'zca-js';
import {
  acknowledgePersonalTaskReminders, createPersonalTask, deletePersonalTask, getPersonalTask,
  getPersonalTaskChanges, listPersonalTasks, remindPersonalTasks, setPersonalTaskStatus, updatePersonalTask,
} from '../dist/personal-tasks.js';

const key = Buffer.alloc(32, 66);
const self = '9300000000000000501';
const peer = '9300000000000000502';
const group = '9300000000000000503';
const taskId = '9300000000000000504';
const messageId = '9300000000000000505';
const time = 1700000000000;
const row = () => ({ id: JSON.rawJSON(taskId), creator: self, content: 'Synthetic task body', description: 'Short title',
  assignees: [{ userId: peer, status: -1 }], watchers: [self], dueDate: -1, dateDefaultType: 0, status: -1,
  extra: { msgId: messageId, cliMsgId: '1700000000001', toUid: group, isGroup: true, ownerMsgUId: self, msgType: 1 }, schedule: null });

function encrypted(data, error_code = 0) {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ error_code, data })), cipher.final()]);
  return Response.json({ error_code: 0, data: encodeURIComponent(bytes.toString('base64')) });
}
function fixture(respond = () => encrypted(row()), available = true) {
  const requests = [];
  const api = new API({
    API_TYPE: 30, API_VERSION: 695, uid: self, imei: 'fixture-imei', language: 'en', userAgent: 'fixture-UA',
    secretKey: key.toString('base64'), cookie: new CookieJar(), settings: { features: { socket: { retries: {} } } },
    options: { logging: false, async polyfill(input, init) {
      const url = new URL(input);
      assert.equal(init.redirect, 'error');
      const encoded = init.method === 'POST' ? init.body.get('params') : url.searchParams.get('params');
      if (init.method === 'POST') assert.deepEqual([...init.body.keys()], ['params']);
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      const params = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encoded, 'base64')), decipher.final()]).toString());
      const request = { service: url.hostname.split('.')[0], path: url.pathname, method: init.method, params };
      requests.push(request);
      return respond(request, requests.length, init);
    } },
  }, new Proxy({}, { get: (_, service) => service === 'boards' && !available ? undefined : [`https://${service}.fixture.zalo.me`] }), ['wss://socket.fixture.zalo.me']);
  return { api, requests };
}

test('creates a task with exact participant/metadata serialization and updates a fetched record without losing its origin', async () => {
  const { api, requests } = fixture();
  const input = { content: 'Synthetic task body', description: 'Short title', assigneeIds: [peer], watcherIds: [self],
    origin: { threadType: 'group', threadId: `g${group}`, messageId, clientMessageId: '1700000000001', senderId: self, messageType: 1 } };
  const created = await createPersonalTask(api, input);
  assert.equal(created.id, taskId);
  assert.deepEqual(created.assignees, [{ userId: peer, status: -1 }]);
  assert.deepEqual(requests[0], { service: 'boards', path: '/api/board/personal/todo/create', method: 'POST', params: {
    content: input.content, description: input.description, assignees: JSON.stringify([peer]), watchers: JSON.stringify([self]),
    dueDate: -1, dateDefaultType: 0, status: -1, extra: JSON.stringify({ msgId: messageId, toUid: group, isGroup: true,
      cliMsgId: '1700000000001', msgType: 1, ownerMsgUId: self }), schedule: null, src: -1, imei: 'fixture-imei',
  } });
  const current = { ...created, updateTime: time, extra: { ...created.extra, customProviderFlag: 7,
    z_parsedTokens: { local: true }, msg_id: 'local-only', message: 'local-copy' } };
  const snapshot = structuredClone(current);
  const schedule = { startTime: time, endTime: -1, repeat: '0 0 9 * * ? * | 1 d' };
  await updatePersonalTask(api, current, { description: 'Edited title', assigneeIds: [self], watcherIds: [],
    dueDate: time, status: 0, schedule });
  assert.deepEqual(current, snapshot);
  const updated = requests[1];
  assert.deepEqual(updated, { service: 'boards', path: '/api/board/personal/todo/update', method: 'POST', params: {
    id: taskId, content: input.content, description: 'Edited title', assignees: JSON.stringify([self]), watchers: '[]',
    dueDate: time, dateDefaultType: 5, status: 0, extra: JSON.stringify({ ...created.extra, customProviderFlag: 7 }),
    schedule, creator: self,
  } });
  assert.equal(updated.params.updateTime, undefined);
  assert.equal(updated.params.imei, undefined);
});

test('defaults a self-assigned task to in-progress and preserves the separate GET contracts for detail, status, delete, ding and ack', async () => {
  const { api, requests } = fixture(({ path }) => path.endsWith('/get') || path.endsWith('/create')
    ? encrypted({ ...row(), extra: JSON.stringify(row().extra) }) : Response.json({ error_code: 0, data: '' }));
  await createPersonalTask(api, { content: 'Self task', assigneeIds: [self] });
  assert.equal(requests[0].params.status, 0);
  assert.equal(requests[0].params.extra, '{}');
  assert.equal((await getPersonalTask(api, taskId)).extra.toUid, group);
  await setPersonalTaskStatus(api, taskId, 1);
  await deletePersonalTask(api, taskId);
  await remindPersonalTasks(api, [taskId]);
  await acknowledgePersonalTaskReminders(api, [taskId]);
  assert.deepEqual(requests.slice(1), [
    { service: 'boards', path: '/api/board/personal/get', method: 'GET', params: { id: taskId, imei: 'fixture-imei' } },
    { service: 'boards', path: '/api/board/personal/todo/status', method: 'GET', params: { id: taskId, status: 1, imei: 'fixture-imei' } },
    { service: 'boards', path: '/api/board/personal/delete', method: 'GET', params: { id: taskId } },
    { service: 'boards', path: '/api/board/personal/todo/ding', method: 'GET', params: { taskIds: [taskId] } },
    { service: 'boards', path: '/api/board/personal/todo/dingack', method: 'GET', params: { taskIds: [taskId] } },
  ]);
});

test('serializes installed list role/status/conversation queries without inventing a list item layout', async () => {
  const { api, requests } = fixture(() => encrypted({ totalItems: 9, providerOnly: { opaque: true } }));
  assert.deepEqual(await listPersonalTasks(api, { role: 'creator', status: 'unfinished', groupId: `g${group}`, limit: 1 }),
    { totalItems: 9, raw: { totalItems: 9, providerOnly: { opaque: true } } });
  assert.deepEqual(requests[0], { service: 'boards', path: '/api/board/personal/list', method: 'GET', params: {
    scrollId: '', offset: 0, limit: 1, queries: JSON.stringify({ role: 'creator', status: { lt: 1 },
      'extra.toUid': { eq: group }, 'extra.isGroup': { eq: true } }), type: 1,
  } });
  await listPersonalTasks(api, { role: 'assignees', creatorId: peer, status: 'done', scrollId: 'opaque-scroll', offset: 20, type: 'finished-tasks' });
  assert.deepEqual(requests[1].params, { scrollId: 'opaque-scroll', offset: 20, limit: 20,
    queries: JSON.stringify({ role: 'assignees', status: { eq: 1 }, creator: peer }), type: 2 });
  await listPersonalTasks(api, { role: 'creator', assigneeId: peer, type: 'all' });
  assert.deepEqual(JSON.parse(requests[2].params.queries), { role: 'creator', assignees: peer });
  assert.equal(requests[2].params.type, 0);
  await listPersonalTasks(api, { status: 'done' });
  assert.deepEqual(JSON.parse(requests[3].params.queries), { status: { eq: 1 } });
});

test('reads typed change pages and retains a fixed update boundary until an empty terminal page', async () => {
  const removed = '9300000000000000506';
  const { api, requests } = fixture((_, count) => encrypted(count === 1
    ? { scrollId: 'next-scroll', timestamp: time + 100, updated: [row()], deleted: [{ id: JSON.rawJSON(removed), ts: time }] }
    : { scrollId: 'next-scroll', timestamp: time + 101, updated: [], deleted: [] }));
  const first = await getPersonalTaskChanges(api, { lastUpdatedTime: String(time - 1) });
  assert.equal(first.complete, false);
  assert.equal(first.updated[0].id, taskId);
  assert.deepEqual(first.deleted, [{ id: removed, ts: time }]);
  const last = await getPersonalTaskChanges(api, { scrollId: first.scrollId, lastUpdatedTime: String(time - 1) });
  assert.equal(last.complete, true);
  assert.equal(last.timestamp, time + 101);
  assert.deepEqual(requests.map(({ params }) => params), [
    { scrollId: '', lastUpdatedTime: String(time - 1), imei: 'fixture-imei' },
    { scrollId: 'next-scroll', lastUpdatedTime: String(time - 1), imei: 'fixture-imei' },
  ]);
});

test('rejects invalid domain input before requests and surfaces provider/transport failures without replay', async () => {
  const { api, requests } = fixture();
  const valid = { content: 'body', assigneeIds: [self] };
  for (const input of [
    { ...valid, content: '' }, { ...valid, content: 'x'.repeat(2001) }, { ...valid, description: 'x'.repeat(101) },
    { ...valid, assigneeIds: [] }, { ...valid, watcherIds: [self, self] }, { ...valid, dueDate: 0 },
    { ...valid, dueDate: -1, dateDefaultType: 5 }, { ...valid, status: 1 }, { ...valid, source: 0 },
    { ...valid, schedule: { startTime: time, endTime: time, repeat: '0 0 9 * * ? *' } },
  ]) await assert.rejects(createPersonalTask(api, input));
  await assert.rejects(listPersonalTasks(api, { creatorId: self, groupId: group }));
  await assert.rejects(listPersonalTasks(api, { limit: 101 }));
  await assert.rejects(remindPersonalTasks(api, [taskId, taskId]));
  await assert.rejects(setPersonalTaskStatus(api, taskId, 2));
  assert.equal(requests.length, 0);
  const refused = fixture(() => encrypted(null, 166));
  await assert.rejects(createPersonalTask(refused.api, valid), { code: 'request-failed', providerCode: 166 });
  assert.equal(refused.requests.length, 1);
  const unknown = fixture(() => { throw Error('private synthetic task body'); });
  await assert.rejects(createPersonalTask(unknown.api, valid), error => {
    assert.equal(error.code, 'request-failed');
    assert.doesNotMatch(error.message, /private|synthetic/);
    return true;
  });
  assert.equal(unknown.requests.length, 1);
  const missing = fixture(undefined, false);
  await assert.rejects(createPersonalTask(missing.api, valid), { code: 'unsupported-service' });
  assert.equal(missing.requests.length, 0);
  await assert.rejects(createPersonalTask(api, { ...valid, signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(requests.length, 0);
});

test('rejects malformed task and change responses while accepting safe numeric participant IDs', async () => {
  const numeric = fixture(() => encrypted({ id: 123, creator: 2, assignees: [{ id: 3, status: 0 }, 4], watchers: [], extra: null }));
  const task = await getPersonalTask(numeric.api, '123');
  assert.deepEqual([task.id, task.creator, task.assignees[0].userId], ['123', '2', '3']);
  assert.deepEqual(task.assignees[1], { userId: '4' });
  assert.equal(task.extra, null);
  const terminal = fixture(() => encrypted({ updated: [], deleted: [] }));
  assert.equal((await getPersonalTaskChanges(terminal.api, { scrollId: 'previous-scroll' })).scrollId, '');
  for (const data of [{ updated: {}, deleted: [] }, { updated: [], deleted: [{ id: taskId, ts: -1 }] },
    { updated: [{ id: taskId, assignees: false }], deleted: [] },
    { updated: [{ id: taskId, watchers: '[' }], deleted: [] }]) {
    const invalid = fixture(() => encrypted(data));
    await assert.rejects(getPersonalTaskChanges(invalid.api), { code: 'invalid-response' });
  }
});

test('edits historical task records with JSON or mapped assignees, object watchers, zero due date and inactive schedules', async () => {
  for (const assignees of [
    JSON.stringify({ [peer]: { status: -1, providerParticipantFlag: 2 } }),
    { [peer]: { status: -1, providerParticipantFlag: 2 } },
    JSON.stringify([{ uid: peer, status: -1, providerParticipantFlag: 2 }]),
  ]) {
    const legacy = { ...row(), assignees, watchers: [{ id: self }], dueDate: 0, dateDefaultType: 5, schedule: {},
      extra: JSON.stringify({ ...row().extra, retainedOriginFlag: 1 }) };
    const { api, requests } = fixture((_, count) => encrypted(count === 1 ? legacy : row()));
    const current = await getPersonalTask(api, taskId);
    assert.equal(current.dueDate, 0);
    assert.equal(current.schedule, null);
    assert.equal(current.assignees[0].status, -1);
    assert.equal(current.assignees[0].providerParticipantFlag, 2);
    assert.deepEqual(current.watchers, [self]);
    await updatePersonalTask(api, current, { content: 'Edited historical task' });
    assert.deepEqual([requests[1].params.dueDate, requests[1].params.dateDefaultType], [-1, 0]);
    assert.deepEqual(JSON.parse(requests[1].params.assignees), [peer]);
    assert.equal(JSON.parse(requests[1].params.extra).retainedOriginFlag, 1);
    assert.equal(current.assignees[0].status, -1);
    await assert.rejects(updatePersonalTask(api, current, { dateDefaultType: 5 }), TypeError);
    assert.equal(requests.length, 2);
  }
});

test('normalizes JSON-encoded watcher IDs and objects through detail, verification and ordinary edits', async () => {
  for (const watchers of [JSON.stringify([self]), JSON.stringify([{ id: self }])]) {
    const legacy = { ...row(), watchers };
    const { api, requests } = fixture(({ path }) => encrypted(path.endsWith('/verify')
      ? { scrollId: 'watcher-page', timestamp: time, updated: [legacy], deleted: [] }
      : path.endsWith('/update') ? row() : legacy));
    const current = await getPersonalTask(api, taskId);
    assert.deepEqual(current.watchers, [self]);
    const page = await getPersonalTaskChanges(api);
    assert.deepEqual(page.updated[0].watchers, [self]);
    await updatePersonalTask(api, page.updated[0], { content: 'Edited task with encoded watchers' });
    assert.equal(requests[2].params.watchers, JSON.stringify([self]));
    assert.equal(current.assignees[0].status, -1);
    assert.equal(JSON.parse(requests[2].params.extra).msgId, messageId);
    assert.equal(requests.length, 3);
  }
});

test('reads historical empty and null participant fields and updates them with an explicitly selected assignee', async () => {
  for (const empty of ['', null, 'null', '""']) {
    const legacy = { ...row(), assignees: empty, watchers: empty };
    const { api, requests } = fixture(({ path }) => encrypted(path.endsWith('/verify')
      ? { updated: [legacy], deleted: [] } : path.endsWith('/update') ? row() : legacy));
    const current = await getPersonalTask(api, taskId);
    assert.deepEqual([current.assignees, current.watchers], [[], []]);
    const page = await getPersonalTaskChanges(api);
    assert.deepEqual([page.updated[0].assignees, page.updated[0].watchers], [[], []]);
    await updatePersonalTask(api, page.updated[0], { assigneeIds: [peer], content: 'Edited historical empty participants' });
    assert.equal(requests[2].params.assignees, JSON.stringify([peer]));
    assert.equal(requests[2].params.watchers, '[]');
  }
});
