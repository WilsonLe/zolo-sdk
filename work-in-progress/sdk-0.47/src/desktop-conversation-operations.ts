import type { API } from '#zca';
import { parseProtocolJson, protocolRequest, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';

export interface ConversationReadMarkerQuery {
  readonly userIds?: readonly string[];
  readonly groupIds?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ConversationReadMarker {
  readonly threadId: string;
  readonly threadType: 'user' | 'group';
  readonly lastMessageId: string;
  readonly raw: ProtocolData;
}

export interface BlockSharingConversation {
  readonly threadId: string;
  readonly threadType: 'user' | 'group';
  readonly enabledBySelf: boolean;
  readonly createdAt?: number | string;
}

export interface BlockSharingUpdate {
  readonly threadId: string;
  readonly threadType: 'user' | 'group';
  readonly enabled: boolean;
  readonly clientLanguage?: 'en' | 'vi';
  readonly signal?: AbortSignal;
}

export interface ConversationLabelCreate {
  readonly text: string;
  readonly color: string;
  readonly emoji?: string;
  readonly add?: readonly string[];
}

export interface ConversationLabelUpdate {
  readonly id: number;
  readonly text: string;
  readonly color: string;
  readonly offset: number;
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}

export type ConversationLabelRevision = number | string;

export interface ConversationLabelMutationOptions {
  /** Current revision from getLabels or a previous mutation, when maintaining a cache. */
  readonly localVersion?: ConversationLabelRevision;
  readonly signal?: AbortSignal;
}

export interface ConversationLabelMutation {
  readonly version?: ConversationLabelRevision;
  readonly oldVersion?: ConversationLabelRevision;
  readonly lastUpdateTime?: number | string;
  readonly labelData?: ProtocolData[];
  readonly shouldResync: boolean;
}

const privacyUpdates = new WeakMap<API, Promise<unknown>>();
const labelUpdates = new WeakMap<API, Promise<unknown>>();

function enqueue<T>(pending: WeakMap<API, Promise<unknown>>, api: API, run: () => Promise<T>): Promise<T> {
  const previous = pending.get(api);
  const operation = previous ? previous.then(run, run) : run();
  pending.set(api, operation);
  const release = () => { if (pending.get(api) === operation) pending.delete(api); };
  void operation.then(release, release);
  return operation;
}

function decimalId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,40}$/.test(value)) throw new TypeError('Supply Zalo identifiers as decimal strings.');
  return value;
}

function groupId(value: string): string {
  return decimalId(typeof value === 'string' ? value.replace(/^g/, '') : value);
}

function unsignedInteger(value: unknown): value is number | string {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || (typeof value === 'string' && /^\d{1,40}$/.test(value));
}

function responseId(value: unknown): string {
  if (!unsignedInteger(value)) throw new ZaloProtocolError('invalid-response');
  return String(value);
}

function flag(value: unknown): boolean {
  if (value === true || value === 1 || value === '1') return true;
  if (value == null || value === false || value === 0 || value === '0') return false;
  throw new ZaloProtocolError('invalid-response');
}

function fromJson(value: string): unknown {
  try { return parseProtocolJson(value); }
  catch { throw new ZaloProtocolError('invalid-response'); }
}

function records(value: unknown): ProtocolData[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ZaloProtocolError('invalid-response');
  return value.map(requireProtocolObject);
}

/** Fetch last-seen markers in batches of up to 50 direct and 50 group threads. */
export async function getConversationReadMarkers(api: API, { userIds = [], groupIds = [], signal }: ConversationReadMarkerQuery): Promise<ConversationReadMarker[]> {
  const oneone = Array.from(userIds, decimalId);
  const group = Array.from(groupIds, groupId);
  const markers: ConversationReadMarker[] = [];
  for (let index = 0; index < Math.max(group.length, oneone.length); index += 50) {
    const value = await protocolRequest(api, {
      service: 'chat', path: '/api/preloadconvers/get-last-seen',
      params: { param: JSON.stringify({ group: group.slice(index, index + 50), oneone: oneone.slice(index, index + 50) }) },
      signal,
    });
    const { data } = requireProtocolObject(value);
    if (typeof data !== 'string') throw new ZaloProtocolError('invalid-response');
    const status = requireProtocolObject(fromJson(data));
    const code = status.error_code;
    if (code !== 0 && code !== '0') {
      const numeric = typeof code === 'string' && /^-?\d{1,8}$/.test(code) ? Number(code) : code;
      throw new ZaloProtocolError('request-failed', undefined, typeof numeric === 'number' && Number.isSafeInteger(numeric) ? numeric : undefined);
    }
    const clearUnreadInfo = status.data == null ? undefined : requireProtocolObject(status.data).clearUnreadInfo;
    for (const raw of records(clearUnreadInfo)) {
      markers.push({ threadId: responseId(raw.idTo), threadType: flag(raw.isGroup) ? 'group' : 'user',
        lastMessageId: responseId(raw.lastMsgId), raw });
    }
  }
  return markers;
}

/** List conversations currently configured to block sharing. */
export async function getBlockSharingConversations(api: API, signal?: AbortSignal): Promise<BlockSharingConversation[]> {
  const value = await protocolRequest(api, {
    service: 'conversation', path: '/api/conv/blocksharing/getConvers', params: {}, signal, allowEmpty: true,
  });
  const convers = value == null ? undefined : requireProtocolObject(value).convers;
  return records(convers).map(({ destId, isGroup, isActor, createdAt }) => ({
    threadId: responseId(destId),
    threadType: flag(isGroup) ? 'group' : 'user',
    enabledBySelf: flag(isActor),
    ...(unsignedInteger(createdAt) ? { createdAt } : {}),
  }));
}

/** Change the account's sharing protection setting for one conversation. */
export function setConversationBlockSharing(api: API, input: BlockSharingUpdate): Promise<void> {
  const { threadType, enabled, signal } = input;
  if (threadType !== 'user' && threadType !== 'group') throw new TypeError('Invalid Zalo thread type.');
  if (typeof enabled !== 'boolean') throw new TypeError('Supply the new Zalo block sharing setting as a boolean.');
  const group = threadType === 'group';
  const clientLang = input.clientLanguage ?? (/^en(?:[-_]|$)/i.test(api.getContext().language) ? 'en' : 'vi');
  if (clientLang !== 'en' && clientLang !== 'vi') throw new TypeError('Supply a supported Zalo client language.');
  const params = { threadId: group ? groupId(input.threadId) : decimalId(input.threadId), isGroup: group ? 1 : 0,
    isEnabled: enabled ? 1 : 0, clientLang };
  return enqueue(privacyUpdates, api, async () => {
    await protocolRequest(api, {
      service: 'conversation', path: '/api/conv/blocksharing/updateConvers', method: 'POST', params, signal, allowEmpty: true,
    });
  });
}

function labelInfo({ text, color }: ConversationLabelCreate): { text: string; color: string } {
  if (typeof text !== 'string' || !text.trim() || typeof color !== 'string' || !color.trim()) {
    throw new TypeError('Supply a Zalo label name and color.');
  }
  return { text, color };
}

function labelId(id: number): number {
  if (!Number.isSafeInteger(id) || id < 0) throw new TypeError('Invalid Zalo label ID.');
  return id;
}

function labelIds(ids: readonly number[]): number[] {
  const values = Array.from(ids, labelId);
  if (!values.length || new Set(values).size !== values.length) throw new TypeError('Supply distinct Zalo label IDs.');
  return values;
}

function conversationIds(ids: readonly string[] = []): string[] {
  return Array.from(ids, (id) => {
    if (typeof id !== 'string' || !/^g?\d{1,40}$/.test(id)) throw new TypeError('Supply a Zalo conversation ID, using a leading g for groups.');
    return id;
  });
}

function mutateLabel(api: API, action: 'add' | 'update' | 'delete' | 'reorder', params: ProtocolData,
  { localVersion, signal }: ConversationLabelMutationOptions): Promise<ConversationLabelMutation> {
  if (localVersion !== undefined && !unsignedInteger(localVersion)) throw new TypeError('Invalid Zalo label revision.');
  return enqueue(labelUpdates, api, async () => {
    const value = await protocolRequest(api, {
      service: 'label', path: `/api/convlabel/manage/${action}`, method: 'POST', params, signal, allowEmpty: true,
    });
    const result = value == null ? {} : requireProtocolObject(value);
    const { version, oldVersion, lastUpdateTime } = result;
    let labels = result.labelData;
    if (typeof labels === 'string' && labels) labels = fromJson(labels);
    const hasOldVersion = unsignedInteger(oldVersion);
    return {
      ...(unsignedInteger(version) ? { version } : {}),
      ...(hasOldVersion ? { oldVersion } : {}),
      ...(unsignedInteger(lastUpdateTime) ? { lastUpdateTime } : {}),
      ...(labels == null || labels === '' ? {} : {
        labelData: Array.isArray(labels) ? records(labels) : [requireProtocolObject(labels)],
      }),
      shouldResync: localVersion === undefined || !hasOldVersion || String(oldVersion) !== String(localVersion),
    };
  });
}

/** Create a label and optionally assign conversations in the same request. */
export function createConversationLabel(api: API, input: ConversationLabelCreate, options: ConversationLabelMutationOptions = {}): Promise<ConversationLabelMutation> {
  const info = labelInfo(input);
  if (input.emoji !== undefined && typeof input.emoji !== 'string') throw new TypeError('Invalid Zalo label emoji.');
  return mutateLabel(api, 'add', {
    labelInfo: JSON.stringify({ ...info, ...(input.emoji ? { emoji: input.emoji } : {}) }), add: conversationIds(input.add),
  }, options);
}

/** Update label attributes and optionally apply membership changes as deltas. */
export function updateConversationLabel(api: API, input: ConversationLabelUpdate, options: ConversationLabelMutationOptions = {}): Promise<ConversationLabelMutation> {
  const { offset } = input;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid Zalo label offset.');
  const { text, color } = labelInfo(input);
  return mutateLabel(api, 'update', {
    labelInfo: JSON.stringify({ id: labelId(input.id), text, color, offset }),
    add: conversationIds(input.add), remove: conversationIds(input.remove),
  }, options);
}

export function deleteConversationLabels(api: API, ids: readonly number[], options: ConversationLabelMutationOptions = {}): Promise<ConversationLabelMutation> {
  return mutateLabel(api, 'delete', { labelIds: labelIds(ids) }, options);
}

/** Set label offsets from the complete list of label IDs in display order. */
export function reorderConversationLabels(api: API, ids: readonly number[], options: ConversationLabelMutationOptions = {}): Promise<ConversationLabelMutation> {
  const ordered = labelIds(ids).map((id, offset) => ({ id, offset }));
  return mutateLabel(api, 'reorder', { lsLabelInfo: JSON.stringify(ordered) }, options);
}
