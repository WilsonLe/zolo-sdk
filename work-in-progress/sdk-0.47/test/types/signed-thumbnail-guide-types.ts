import { readFile } from 'node:fs/promises';
import {
  uploadSignedChatVideo, uploadSignedChatVideoThumbnail, sendUploadedChatVideo,
} from 'zalo-personal-sdk';
import type { API, RealtimeFrameFeed } from 'zalo-personal-sdk';

export async function sendSignedClip(
  api: API,
  feed: RealtimeFrameFeed,
  recipientId: string,
  videoActionId: number,
  thumbnailActionId: number,
) {
  if (!Number.isSafeInteger(videoActionId) || videoActionId < 1
    || !Number.isSafeInteger(thumbnailActionId) || thumbnailActionId < 1
    || videoActionId === thumbnailActionId) {
    throw new TypeError('Supply two distinct positive safe-integer action IDs.');
  }
  const destination = { threadType: 'user' as const, threadId: recipientId };
  const thumbnail = await uploadSignedChatVideoThumbnail(api, {
    ...destination, feed, clientId: thumbnailActionId,
    fileName: 'preview.png', bytes: await readFile('preview.png'),
  });
  const video = await uploadSignedChatVideo(api, {
    ...destination, feed, clientId: videoActionId,
    fileName: 'clip.mp4', bytes: await readFile('clip.mp4'),
    width: 1920, height: 1080, durationMs: 5500,
  });
  return sendUploadedChatVideo(api, video, { thumbnail, title: 'Clip' });
}
