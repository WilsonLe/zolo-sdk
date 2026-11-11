// @ts-expect-error internal preparation is absent from the public root
import { prepareSignedChatVideo } from 'zalo-personal-sdk';
// @ts-expect-error internal issuance is absent from the public root
import { createUploadedChatVideo } from 'zalo-personal-sdk';
// @ts-expect-error internal action inspection is absent from the public root
import { isChatMediaUploadActionUsed } from 'zalo-personal-sdk';
// @ts-expect-error internal action retirement is absent from the public root
import { retireChatMediaUploadAction } from 'zalo-personal-sdk';
// @ts-expect-error no private media subpath is exported
import * as privateMedia from 'zalo-personal-sdk/dist/chat-media-upload.js';
void [prepareSignedChatVideo,createUploadedChatVideo,isChatMediaUploadActionUsed,retireChatMediaUploadAction,privateMedia];

import type { UploadChatVoiceInput, UploadChatVideoInput, UploadChatVideoThumbnailInput,
 UploadedChatVoice, UploadedChatVideo, UploadedChatVideoThumbnail,
 SendUploadedChatVoiceOptions, SendUploadedChatVideoOptions, ChatMediaSendResult } from 'zalo-personal-sdk';
type ExistingMediaContract = [UploadChatVoiceInput,UploadChatVideoInput,UploadChatVideoThumbnailInput,
 UploadedChatVoice,UploadedChatVideo,UploadedChatVideoThumbnail,SendUploadedChatVoiceOptions,
 SendUploadedChatVideoOptions,ChatMediaSendResult];
declare const preservedMediaTypes: ExistingMediaContract;
void preservedMediaTypes;
