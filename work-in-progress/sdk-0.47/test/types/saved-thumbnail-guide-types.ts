import {
  uploadSignedSavedVideoThumbnail, uploadSignedChatVideo, sendUploadedChatVideo,
} from 'zalo-personal-sdk';
import type { API, RealtimeFrameFeed } from 'zalo-personal-sdk';

export async function sendSavedClip(
  api: API,
  feed: RealtimeFrameFeed,
  thumbnailActionId: number,
  videoActionId: number,
  preview: { fileName: string; bytes: Uint8Array },
  clip: {
    fileName: string; bytes: Uint8Array;
    width: number; height: number; durationMs: number;
  },
) {
  if (!Number.isSafeInteger(thumbnailActionId) || thumbnailActionId < 1
    || !Number.isSafeInteger(videoActionId) || videoActionId < 1
    || thumbnailActionId === videoActionId) {
    throw new TypeError('Supply two distinct positive safe-integer action IDs.');
  }
  const thumbnail = await uploadSignedSavedVideoThumbnail(api, {
    feed, clientId: thumbnailActionId,
    fileName: preview.fileName, bytes: preview.bytes,
  });
  const destination = {
    threadType: thumbnail.threadType, threadId: thumbnail.threadId,
  };
  const video = await uploadSignedChatVideo(api, {
    ...destination, feed, clientId: videoActionId,
    fileName: clip.fileName, bytes: clip.bytes,
    width: clip.width, height: clip.height, durationMs: clip.durationMs,
  });
  return sendUploadedChatVideo(api, video, { thumbnail, title: 'Clip' });
}
