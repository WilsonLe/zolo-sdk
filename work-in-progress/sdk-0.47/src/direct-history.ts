import type { API } from '#zca';
import { readProtocolResponse, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';

export interface DirectMessageQueueCursor {
  readonly lastActionId: string;
  readonly lastActionIdOther: string;
  readonly queues: Readonly<Record<string, { readonly lastId: string; readonly ids: readonly string[] }>>;
}

export interface DirectMessageQueueOptions {
  /** Resume the account-wide queue from the preceding page. */
  cursor?: DirectMessageQueueCursor;
  /** Locally filter messages to this direct thread. The cursor still advances across the account. */
  threadId?: string;
  signal?: AbortSignal;
}

export interface DirectQueuedMessage {
  threadId: string;
  messageId: string;
  isSelf: boolean;
  data: ProtocolData;
}

export interface DirectMessageQueuePage {
  messages: DirectQueuedMessage[];
  cursor: DirectMessageQueueCursor;
  /** These queues report dropped entries. A returned page cannot recover those entries. */
  evictedQueues: string[];
  /** The server requested a cursor reset. The next poll should use the returned cursor. */
  reset: boolean;
}

type QueueRequest = DirectMessageQueueOptions & { cursor: DirectMessageQueueCursor };
const methodName = '__zaloPersonalSdkDirectMessageQueue';
const bound = new WeakMap<API, (request: QueueRequest) => Promise<DirectMessageQueuePage>>();
const polling = new WeakSet<API>();
const idPattern = /^\d{1,40}$/;

function wireId(value: unknown): string | undefined {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === 'string' && idPattern.test(id) ? id : undefined;
}

function requireInputId(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) {
    throw new TypeError('Supply queue and conversation IDs as decimal strings.');
  }
  return value;
}

function largerId(left: string, right: string | undefined): string {
  return right !== undefined && BigInt(right) > BigInt(left) ? right : left;
}

function snapshotCursor(cursor?: DirectMessageQueueCursor): DirectMessageQueueCursor {
  if (!cursor) {
    return {
      lastActionId: '1',
      lastActionIdOther: '1',
      queues: Object.fromEntries(['1', '2', '3'].map((queue) => [queue, { lastId: '1', ids: [] }])),
    };
  }
  return {
    lastActionId: requireInputId(cursor.lastActionId),
    lastActionIdOther: requireInputId(cursor.lastActionIdOther),
    queues: Object.fromEntries(Object.entries(cursor.queues).map(([key, value]) => {
      if (!/^\d{1,8}$/.test(key) || !Array.isArray(value.ids) || value.ids.length > 10) {
        throw new TypeError('Supply a cursor returned by the direct message queue.');
      }
      return [key, { lastId: requireInputId(value.lastId), ids: value.ids.map(requireInputId) }];
    })),
  };
}

function nextIds(previous: readonly string[], incoming: unknown): string[] {
  if (incoming != null && !Array.isArray(incoming)) throw new ZaloProtocolError('invalid-response');
  const ids = (incoming as unknown[] | undefined)?.map(wireId).filter((id): id is string => id !== undefined) ?? [];
  return [...new Set([...previous, ...ids])]
    .sort((left, right) => left === right ? 0 : BigInt(left) < BigInt(right) ? -1 : 1)
    .slice(-10);
}

function directMessages(value: unknown, uid: string, thread?: string): DirectQueuedMessage[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ZaloProtocolError('invalid-response');
  return value.flatMap((message) => {
    const data = requireProtocolObject(message);
    const sender = wireId(data.uidFrom);
    const recipient = wireId(data.idTo);
    const messageId = wireId(data.msgId);
    const isSelf = sender === '0' || sender === uid;
    const threadId = isSelf ? (recipient === '0' ? uid : recipient) : sender;
    if (!threadId || !messageId) throw new ZaloProtocolError('invalid-response');
    return thread === undefined || thread === threadId ? [{ threadId, messageId, isSelf, data }] : [];
  });
}

function queuePage(value: unknown, cursor: DirectMessageQueueCursor, uid: string, thread?: string): DirectMessageQueuePage {
  if (value == null) return { messages: [], cursor, evictedQueues: [], reset: false };
  const payload = requireProtocolObject(value);
  const resetId = wireId(payload.resetLastActionId);
  if (resetId && resetId !== '0') {
    return {
      messages: [],
      cursor: {
        lastActionId: resetId,
        lastActionIdOther: '1',
        queues: Object.fromEntries(Object.keys(cursor.queues).map((key) => [key, { lastId: resetId, ids: [] }])),
      },
      evictedQueues: [],
      reset: true,
    };
  }

  const queues = { ...cursor.queues };
  const evictedQueues: string[] = [];
  const status = payload.queueStatus == null ? {} : requireProtocolObject(payload.queueStatus);
  for (const [key, item] of Object.entries(status)) {
    if (!/^\d{1,8}$/.test(key) || item == null) continue;
    const state = requireProtocolObject(item);
    if (state.evict === 1 || state.evict === '1' || state.evict === true) evictedQueues.push(key);
    const returnedLastId = wireId(state.lastId);
    if (returnedLastId === undefined || returnedLastId === '0') continue;
    const previous = queues[key];
    const lastId = largerId(previous?.lastId ?? '1', returnedLastId);
    queues[key] = { lastId, ids: nextIds(previous?.ids ?? [], state.ids) };
  }

  return {
    messages: directMessages(payload.msgs, uid, thread),
    cursor: {
      lastActionId: largerId(cursor.lastActionId, wireId(payload.lastActionId)),
      lastActionIdOther: largerId(cursor.lastActionIdOther, wireId(payload.lastActionIdOther)),
      queues,
    },
    evictedQueues,
    reset: false,
  };
}

function endpointFor(value: unknown): URL {
  if (!Array.isArray(value)) throw new ZaloProtocolError('unsupported-service');
  const base: unknown = value[0];
  if (typeof base !== 'string') throw new ZaloProtocolError('unsupported-service');
  let endpoint: URL;
  try { endpoint = new URL(base); } catch { throw new ZaloProtocolError('unsupported-service'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ZaloProtocolError('unsupported-service');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/';
  return endpoint;
}

function bind(api: API) {
  const existing = bound.get(api);
  if (existing) return existing;
  api.custom<DirectMessageQueuePage, QueueRequest>(methodName, async ({ ctx, utils, props }) => {
    if (props.signal?.aborted) throw new ZaloProtocolError('aborted');
    if (ctx.settings.features.socket.disable_lp === true) throw new ZaloProtocolError('unsupported-service');
    const endpoint = endpointFor(ctx.loginInfo.zpw_chts_new);
    const { cursor } = props;
    const feature = ctx.settings.features.enable_polling_last_action;
    const includeIds = feature === undefined || Boolean(feature);
    const wireQueues = Object.fromEntries(Object.entries(cursor.queues).map(([queue, state]) => [
      queue,
      { lastId: state.lastId, ids: includeIds ? state.ids.filter((id) => BigInt(id) <= BigInt(state.lastId)) : [] },
    ]));
    const queueState = Buffer.from(JSON.stringify(wireQueues)).toString('base64');
    const params = `${cursor.lastActionId},${cursor.lastActionIdOther},${encodeURIComponent(queueState + ',1')}`;
    const url = `${utils.makeURL(endpoint.toString())}&params=${params}&ts=${Math.round(Date.now() / 1000)}`;
    const timeout = AbortSignal.timeout(60_000);
    const signal = props.signal ? AbortSignal.any([props.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await utils.request(url, { method: 'GET', signal, redirect: 'error' });
    } catch {
      throw new ZaloProtocolError(props.signal?.aborted ? 'aborted' : 'request-failed');
    }
    if (response.status !== 200) throw new ZaloProtocolError('request-failed', response.status);
    const data = await readProtocolResponse(response, ctx.secretKey, 'polling', signal);
    return queuePage(data, cursor, ctx.uid, props.threadId);
  });
  const request = (api as API & Record<typeof methodName, (props: QueueRequest) => Promise<DirectMessageQueuePage>>)[methodName];
  bound.set(api, request);
  return request;
}

/** Fetch one page of the account's direct-message recovery queue over the advertised long-poll fallback. */
export async function getDirectMessageQueuePage(api: API, options: DirectMessageQueueOptions = {}): Promise<DirectMessageQueuePage> {
  const cursor = snapshotCursor(options.cursor);
  const threadId = options.threadId === undefined ? undefined : requireInputId(options.threadId);
  if (polling.has(api)) throw new Error('A direct message queue poll is already in progress on this Zalo API.');
  polling.add(api);
  try {
    return await bind(api)({ cursor, threadId, signal: options.signal });
  } finally {
    polling.delete(api);
  }
}
