import type { ConversationStateThread } from './conversation-state.js';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';
export type AccountProfileActType = 'alias' | 'profile' | 'hidden_chat' | 'emoji_status';
export type AccountProfileTime = number | string;
export type AccountProfileTarget = {
    readonly kind: 'self';
} | {
    readonly kind: 'user';
    readonly userId: string;
};
export interface AccountProfileEntry<T> {
    readonly raw: unknown;
    readonly value?: T;
}
export interface AccountBusinessPackageFields {
    readonly pkgId?: number | string;
}
export interface AccountEmojiStatusIdentity {
    /** Original owner field; no comparison with the current account is performed. */
    readonly noisedOwnerId: string;
    readonly emojiStatusId: string;
}
export interface AccountEmojiStatusRecord extends AccountEmojiStatusIdentity {
    readonly emojiId: string;
    readonly createdTimeMilliseconds: number;
    readonly durationMilliseconds: number;
    readonly caption?: string | null;
    readonly songId?: string;
}
export type AccountProfileChange = {
    readonly kind: 'aliases-invalidated';
} | {
    readonly kind: 'phonebook-invalidated';
} | {
    readonly kind: 'own-profile-invalidated';
} | {
    readonly kind: 'own-profile-status-updated';
    readonly status: string;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'profile-last-online-updated';
    readonly userId: string;
    readonly lastOnlineMilliseconds: AccountProfileTime;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'profile-mode-updated';
    readonly target: AccountProfileTarget;
    /** Raw safe-integer mode, including AWAY 1 and future values; no UI conversion. */
    readonly mode: number;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'own-business-profile-patch';
    readonly target: {
        readonly kind: 'self';
    };
    readonly businessPackage?: AccountProfileEntry<AccountBusinessPackageFields>;
    readonly time?: AccountProfileEntry<AccountProfileTime>;
    readonly onboardingInfo?: unknown;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'hidden-chat-membership-updated';
    readonly additions?: readonly AccountProfileEntry<ConversationStateThread>[];
    readonly removals?: readonly AccountProfileEntry<ConversationStateThread>[];
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'hidden-chat-reset';
} | {
    readonly kind: 'hidden-chat-pin-invalidated';
} | {
    readonly kind: 'emoji-status-add-signal';
    readonly status?: AccountProfileEntry<AccountEmojiStatusRecord>;
    readonly debounceSeconds?: number;
    readonly raw: Readonly<ProtocolData>;
} | {
    readonly kind: 'emoji-status-delete-signal';
    readonly status?: AccountProfileEntry<AccountEmojiStatusIdentity>;
    readonly debounceSeconds?: number;
    readonly raw: Readonly<ProtocolData>;
};
export interface AccountProfileEvent {
    readonly controlIndex: number;
    readonly actType: AccountProfileActType;
    readonly act: unknown;
    /** Original private input references; hidden-chat content may contain credential material. */
    readonly rawControl: Readonly<ProtocolData>;
    readonly rawContent: Readonly<ProtocolData>;
    /** Absent for unsupported acts, shapes or exhausted projection bounds. */
    readonly change?: AccountProfileChange;
}
/**
 * Pure ordered observations of successful non-reset 601/603 account controls.
 * No global identity, cache, vault, clock, listener, fetch, timer or persistence is consulted.
 */
export declare function extractAccountProfileEvents(frame: RealtimeFrame): readonly AccountProfileEvent[] | undefined;
