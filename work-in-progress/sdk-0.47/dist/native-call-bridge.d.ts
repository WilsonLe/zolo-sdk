export interface NativeCallMessage {
    type: 'update' | 'request' | 'response' | 'control' | 'recvSignal' | 'sendSignal';
    command?: string | number;
    id?: string | number;
    data?: unknown;
}
export interface NativeCallContact {
    id: string;
    name?: string;
    avatar?: string;
}
export type NativeMakeCallRequest = {
    isFirstCall?: boolean;
} & ({
    type: 1 | 3;
    partner: readonly [NativeCallContact];
} | {
    type: 5 | 6;
    partner: readonly NativeCallContact[];
    groupInfo: NativeCallContact & {
        maxUsers?: number;
    };
});
export interface NativeCallStatus {
    error: number;
    extendData: string;
}
export interface NativeCallRequestOptions {
    /** Stops waiting for the response. It cannot recall a command sent to the helper. */
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface NativeCallRequests {
    makeCall: NativeMakeCallRequest;
    hide: null;
}
export interface NativeCallResponses {
    makeCall: NativeCallStatus;
    hide: NativeCallStatus;
}
declare const errors: {
    readonly 'unsupported-helper': "The installed Zalo call helper build is unsupported.";
    readonly 'invalid-message': "Invalid Zalo native call message.";
    readonly 'invalid-frame': "Invalid Zalo native call transport frame.";
    readonly 'startup-failed': "The Zalo call helper could not start.";
    readonly 'startup-timeout': "The Zalo call helper did not become ready.";
    readonly 'ack-timeout': "The Zalo call helper did not acknowledge a frame.";
    readonly 'response-timeout': "The Zalo call helper did not reply to the request.";
    readonly 'request-pending': "A Zalo call helper request with this response name is already pending.";
    readonly 'invalid-response': "The Zalo call helper returned an unexpected response.";
    readonly disconnected: "The Zalo call helper disconnected.";
    readonly 'handler-failed': "The Zalo call helper event handler failed.";
    readonly closed: "The Zalo call bridge is closed.";
    readonly aborted: "The Zalo call bridge was cancelled.";
};
export declare class NativeCallBridgeError extends Error {
    readonly code: keyof typeof errors;
    constructor(code: keyof typeof errors);
}
/** Encode host writes and decode a stream of local ZaloCall transport frames. */
export declare function createNativeCallCodec(transportKey: Uint8Array): {
    encode: (message: NativeCallMessage) => string[];
    push: (chunk: Uint8Array | string) => NativeCallMessage[];
    close: () => void;
};
export type NativeCallHelperSource = {
    kind: 'installed';
    appPath?: string;
} | {
    kind: 'external';
    executable: string;
    args?: readonly string[];
    transportKey: Uint8Array;
};
export interface NativeCallBridgeOptions {
    source?: NativeCallHelperSource;
    onMessage?(message: NativeCallMessage): void | Promise<void>;
    startupTimeoutMs?: number;
    ackTimeoutMs?: number;
    signal?: AbortSignal;
}
export interface NativeCallBridge {
    /** Serialize one host message and wait for its socket acknowledgment. */
    send(message: NativeCallMessage): Promise<void>;
    /** Wait for the helper's application response, beyond the socket acknowledgment. */
    request<Command extends keyof NativeCallRequests>(command: Command, data: NoInfer<NativeCallRequests[Command]>, options?: NativeCallRequestOptions): Promise<NativeCallResponses[Command]>;
    /** Close the private sockets and the owned helper process. */
    close(): Promise<void>;
    /** Resolves after cleanup. A value identifies an abnormal close. */
    readonly closed: Promise<NativeCallBridgeError | undefined>;
}
/** Starts the helper on two new private Unix sockets. This does not send any call or media commands. */
export declare function startNativeCallBridge(options?: NativeCallBridgeOptions): Promise<NativeCallBridge>;
export {};
