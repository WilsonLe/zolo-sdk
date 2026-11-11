import type { API } from '#zca';
/** Explicitly accepts or declines a group reminder. Read fresh details for updated membership counts. */
export declare function respondToGroupReminder(api: API, groupId: string, eventId: string, choice: 'accept' | 'reject', signal?: AbortSignal): Promise<void>;
