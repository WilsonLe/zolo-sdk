// Independent047 source-blind strict public contract. Root compiles only.
import { uploadSignedSavedVideoThumbnail, uploadSignedChatVideo, sendUploadedChatVideo,
  SignedVideoThumbnailUploadError, type API, type RealtimeFrameFeed,
  type UploadSignedSavedVideoThumbnailInput, type UploadSignedChatVideoThumbnailInput,
  type SignedUploadedChatVideoThumbnail, type UploadedChatVideoThumbnail,
  type UploadedChatVideo } from 'zalo-personal-sdk';
declare const api: API, feed: RealtimeFrameFeed;
const minimal: UploadSignedSavedVideoThumbnailInput = { clientId: 47, bytes: new Uint8Array(4), fileName: 'saved.jpg', feed };
const input: UploadSignedSavedVideoThumbnailInput = { ...minimal, chunkSize: 16, timeoutMs: 600000, signal: new AbortController().signal };
const result: Promise<SignedUploadedChatVideoThumbnail> = uploadSignedSavedVideoThumbnail(api, input);
async function completeSavedClip(): Promise<void> {
  const receipt = await result;
  const existing: UploadedChatVideoThumbnail = receipt;
  const source: 'provider' | 'local' = receipt.photoIdSource;
  const video: UploadedChatVideo = await uploadSignedChatVideo(api, { threadType: receipt.threadType,
    threadId: receipt.threadId, clientId: 48, bytes: new Uint8Array(16), fileName: 'clip.mp4',
    width: 1920, height: 1080, durationMs: 1000, feed });
  await sendUploadedChatVideo(api, video, { thumbnail: existing, title: 'Saved clip', ttl: 1 });
  // @ts-expect-error existing receipt account is readonly
  receipt.accountId = '2';
  // @ts-expect-error existing receipt kind is readonly
  receipt.threadType = 'group';
  // @ts-expect-error captured destination is readonly
  receipt.threadId = '123';
  // @ts-expect-error existing action identity is readonly
  receipt.clientId = 49;
  // @ts-expect-error existing full copied size is readonly
  receipt.fileSize = 1;
  // @ts-expect-error existing provider or local ID is readonly
  receipt.photoId = '456';
  // @ts-expect-error existing result URL is readonly
  receipt.thumbnailUrl = 'https://example.invalid';
  // @ts-expect-error existing provenance is readonly
  receipt.photoIdSource = 'local';
  void source;
}
void completeSavedClip;
// @ts-expect-error callers do not supply a destination even if it matches the advertisement
uploadSignedSavedVideoThumbnail(api, { ...input, threadId: '123' });
// @ts-expect-error callers do not supply a thread kind
uploadSignedSavedVideoThumbnail(api, { ...input, threadType: 'user' });
// @ts-expect-error no caller group destination fields are admitted
const suppliedGroup: UploadSignedSavedVideoThumbnailInput = { ...input, threadType: 'group', threadId: 'g123' };
// @ts-expect-error same-API feed is required
const missingFeed: UploadSignedSavedVideoThumbnailInput = { clientId: 47, bytes: new Uint8Array(4), fileName: 'saved.jpg' };
// @ts-expect-error caller-prepared bytes are required
const missingBytes: UploadSignedSavedVideoThumbnailInput = { clientId: 47, fileName: 'saved.jpg', feed };
// @ts-expect-error action ID is required
const missingAction: UploadSignedSavedVideoThumbnailInput = { bytes: new Uint8Array(4), fileName: 'saved.jpg', feed };
// @ts-expect-error basename is required
const missingName: UploadSignedSavedVideoThumbnailInput = { clientId: 47, bytes: new Uint8Array(4), feed };
// @ts-expect-error feed interface cannot be fabricated from an empty object
uploadSignedSavedVideoThumbnail(api, { ...input, feed: {} });
// @ts-expect-error no dimensions are introduced
uploadSignedSavedVideoThumbnail(api, { ...input, width: 1 });
// @ts-expect-error no dimensions are introduced
uploadSignedSavedVideoThumbnail(api, { ...input, height: 1 });
// @ts-expect-error no duration is introduced
uploadSignedSavedVideoThumbnail(api, { ...input, durationMs: 1 });
// @ts-expect-error no rotation is introduced
uploadSignedSavedVideoThumbnail(api, { ...input, rotation: 90 });
// @ts-expect-error no metadata probe is introduced
uploadSignedSavedVideoThumbnail(api, { ...input, probeMetadata: true });
// @ts-expect-error there is no generic media kind
uploadSignedSavedVideoThumbnail(api, { ...input, kind: 'thumbnail' });
// @ts-expect-error feature9 is fixed rather than a caller control
uploadSignedSavedVideoThumbnail(api, { ...input, uploadFeature: 9 });
// @ts-expect-error there is no route selector
uploadSignedSavedVideoThumbnail(api, { ...input, route: 'saved' });
// @ts-expect-error no caller upload endpoint is exposed
uploadSignedSavedVideoThumbnail(api, { ...input, uploadUrl: 'https://example.invalid' });
// @ts-expect-error no source URL is downloaded
uploadSignedSavedVideoThumbnail(api, { ...input, url: 'https://example.invalid/preview.jpg' });
// @ts-expect-error no secure mode is exposed
uploadSignedSavedVideoThumbnail(api, { ...input, secure: true });
// @ts-expect-error no cloud knob is exposed
uploadSignedSavedVideoThumbnail(api, { ...input, cloud: true });
const error: SignedVideoThumbnailUploadError = new SignedVideoThumbnailUploadError('destination-unavailable', 'negotiate');
const code: SignedVideoThumbnailUploadError['code'] = error.code;
const stage: 'negotiate' | 'upload' = error.stage;
const negotiated: boolean = error.negotiationSubmitted, submitted: boolean = error.submitted;
const chunks: number = error.acceptedChunks, bytes: number = error.acceptedBytes;
const provider: number | undefined = error.providerCode, status: number | undefined = error.status;
// @ts-expect-error the reused public constructor cannot receive issued facts
new SignedVideoThumbnailUploadError('rejected', 'upload', { acceptedBytes: 99 });
// @ts-expect-error no new Saved error code is added
new SignedVideoThumbnailUploadError('saved-destination-changed', 'negotiate');
// @ts-expect-error existing error facts remain readonly
error.acceptedBytes = 99;
// @ts-expect-error existing error facts remain readonly
error.negotiationSubmitted = true;
// @ts-expect-error existing error facts remain readonly
error.submitted = true;
// @ts-expect-error Saved input omits ordinary destination properties
const savedHasThreadId: 'threadId' extends keyof UploadSignedSavedVideoThumbnailInput ? true : false = true;
const omitted: Omit<UploadSignedChatVideoThumbnailInput, 'threadId' | 'threadType'> = input;
void [suppliedGroup, missingFeed, missingBytes, missingAction, missingName, code, stage, negotiated, submitted, chunks, bytes, provider, status, omitted, savedHasThreadId];
