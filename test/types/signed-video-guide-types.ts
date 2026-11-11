import { readFile } from 'node:fs/promises';
import {
  uploadSignedChatVideo, uploadChatVideoThumbnail, sendUploadedChatVideo,
} from 'zalo-personal-sdk';
import type { API, RealtimeFrameFeed } from 'zalo-personal-sdk';

export async function sendClip(
  api: API,
  feed: RealtimeFrameFeed,
  recipientId: string,
  videoActionId: number,
  thumbnailActionId: number,
) {
  const destination = { threadType: 'user' as const, threadId: recipientId };
  const video = await uploadSignedChatVideo(api, {
    ...destination, feed, clientId: videoActionId,
    fileName: 'clip.mp4', bytes: await readFile('clip.mp4'),
    width: 1920, height: 1080, durationMs: 5500,
  });
  const thumbnail = await uploadChatVideoThumbnail(api, {
    ...destination, feed, clientId: thumbnailActionId,
    fileName: 'preview.jpg', bytes: await readFile('preview.jpg'),
  });
  return sendUploadedChatVideo(api, video, { thumbnail, title: 'Clip' });
}
