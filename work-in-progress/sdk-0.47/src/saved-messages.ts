import { ThreadType } from '#zca';
import type { API, SendMessageResponse } from '#zca';
import { ZaloProtocolError } from './protocol-request.js';

export interface SavedMessagesThread {
  threadId: string;
  threadType: ThreadType;
}

/** Resolves My Documents from the authenticated account's advertised destination. */
export function getSavedMessagesThread(api: API): SavedMessagesThread {
  const value: unknown = api.getContext().loginInfo.send2me_id;
  const id = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  if (!/^g?[1-9][0-9]{0,39}$/.test(id)) throw new ZaloProtocolError('unsupported-service');
  return id.startsWith('g')
    ? { threadId: id.slice(1), threadType: ThreadType.Group }
    : { threadId: id, threadType: ThreadType.User };
}

/** Sends plain text to the signed-in account's My Documents conversation. */
export function sendSavedMessage(api: API, text: string): Promise<SendMessageResponse> {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('Supply nonempty My Documents message text.');
  const { threadId, threadType } = getSavedMessagesThread(api);
  return api.sendMessage(text, threadId, threadType);
}
