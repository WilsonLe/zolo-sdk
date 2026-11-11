import { parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
function invalid() { throw new ZaloProtocolError('invalid-response'); }
function identifier(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        return String(value);
    if (typeof value !== 'string' || !value.length || value.length > 128 || /[\s\x00-\x1f\x7f]/.test(value) || value === '0') {
        throw new TypeError('Supply a nonempty confirmed Zalo task identifier.');
    }
    return value;
}
function userId(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        value = String(value);
    if (typeof value !== 'string' || !/^[1-9]\d{0,39}$/.test(value))
        throw new TypeError('Supply Zalo user and group IDs as positive decimal strings.');
    return value;
}
function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new TypeError('Invalid Zalo personal task numeric field.');
    return value;
}
function status(value) {
    if (value !== -1 && value !== 0 && value !== 1)
        throw new TypeError('Choose task status -1, 0, or 1.');
    return value;
}
function dateType(value) { return integer(value, 0, 5); }
function dueDate(value) {
    if (value === -1)
        return -1;
    return integer(value, 1, 8_640_000_000_000_000);
}
function text(value, maximum, required = false) {
    if (typeof value !== 'string' || value.length > maximum || (required && !value.trim()) || /\x00/.test(value))
        throw new TypeError('Invalid Zalo task content or short title.');
    return value;
}
function cursor(value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value))
        throw new TypeError('Invalid Zalo task scroll identifier.');
    return value;
}
function boundary(value) {
    if (typeof value === 'number')
        return integer(value);
    if (typeof value !== 'string' || !/^\d{1,20}$/.test(value))
        throw new TypeError('Supply a Zalo task update boundary as a nonnegative integer or decimal string.');
    return value;
}
function ids(values, requireOne = false) {
    if (!Array.isArray(values) || values.length > 100 || (requireOne && !values.length))
        throw new TypeError('Supply up to one hundred task participant IDs, including at least one assignee.');
    const result = Array.from(values, userId);
    if (new Set(result).size !== result.length)
        throw new TypeError('Supply distinct task participant IDs.');
    return result;
}
function schedule(value) {
    if (value === null)
        return null;
    const fields = requireProtocolObject(value);
    const startTime = dueDate(fields.startTime);
    if (startTime < 1 || startTime > 8_640_000_000_000_000 - 1000)
        throw new TypeError('Invalid Zalo task schedule start.');
    const endTime = fields.endTime === -1 ? -1 : integer(fields.endTime, startTime + 1, 8_640_000_000_000_000);
    if (typeof fields.repeat !== 'string' || fields.repeat.length > 1024 || !fields.repeat.trim() || /[\x00-\x1f\x7f]/.test(fields.repeat))
        throw new TypeError('Supply the verified provider task repeat expression.');
    return { startTime, endTime, repeat: fields.repeat };
}
function objectField(value) {
    return requireProtocolObject(typeof value === 'string' ? parseProtocolJson(value) : value);
}
function assignees(value) {
    if (typeof value === 'string' && value)
        value = parseProtocolJson(value);
    if (value === null || value === '')
        return [];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const entries = Object.entries(requireProtocolObject(value));
        if (entries.length > 100)
            return invalid();
        value = entries.map(([id, entry]) => ({ ...requireProtocolObject(entry), userId: userId(id) }));
    }
    if (!Array.isArray(value) || value.length > 100)
        return invalid();
    return Array.from(value, (entry) => {
        if (typeof entry === 'string' || typeof entry === 'number')
            return { userId: userId(entry) };
        const row = requireProtocolObject(entry);
        return { ...row, userId: userId(row.userId ?? row.id ?? row.uid), ...(row.status === undefined ? {} : { status: status(row.status) }) };
    });
}
function watchers(value) {
    if (typeof value === 'string' && value)
        value = parseProtocolJson(value);
    if (value === null || value === '')
        return [];
    if (!Array.isArray(value) || value.length > 100)
        return invalid();
    return ids(value.map((entry) => {
        if (typeof entry === 'string' || typeof entry === 'number')
            return userId(entry);
        const row = requireProtocolObject(entry);
        return userId(row.userId ?? row.id ?? row.uid);
    }));
}
function responseSchedule(value) {
    if (value === null)
        return null;
    const row = requireProtocolObject(value);
    // The installed editor treats an empty schedule object as an inactive reminder.
    if (!row.startTime && !row.repeat)
        return null;
    return schedule(row);
}
function task(value) {
    try {
        const raw = requireProtocolObject(value);
        const result = { ...raw, id: identifier(raw.id) };
        if (raw.content !== undefined)
            result.content = text(raw.content, 2000);
        if (raw.description !== undefined)
            result.description = text(raw.description, 100);
        if (raw.creator !== undefined)
            result.creator = userId(raw.creator);
        if (raw.assignees !== undefined)
            result.assignees = assignees(raw.assignees);
        if (raw.watchers !== undefined)
            result.watchers = watchers(raw.watchers);
        if (raw.dueDate !== undefined || raw.due_date !== undefined) {
            const date = raw.dueDate ?? raw.due_date;
            result.dueDate = date === 0 ? 0 : dueDate(date);
        }
        if (raw.dateDefaultType !== undefined || raw.date_default_type !== undefined)
            result.dateDefaultType = dateType(raw.dateDefaultType ?? raw.date_default_type);
        if (raw.status !== undefined)
            result.status = status(raw.status);
        if (raw.extra !== undefined && raw.extra !== null)
            result.extra = objectField(raw.extra);
        if (raw.schedule !== undefined)
            result.schedule = responseSchedule(raw.schedule);
        return result;
    }
    catch {
        return invalid();
    }
}
function origin(value) {
    if (value === undefined)
        return {};
    if (!value || (value.threadType !== 'direct' && value.threadType !== 'group'))
        throw new TypeError('Supply an existing direct or group message origin for the task.');
    const toUid = userId(value.threadType === 'group' ? value.threadId.replace(/^g/, '') : value.threadId);
    const msgId = userId(value.messageId);
    return { msgId, toUid, isGroup: value.threadType === 'group', cliMsgId: userId(value.clientMessageId),
        msgType: integer(value.messageType), ownerMsgUId: userId(value.senderId) };
}
function fields(content, description, assigneeIds, watcherIds, date, dateHint, taskStatus, extra, reminder) {
    const due = dueDate(date);
    const hint = dateType(dateHint);
    if ((hint === 0) !== (due === -1))
        throw new TypeError('Use date type zero with no due date, or a dated type with a positive due date.');
    // These fields are serialized separately by the shipped Todo manager/fetcher.
    return { content: text(content, 2000, true), description: text(description, 100),
        assignees: JSON.stringify(ids(assigneeIds, true)), watchers: JSON.stringify(ids(watcherIds)),
        dueDate: due, dateDefaultType: hint, status: status(taskStatus), extra: JSON.stringify(extra),
        schedule: schedule(reminder) };
}
/** Creates a personal task, optionally referring to an already submitted chat message. */
export async function createPersonalTask(api, input) {
    const source = integer(input.source ?? -1, -1, 8);
    if (source === 0)
        throw new TypeError('Use source -1 or an installed attribution code from 1 through 8.');
    const assigned = ids(input.assigneeIds, true);
    const chosenStatus = input.status ?? (assigned.includes(api.getOwnId()) ? 0 : -1);
    if (chosenStatus !== -1 && chosenStatus !== 0)
        throw new TypeError('A new task starts waiting or in progress.');
    const date = input.dueDate ?? -1;
    const params = fields(input.content, input.description ?? '', assigned, input.watcherIds ?? [], date, input.dateDefaultType ?? (date === -1 ? 0 : 5), chosenStatus, origin(input.origin), input.schedule ?? null);
    return task(await protocolRequest(api, { service: 'boards', path: '/api/board/personal/todo/create', method: 'POST',
        params: { ...params, src: source }, includeImei: true, redirect: 'error', signal: input.signal }));
}
/** Updates an existing fetched task while preserving its provider origin metadata. */
export async function updatePersonalTask(api, current, changes) {
    const existing = task(current);
    const extra = { ...(existing.extra ?? {}) };
    delete extra.z_parsedTokens;
    delete extra.msg_id;
    delete extra.message;
    const legacyUndated = changes.dueDate === undefined && existing.dueDate === 0;
    const date = changes.dueDate ?? (legacyUndated ? -1 : existing.dueDate ?? -1);
    const params = fields(changes.content ?? existing.content, changes.description ?? existing.description ?? '', changes.assigneeIds ?? existing.assignees?.map((value) => value.userId) ?? [], changes.watcherIds ?? existing.watchers ?? [], date, changes.dateDefaultType ?? (legacyUndated ? 0 : changes.dueDate === undefined ? existing.dateDefaultType : undefined) ?? (date === -1 ? 0 : 5), changes.status ?? existing.status, extra, changes.schedule === undefined ? existing.schedule ?? null : changes.schedule);
    return task(await protocolRequest(api, { service: 'boards', path: '/api/board/personal/todo/update', method: 'POST',
        params: { id: existing.id, ...params, creator: userId(existing.creator) }, redirect: 'error', signal: changes.signal }));
}
/** Fetches one task's current provider record. */
export async function getPersonalTask(api, id, signal) {
    return task(await protocolRequest(api, { service: 'boards', path: '/api/board/personal/get',
        params: { id: identifier(id) }, includeImei: true, redirect: 'error', signal }));
}
export async function deletePersonalTask(api, id, signal) {
    await protocolRequest(api, { service: 'boards', path: '/api/board/personal/delete',
        params: { id: identifier(id) }, allowEmpty: true, redirect: 'error', signal });
}
/** Updates the authenticated assignee's status. The provider enforces task permissions. */
export async function setPersonalTaskStatus(api, id, value, signal) {
    await protocolRequest(api, { service: 'boards', path: '/api/board/personal/todo/status',
        params: { id: identifier(id), status: status(value) }, includeImei: true, allowEmpty: true, redirect: 'error', signal });
}
/** Submits only the observed list filters, retaining unevidenced response fields for inspection. */
export async function listPersonalTasks(api, options = {}) {
    const role = options.role ?? 'all';
    if (!['all', 'creator', 'assignees', 'watchers'].includes(role))
        throw new TypeError('Invalid personal task role filter.');
    const queries = options.role === undefined && options.status === 'done' ? {} : { role };
    if (options.status === 'unfinished')
        queries.status = { lt: 1 };
    else if (options.status === 'done')
        queries.status = { eq: 1 };
    else if (options.status !== undefined)
        throw new TypeError('Choose unfinished or done task status.');
    if ([options.groupId, options.creatorId, options.assigneeId].filter((value) => value !== undefined).length > 1)
        throw new TypeError('Use one personal task conversation selector.');
    if (options.groupId !== undefined) {
        queries['extra.toUid'] = { eq: userId(options.groupId.replace(/^g/, '')) };
        queries['extra.isGroup'] = { eq: true };
    }
    if (options.creatorId !== undefined)
        queries.creator = userId(options.creatorId);
    if (options.assigneeId !== undefined)
        queries.assignees = userId(options.assigneeId);
    const kind = options.type ?? 'tasks';
    if (!['tasks', 'finished-tasks', 'all'].includes(kind))
        throw new TypeError('Invalid personal task list type.');
    const result = requireProtocolObject(await protocolRequest(api, { service: 'boards', path: '/api/board/personal/list',
        params: { scrollId: cursor(options.scrollId ?? ''), offset: integer(options.offset ?? 0), limit: integer(options.limit ?? 20, 1, 100),
            queries: JSON.stringify(queries), type: kind === 'tasks' ? 1 : kind === 'finished-tasks' ? 2 : 0 }, redirect: 'error', signal: options.signal }));
    if (result.totalItems !== undefined && (typeof result.totalItems !== 'number' || !Number.isSafeInteger(result.totalItems) || result.totalItems < 0))
        return invalid();
    return { ...(result.totalItems === undefined ? {} : { totalItems: result.totalItems }), raw: result };
}
/** Fetches one change page. Persist it before advancing the returned scroll ID. */
export async function getPersonalTaskChanges(api, options = {}) {
    const previous = cursor(options.scrollId ?? '');
    const result = requireProtocolObject(await protocolRequest(api, { service: 'boards', path: '/api/board/personal/todo/verify',
        params: { scrollId: previous, lastUpdatedTime: boundary(options.lastUpdatedTime ?? 0) }, includeImei: true, redirect: 'error', signal: options.signal }));
    try {
        const updated = result.updated ?? [];
        const deleted = result.deleted ?? [];
        if (!Array.isArray(updated) || !Array.isArray(deleted) || updated.length > 10_000 || deleted.length > 10_000)
            return invalid();
        const page = {
            scrollId: cursor(result.scrollId ?? ''), updated: updated.map(task),
            deleted: deleted.map((value) => {
                if (typeof value === 'string' || typeof value === 'number')
                    return { id: identifier(value) };
                const row = requireProtocolObject(value);
                return { ...row, id: identifier(row.id), ...(row.ts === undefined ? {} : { ts: boundary(row.ts) }) };
            }), complete: updated.length === 0 && deleted.length === 0,
            ...(result.timestamp === undefined ? {} : { timestamp: boundary(result.timestamp) }),
        };
        return page;
    }
    catch {
        return invalid();
    }
}
function taskIds(values) {
    if (!Array.isArray(values) || !values.length || values.length > 100)
        throw new TypeError('Supply one to one hundred task IDs.');
    const result = Array.from(values, identifier);
    if (new Set(result).size !== result.length)
        throw new TypeError('Supply distinct task IDs.');
    return result;
}
/** Explicitly nudges task assignees through the installed ding operation. */
export async function remindPersonalTasks(api, ids, signal) {
    await protocolRequest(api, { service: 'boards', path: '/api/board/personal/todo/ding', params: { taskIds: taskIds(ids) },
        allowEmpty: true, redirect: 'error', signal });
}
/** Explicitly acknowledges received task nudges. */
export async function acknowledgePersonalTaskReminders(api, ids, signal) {
    await protocolRequest(api, { service: 'boards', path: '/api/board/personal/todo/dingack', params: { taskIds: taskIds(ids) },
        allowEmpty: true, redirect: 'error', signal });
}
