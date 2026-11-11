import { uploadSignedChatVideo, SignedVideoUploadError, uploadSignedChatPhoto,
  uploadChatVideoThumbnail, sendUploadedChatVideo,
  type API, type RealtimeFrameFeed, type UploadChatVideoInput,
  type UploadSignedChatVideoInput, type SignedUploadedChatVideo, type UploadedChatVideo,
  type UploadSignedChatPhotoInput } from 'zalo-personal-sdk';

declare const api: API, feed: RealtimeFrameFeed;
const input: UploadSignedChatVideoInput = { threadType: 'user', threadId: '123', clientId: 45,
  bytes: new Uint8Array(16), fileName: 'clip.mp4', width: 1920, height: 1080, durationMs: 1000,
  feed, chunkSize: 1, timeoutMs: 600000, signal: new AbortController().signal };
const result: Promise<SignedUploadedChatVideo> = uploadSignedChatVideo(api, input);
async function interoperability(): Promise<void> {
  const signed = await result;
  const existing: UploadedChatVideo = signed;
  const source: 'provider' | 'local' = signed.fileIdSource;
  void source;
  const thumbnail = await uploadChatVideoThumbnail(api, { threadType: 'user', threadId: '123', clientId: 46,
    bytes: new Uint8Array(4), fileName: 'preview.jpg', feed });
  await sendUploadedChatVideo(api, existing, { thumbnail, title: 'caller title', properties: '{"source":"caller"}', ttl: 1 });
  // @ts-expect-error receipt metadata is readonly
  signed.width = 10;
  // @ts-expect-error provenance is readonly
  signed.fileIdSource = 'local';
}
void interoperability;
declare const raw: UploadChatVideoInput;
// @ts-expect-error the existing raw video's optional feed cannot satisfy the required signed feed
uploadSignedChatVideo(api, raw);
// @ts-expect-error feed is required
const missingFeed: UploadSignedChatVideoInput = { threadType: 'user', threadId: '123', clientId: 45,
  bytes: new Uint8Array(16), fileName: 'clip.mp4', width: 1, height: 1, durationMs: 1 };
// @ts-expect-error there is no general upload-kind extension
uploadSignedChatVideo(api, { ...input, kind: 'voice' });
// @ts-expect-error metadata type is numeric
uploadSignedChatVideo(api, { ...input, durationMs: '1000' });
// @ts-expect-error caller does not choose an authorization URL
uploadSignedChatVideo(api, { ...input, uploadUrl: 'https://example.invalid' });
const error = new SignedVideoUploadError('session-update-failed', 'upload');
// @ts-expect-error public constructor grants no fact argument
new SignedVideoUploadError('rejected', 'upload', { submitted: true });
// @ts-expect-error only negotiate/upload are public stages
new SignedVideoUploadError('rejected', 'send');
// @ts-expect-error unknown codes are not admitted
new SignedVideoUploadError('request-failed', 'upload');
const stages: 'negotiate' | 'upload' = error.stage;
const submitted: boolean = error.submitted, negotiated: boolean = error.negotiationSubmitted;
const chunks: number = error.acceptedChunks, bytes: number = error.acceptedBytes;
const providerCode: number | undefined = error.providerCode, status: number | undefined = error.status;
const codes: Record<SignedVideoUploadError['code'], true> = { aborted: true, timeout: true, busy: true,
  'action-reused': true, 'feed-unavailable': true, rejected: true, 'invalid-response': true,
  'stale-upload': true, incomplete: true, 'submission-unknown': true, 'session-update-failed': true };
// @ts-expect-error facts cannot be assigned
error.submitted = true;
// @ts-expect-error codes cannot be assigned
error.code = 'timeout';
// @ts-expect-error stages cannot be assigned
error.stage = 'negotiate';
// @ts-expect-error facts cannot be assigned
error.acceptedChunks = 3;
// @ts-expect-error facts cannot be assigned
error.acceptedBytes = 10;
// @ts-expect-error facts cannot be assigned
error.providerCode = 0;
// @ts-expect-error facts cannot be assigned
error.status = 200;
// @ts-expect-error facts cannot be assigned
error.negotiationSubmitted = true;
void [stages, submitted, negotiated, chunks, bytes, providerCode, status, codes, missingFeed];

const legacy: UploadSignedChatPhotoInput = { threadType: 'user', threadId: '123', clientId: 47,
  bytes: new Uint8Array(4), fileName: 'photo.jpg', quality: 'original', width: 1, height: 1, feed, timeoutMs: 120000 };
void uploadSignedChatPhoto(api, legacy);
