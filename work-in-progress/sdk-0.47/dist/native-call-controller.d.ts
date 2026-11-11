import type { API } from '#zca';
import type { CallControl } from './call-signaling.js';
import { NativeCallBridgeError } from './native-call-bridge.js';
import type { NativeCallBridgeOptions, NativeCallMessage, NativeCallRequestOptions, NativeCallStatus, NativeMakeCallRequest } from './native-call-bridge.js';
import { ZaloProtocolError } from './protocol-request.js';
import type { RealtimeFrameFeed } from './realtime-feed.js';
declare const errors: {
    readonly 'unsupported-signal': "The native helper sent an unsupported call command.";
    readonly 'invalid-signal': "The native helper sent invalid call parameters.";
    readonly 'feed-mismatch': "Use a realtime feed opened for this authenticated Zalo API.";
    readonly 'signal-failed': "The Zalo native call signal failed.";
    readonly 'control-failed': "The Zalo incoming call control could not be forwarded.";
    readonly 'handler-failed': "The Zalo native call application handler failed.";
    readonly 'realtime-failed': "The Zalo call controller encountered a realtime error.";
    readonly 'realtime-not-ready': "Wait for the Zalo call controller to connect before starting a call.";
};
export declare class NativeCallControllerError extends Error {
    readonly code: keyof typeof errors;
    readonly command?: number | undefined;
    constructor(code: keyof typeof errors, command?: number | undefined);
}
type Data = Record<string, unknown>;
type ControllerError = NativeCallControllerError | NativeCallBridgeError | ZaloProtocolError;
export interface NativeCallControllerOptions {
    native?: Omit<NativeCallBridgeOptions, 'onMessage' | 'signal'>;
    /** The caller can share an active feed for the same authenticated API. */
    feed?: RealtimeFrameFeed;
    /** The caller's native init data, including identity, device policy and settings. */
    init: Data;
    /** Approve each realtime control forwarded to the helper. Approving a request can ring locally. */
    shouldForwardControl(control: CallControl): boolean | Promise<boolean>;
    /** Native requests and updates that need application policy are delivered here. */
    onNativeMessage?(message: NativeCallMessage): void | Promise<void>;
    onError?(error: ControllerError): void | Promise<void>;
    signal?: AbortSignal;
}
export interface NativeCallController {
    /** True after WebSocket key negotiation. */
    readonly ready: Promise<boolean>;
    /** Send an explicit application message, such as makeCall, to the native helper. */
    send(message: NativeCallMessage): Promise<void>;
    /** Ask the native helper to start an explicit call and return its local disposition. */
    makeCall(data: NativeMakeCallRequest, options?: NativeCallRequestOptions): Promise<NativeCallStatus>;
    hide(options?: NativeCallRequestOptions): Promise<NativeCallStatus>;
    /** Sends the local command and waits for the socket acknowledgment. */
    endCall(): Promise<void>;
    close(): Promise<void>;
    readonly closed: Promise<void>;
}
/** Experimental: connect the private native helper bridge to an authenticated SDK session. */
export declare function startNativeCallController(api: API, options: NativeCallControllerOptions): Promise<NativeCallController>;
export {};
