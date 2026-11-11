import type { API } from '#zca';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';
export interface VoiceTranscriptionEvent {
    readonly requestId: string;
    readonly errorCode: number;
    readonly isTruncated: boolean;
    readonly text?: string;
    readonly url?: string;
}
export interface VoiceTranscriptionResult extends VoiceTranscriptionEvent {
    readonly errorCode: 0;
    readonly text: string;
}
export interface VoiceTranscriptionInput {
    /** Explicit ordinary voice URL that the provider can fetch; no upload or URL recovery occurs. */
    url: string;
    /** The existing authenticated feed for the same API. No listener is opened by this helper. */
    feed: RealtimeFrameFeed;
    /** Bounds readiness, HTTP and final control completion. Defaults to 10 seconds. */
    timeoutMs?: number;
    signal?: AbortSignal;
}
declare const messages: {
    readonly 'feed-unavailable': "Supply this account session's authenticated voice transcription feed.";
    readonly 'feed-closed': "The voice transcription feed closed.";
    readonly busy: "Too many voice transcriptions are pending on this feed.";
    readonly aborted: "The voice transcription was cancelled.";
    readonly timeout: "The voice transcription deadline expired.";
    readonly 'unsupported-service': "This session does not advertise voice transcription.";
    readonly rejected: "The provider rejected voice transcription.";
    readonly 'submission-unknown': "The voice transcription submission could not be confirmed.";
    readonly 'invalid-response': "The provider returned an unexpected voice transcription result.";
    readonly 'no-text': "No text was recognized in the voice recording.";
    readonly 'request-id-reused': "The provider reused a voice transcription request ID. Reconcile before trying again.";
    readonly 'result-overflow': "Too many uncorrelated voice transcription results arrived.";
};
export declare class VoiceTranscriptionError extends Error {
    readonly code: keyof typeof messages;
    readonly submitted: boolean;
    readonly acknowledged: boolean;
    readonly requestId?: string | undefined;
    readonly providerCode?: number | undefined;
    constructor(code: keyof typeof messages, submitted: boolean, acknowledged: boolean, requestId?: string | undefined, providerCode?: number | undefined);
}
/** Extracts the installed convert_finish records from decoded control batches. */
export declare function extractVoiceTranscriptionEvents(frame: RealtimeFrame): VoiceTranscriptionEvent[];
/** Submits exactly once, then waits for the correlated realtime result, in either arrival order. */
export declare function transcribeVoice(api: API, input: VoiceTranscriptionInput): Promise<VoiceTranscriptionResult>;
export {};
