// Source-blind046 strict consumer contract. Root compiles; author did not execute.
import { uploadSignedChatVideoThumbnail, SignedVideoThumbnailUploadError,
  uploadSignedChatVideo, SignedVideoUploadError, sendUploadedChatVideo,
  type API, type RealtimeFrameFeed, type UploadChatVideoThumbnailInput,
  type UploadSignedChatVideoThumbnailInput, type SignedUploadedChatVideoThumbnail,
  type UploadedChatVideoThumbnail, type UploadSignedChatVideoInput,
  type SignedUploadedChatVideo, type UploadedChatVideo } from 'zalo-personal-sdk';

declare const api: API, feed: RealtimeFrameFeed;
const input: UploadSignedChatVideoThumbnailInput = { threadType: 'user', threadId: '123', clientId: 46,
  bytes: new Uint8Array(4), fileName: 'preview.jpg', feed, chunkSize: 1,
  timeoutMs: 600000, signal: new AbortController().signal };
const result: Promise<SignedUploadedChatVideoThumbnail> = uploadSignedChatVideoThumbnail(api, input);
const groupResult: Promise<SignedUploadedChatVideoThumbnail> = uploadSignedChatVideoThumbnail(api,
  { ...input, threadType: 'group', threadId: 'g123', fileName: 'preview.png' });
const videoInput: UploadSignedChatVideoInput = { threadType: 'user', threadId: '123', clientId: 45,
  bytes: new Uint8Array(16), fileName: 'clip.mp4', width: 1920, height: 1080,
  durationMs: 1000, feed };
const videoResult: Promise<SignedUploadedChatVideo> = uploadSignedChatVideo(api, videoInput);
async function interoperability(): Promise<void> {
  const signed = await result;
  const existing: UploadedChatVideoThumbnail = signed;
  const video: UploadedChatVideo = await videoResult;
  const source: 'provider' | 'local' = signed.photoIdSource;
  const account: string = signed.accountId, thread: string = signed.threadId, photoId: string = signed.photoId;
  const threadType: 'user' | 'group' = signed.threadType;
  const actionId: number = signed.clientId, size: number = signed.fileSize, url: string = signed.thumbnailUrl;
  await sendUploadedChatVideo(api, video, { thumbnail: existing, title: 'caller title', properties: '{"source":"caller"}', ttl: 1 });
  // @ts-expect-error account facts are readonly
  signed.accountId = '2';
  // @ts-expect-error thread kind is readonly
  signed.threadType = 'group';
  // @ts-expect-error destination is readonly
  signed.threadId = '456';
  // @ts-expect-error action identity is readonly
  signed.clientId = 47;
  // @ts-expect-error full input size is readonly
  signed.fileSize = 1;
  // @ts-expect-error provider or local identity is readonly
  signed.photoId = '789';
  // @ts-expect-error result URL is readonly
  signed.thumbnailUrl = 'https://example.invalid';
  // @ts-expect-error provenance is readonly
  signed.photoIdSource = 'local';
  void [source, account, thread, photoId, threadType, actionId, size, url];
}
void [interoperability, groupResult];
declare const raw: UploadChatVideoThumbnailInput;
// @ts-expect-error the existing raw thumbnail optional feed cannot satisfy required signed feed
uploadSignedChatVideoThumbnail(api, raw);
// @ts-expect-error same-API feed is required by the signed operation
const missingFeed: UploadSignedChatVideoThumbnailInput = { threadType: 'user', threadId: '123', clientId: 46,
  bytes: new Uint8Array(4), fileName: 'preview.jpg' };
// @ts-expect-error thumbnail input has no width metadata
uploadSignedChatVideoThumbnail(api, { ...input, width: 1 });
// @ts-expect-error thumbnail input has no height metadata
uploadSignedChatVideoThumbnail(api, { ...input, height: 1 });
// @ts-expect-error thumbnail input has no duration metadata
uploadSignedChatVideoThumbnail(api, { ...input, durationMs: 1000 });
// @ts-expect-error thumbnail input has no rotation metadata
uploadSignedChatVideoThumbnail(api, { ...input, rotation: 90 });
// @ts-expect-error no generic media-kind transport is exposed
uploadSignedChatVideoThumbnail(api, { ...input, kind: 'photo' });
// @ts-expect-error caller cannot choose the negotiated upload URL
uploadSignedChatVideoThumbnail(api, { ...input, uploadUrl: 'https://example.invalid' });
// @ts-expect-error caller-prepared bytes are required rather than a source URL
uploadSignedChatVideoThumbnail(api, { ...input, url: 'https://example.invalid/preview.jpg' });
// @ts-expect-error no secure upload mode is added to the ordinary operation
uploadSignedChatVideoThumbnail(api, { ...input, secure: true });
// @ts-expect-error there is no caller metadata-probe control
uploadSignedChatVideoThumbnail(api, { ...input, probeMetadata: true });
// @ts-expect-error feed must be a real public feed interface
uploadSignedChatVideoThumbnail(api, { ...input, feed: {} });
const error = new SignedVideoThumbnailUploadError('session-update-failed', 'upload');
new SignedVideoThumbnailUploadError('destination-unavailable', 'negotiate');
new SignedVideoThumbnailUploadError('unsupported-destination', 'negotiate');
// @ts-expect-error public construction grants no known-progress argument
new SignedVideoThumbnailUploadError('rejected', 'upload', { submitted: true });
// @ts-expect-error there is no send stage for this uploader
new SignedVideoThumbnailUploadError('rejected', 'send');
// @ts-expect-error unknown codes are not admitted
new SignedVideoThumbnailUploadError('request-failed', 'upload');
// @ts-expect-error the older signed-video error union is unchanged
new SignedVideoUploadError('destination-unavailable', 'negotiate');
// @ts-expect-error the older signed-video error union is unchanged
new SignedVideoUploadError('unsupported-destination', 'negotiate');
const stages: 'negotiate' | 'upload' = error.stage;
const submitted: boolean = error.submitted, negotiated: boolean = error.negotiationSubmitted;
const chunks: number = error.acceptedChunks, bytes: number = error.acceptedBytes;
const providerCode: number | undefined = error.providerCode, status: number | undefined = error.status;
const codes: Record<SignedVideoThumbnailUploadError['code'], true> = { aborted: true, timeout: true, busy: true,
  'action-reused': true, 'feed-unavailable': true, rejected: true, 'invalid-response': true,
  'stale-upload': true, incomplete: true, 'submission-unknown': true, 'session-update-failed': true,
  'destination-unavailable': true, 'unsupported-destination': true };
// @ts-expect-error codes are readonly
error.code = 'timeout';
// @ts-expect-error stages are readonly
error.stage = 'negotiate';
// @ts-expect-error progress facts are readonly
error.submitted = true;
// @ts-expect-error progress facts are readonly
error.negotiationSubmitted = true;
// @ts-expect-error progress facts are readonly
error.acceptedChunks = 3;
// @ts-expect-error progress facts are readonly
error.acceptedBytes = 10;
// @ts-expect-error progress facts are readonly
error.providerCode = 0;
// @ts-expect-error progress facts are readonly
error.status = 200;
void [stages, submitted, negotiated, chunks, bytes, providerCode, status, codes, missingFeed];
