import type { API } from '#zca';
import { parseProtocolJson, protocolRequest, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData as Data, ProtocolRequest } from './protocol-request.js';
import { getSavedMessagesThread } from './saved-messages.js';

export interface ConversationPreviewCursors {
  /** Direct thread ID -> latest local message ID. Use strings for both IDs. */
  users?: Readonly<Record<string, string>>;
  /** Group thread ID -> latest local message ID. */
  groups?: Readonly<Record<string, string>>;
}

export interface ConversationPreviews {
  msgs: Data[];
  groupMsgs: Data[];
  pageMsgs: Data[];
  clearUnreads?: unknown;
  clearUnreadsReact?: unknown;
  seens?: unknown;
}

interface CloudMessagePage {
  groupMsgs: Data[];
  hasMore?: boolean;
  lastMsgId?: string;
}

export interface GroupCloudHistoryPage extends CloudMessagePage {
  isOld?: boolean;
  minMsgId?: string;
  maxMsgId?: string;
}

export type GroupCloudHistoryRequest = {
  count?: number;
  excludeMessageIds?: readonly string[];
} & (
  | { mode?: 'page'; cursor?: { messageId: string; isOld: boolean } }
  | { mode: 'jump'; messageId: string }
  | { mode: 'newer'; messageId: string }
);

export interface GroupCloudThreadPageRequest {
  anchor:
    | { messageId: string; ownerId: string; clientMessageId: string }
    | { messageId: string; ownerId: null; clientMessageId: null };
  root?: { messageId: string; ownerId: string; clientMessageId?: string };
  reverse?: boolean;
}

export interface GroupCloudThreadPage extends CloudMessagePage {
  rootMsgId?: string;
  isRootDel?: boolean;
}

export interface GroupActivityBucket extends Data {
  time?: number | string | null;
  txtmsg?: number | string | null;
  totalmsg?: number | string | null;
  photomsg?: number | string | null;
  stickermsg?: number | string | null;
  filemsg?: number | string | null;
  useractive?: number | string | null;
  usernew?: number | string | null;
  userleft?: number | string | null;
}

export class DesktopHistoryError extends Error {
  constructor(readonly code: 'unsupported-service' | 'request-failed' | 'invalid-response', readonly status?: number, readonly providerCode?: number) {
    super({
      'unsupported-service': 'This Zalo Web session does not advertise the requested service.',
      'request-failed': 'Zalo did not accept the request or could not be reached.',
      'invalid-response': 'Zalo returned an unexpected response.',
    }[code]);
    this.name = 'DesktopHistoryError';
  }
}

function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DesktopHistoryError('invalid-response');
  return value as Data;
}

function objects(value: unknown): Data[] {
  if (!Array.isArray(value)) throw new DesktopHistoryError('invalid-response');
  return value.map(object);
}

async function read(api: API, query: ProtocolRequest): Promise<Data> {
  let value: unknown;
  try {
    value = await protocolRequest(api, query);
  } catch (error) {
    if (!(error instanceof ZaloProtocolError)) throw error;
    throw new DesktopHistoryError(error.code === 'aborted' ? 'request-failed' : error.code, error.status, error.providerCode);
  }
  try {
    return object(typeof value === 'string' ? parseProtocolJson(value) : value);
  } catch {
    throw new DesktopHistoryError('invalid-response');
  }
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new TypeError('Supply Zalo identifiers as decimal strings.');
  return value;
}

function cloudCursor(value: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 128 || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError('Supply the message cursor returned by Zalo.');
  }
  return value;
}

function cloudGroupId(value: string): string {
  return id(typeof value === 'string' ? value.replace(/^g/, '') : value);
}

function optionalFlag(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new DesktopHistoryError('invalid-response');
}

function optionalCursor(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) return String(value);
  throw new DesktopHistoryError('invalid-response');
}

function readCloudMessagePage(data: Data): CloudMessagePage {
  const hasMore = optionalFlag(data.hasMore);
  const lastMsgId = optionalCursor(data.lastMsgId);
  return {
    groupMsgs: objects(data.groupMsgs ?? []),
    ...(hasMore === undefined ? {} : { hasMore }),
    ...(lastMsgId === undefined ? {} : { lastMsgId }),
  };
}

/** Experimental: fetch changed last-message previews via a route observed in Zalo Desktop. */
export async function getConversationPreviews(api: API, cursors: ConversationPreviewCursors = {}): Promise<ConversationPreviews> {
  const wireCursors = Object.fromEntries([
    ...Object.entries(cursors.users ?? {}).map(([thread, last]) => [`${id(thread)}_0`, id(last)]),
    ...Object.entries(cursors.groups ?? {}).map(([thread, last]) => [`${id(thread)}_1`, id(last)]),
  ]);
  const data = await read(api, {
    service: 'conversation',
    path: '/api/preloadconvers/get-last-msgs',
    params: { threadIdLocalMsgId: JSON.stringify(wireCursors) },
    includeImei: true,
    response: 'preview',
  });
  return {
    msgs: objects(data.msgs ?? []),
    groupMsgs: objects(data.groupMsgs ?? []),
    pageMsgs: objects(data.pageMsgs ?? []),
    clearUnreads: data.clearUnreads,
    clearUnreadsReact: data.clearUnreadsReact,
    seens: data.seens,
  };
}

async function readCloudHistory(api: API, groupId: string, request: GroupCloudHistoryRequest, saved: boolean): Promise<GroupCloudHistoryPage> {
  const { count = 50, excludeMessageIds = [] } = request;
  if (!Number.isInteger(count) || count < 1 || count > 100 || !Array.isArray(excludeMessageIds) || excludeMessageIds.length > 100) {
    throw new TypeError('Supply a cloud page size and at most 100 message exclusions.');
  }
  const msgIds = Array.from(excludeMessageIds, (value) => cloudCursor(id(value)));
  const common = { groupId, count, msgIds, src: -1, ...(saved ? { isOA: 1 } : {}) };
  const query: ProtocolRequest = request.mode === 'jump' || request.mode === 'newer'
    ? { service: 'group_cloud_message', path: '/api/cm/rgetv2',
      params: { ...common, globalMsgId: cloudCursor(request.messageId), msgJump: request.mode === 'jump' ? 1 : 0 } }
    : { service: 'group_cloud_message', path: request.cursor?.isOld ? '/api/cm/getoldv2' : '/api/cm/getrecentv2',
      params: { ...common, globalMsgId: request.cursor ? cloudCursor(request.cursor.messageId) : '0' }, includeImei: true };
  const data = await read(api, query);
  const isOld = optionalFlag(data.isOld);
  const minMsgId = optionalCursor(data.minMsgId);
  const maxMsgId = optionalCursor(data.maxMsgId);
  return {
    ...readCloudMessagePage(data),
    ...(isOld === undefined ? {} : { isOld }),
    ...(minMsgId === undefined ? {} : { minMsgId }),
    ...(maxMsgId === undefined ? {} : { maxMsgId }),
  };
}

/** Experimental: fetch cloud group messages, optionally relative to a previous message. */
export async function getGroupCloudHistory(api: API, groupId: string, request: GroupCloudHistoryRequest = {}): Promise<GroupCloudHistoryPage> {
  return readCloudHistory(api, cloudGroupId(groupId), request, false);
}

/** Experimental: fetch history from the signed-in account's My Documents conversation. */
export async function getSavedMessagesCloudHistory(api: API, request: GroupCloudHistoryRequest = {}): Promise<GroupCloudHistoryPage> {
  return readCloudHistory(api, getSavedMessagesThread(api).threadId, request, true);
}

/** Experimental: read one page of a cloud reply thread using its anchor and optional root. */
export async function getGroupCloudThreadPage(
  api: API, groupId: string, { anchor, root, reverse = false }: GroupCloudThreadPageRequest,
): Promise<GroupCloudThreadPage> {
  if (typeof reverse !== 'boolean' || !anchor || (anchor.ownerId === null ? anchor.clientMessageId !== null || !root : anchor.clientMessageId === null)) {
    throw new TypeError('Supply a cloud thread anchor and a root for cursor-only continuation.');
  }
  const data = await read(api, {
    service: 'group_cloud_message',
    path: '/api/cm/getpath',
    headers: { nretry: '0' },
    params: {
      groupId: cloudGroupId(groupId),
      ownerId: anchor.ownerId === null ? null : id(anchor.ownerId),
      cliMsgId: anchor.clientMessageId === null ? null : cloudCursor(anchor.clientMessageId),
      globalMsgId: cloudCursor(anchor.messageId),
      reverse: reverse ? 1 : 0,
      ...(root ? {
        rOwnerId: id(root.ownerId),
        rGlobalMsgId: cloudCursor(root.messageId),
        rClientMsgId: root.clientMessageId === undefined ? null : cloudCursor(root.clientMessageId),
      } : {}),
    },
  });
  const rootMsgId = optionalCursor(data.rootMsgId);
  const isRootDel = optionalFlag(data.isRootDel);
  return {
    ...readCloudMessagePage(data),
    ...(rootMsgId === undefined ? {} : { rootMsgId }),
    ...(isRootDel === undefined ? {} : { isRootDel }),
  };
}

/** Experimental: retrieve activity buckets for a group where stats are available. */
export async function getGroupActivity(api: API, groupId: string): Promise<GroupActivityBucket[]> {
  const grid = id(groupId);
  const result = await read(api, { service: 'group', path: '/api/group/analyse', params: { grid } });
  const fields = ['time', 'txtmsg', 'totalmsg', 'photomsg', 'stickermsg', 'filemsg', 'useractive', 'usernew', 'userleft'];
  return objects(result.data).map((bucket) => {
    for (const field of fields) {
      const value = bucket[field];
      if (value != null && typeof value !== 'number' && typeof value !== 'string') {
        throw new DesktopHistoryError('invalid-response');
      }
    }
    return bucket;
  });
}
