import type { DesktopSessionConnection } from './desktop-session.js';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';
/** Values are preserved, not normalized to an enabled/disabled interpretation. */
export type DesktopAccountSettingsToggle = boolean | 0 | 1;
export interface DesktopAccountSettingsKnown {
    readonly show_online_status?: DesktopAccountSettingsToggle;
    readonly display_seen_status?: DesktopAccountSettingsToggle;
    readonly add_friend_via_phone?: DesktopAccountSettingsToggle;
    readonly add_friend_via_qr?: DesktopAccountSettingsToggle;
    readonly add_friend_via_group?: DesktopAccountSettingsToggle;
    readonly add_friend_via_contact?: DesktopAccountSettingsToggle;
    readonly display_on_recommend_friend?: DesktopAccountSettingsToggle;
    readonly archived_chat_status?: DesktopAccountSettingsToggle;
    readonly quick_message_status?: DesktopAccountSettingsToggle;
    readonly view_birthday?: 0 | 1 | 2;
    readonly receive_message?: 1 | 2;
    readonly accept_stranger_call?: 2 | 3 | 4;
    readonly show_seen?: boolean;
    /** Safe raw provider integer; no derived enabled/default meaning. */
    readonly setting_show_stranger_msg_directly?: number;
    /** Safe raw provider integer; security updates use the separate 2FA API. */
    readonly setting_2FA_status?: number;
}
export interface DesktopAccountSettingsSnapshot {
    /** Frozen shallow own-data copy. Nested unknown provider values are retained by reference. */
    readonly raw: Readonly<ProtocolData>;
    readonly known: Readonly<DesktopAccountSettingsKnown>;
}
type ToggleWriteKey = 'show_online_status' | 'display_seen_status' | 'add_friend_via_phone' | 'add_friend_via_qr' | 'add_friend_via_group' | 'add_friend_via_contact' | 'display_on_recommend_friend' | 'archivedChatStatus' | 'quickMessageStatus';
export type DesktopAccountSettingChange = {
    readonly key: ToggleWriteKey;
    readonly value: 0 | 1;
} | {
    readonly key: 'view_birthday';
    readonly value: 0 | 1 | 2;
} | {
    readonly key: 'receive_message';
    readonly value: 1 | 2;
} | {
    readonly key: 'accept_stranger_call';
    readonly value: 2 | 3 | 4;
};
export interface DesktopAccountSettingAcknowledgement {
    readonly submitted: true;
    readonly acknowledged: true;
}
export interface DesktopAccountSettingsEvent {
    readonly controlIndex: number;
    /** Original control/content references. Neither is cloned, frozen or mutated. */
    readonly rawControl: Readonly<ProtocolData>;
    readonly rawContent: Readonly<ProtocolData>;
    readonly settings: DesktopAccountSettingsSnapshot;
}
export type DesktopAccountSettingsFailureReason = 'aborted' | 'closed' | 'timed-out' | 'response-limit' | 'invalid-response' | 'request-failed';
declare const messages: {
    readonly 'invalid-input': "Supply one supported Desktop account setting and its explicit value.";
    readonly 'invalid-connection': "Supply a live Desktop connection created by this SDK.";
    readonly closed: "The Desktop connection is closed.";
    readonly busy: "Another Desktop account operation is pending for this connection.";
    readonly aborted: "The Desktop account settings request was cancelled.";
    readonly rejected: "The Desktop provider rejected the account settings request.";
    readonly 'request-failed': "The Desktop account settings request could not be completed.";
    readonly 'invalid-response': "The Desktop account settings response was not recognized.";
    readonly 'submission-unknown': "The Desktop account setting may have changed without a confirmed acknowledgement.";
};
export declare class DesktopAccountSettingsError extends Error {
    readonly code: keyof typeof messages;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly providerCode?: number | undefined;
    readonly status?: number | undefined;
    readonly reason?: DesktopAccountSettingsFailureReason | undefined;
    constructor(code: keyof typeof messages, submitted?: boolean, outcomeUnknown?: boolean, providerCode?: number | undefined, status?: number | undefined, reason?: DesktopAccountSettingsFailureReason | undefined);
}
/** Reads the installed Desktop account settings route without encrypted empty params or hidden state. */
export declare function getDesktopAccountSettings(connection: DesktopSessionConnection, signal?: AbortSignal): Promise<DesktopAccountSettingsSnapshot>;
/** Changes one selected setting once; acknowledgement does not update a local store or read the setting back. */
export declare function setDesktopAccountSetting(connection: DesktopSessionConnection, change: DesktopAccountSettingChange, signal?: AbortSignal): Promise<DesktopAccountSettingAcknowledgement>;
/** Pure ordered settings patches; no subscription, acknowledgement, revision sorting or application-store update. */
export declare function extractDesktopAccountSettingsEvents(frame: RealtimeFrame): readonly DesktopAccountSettingsEvent[];
export {};
