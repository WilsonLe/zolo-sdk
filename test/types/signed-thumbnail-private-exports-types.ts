// Source-blind public-boundary negatives; Root compiles without skipLibCheck.
// @ts-expect-error enabling preparation stays private at the root
import { prepareSignedChatVideoThumbnail } from 'zalo-personal-sdk';
// @ts-expect-error existing receipt issuance stays private at the root
import { createUploadedChatVideoThumbnail } from 'zalo-personal-sdk';
// @ts-expect-error old video preparation remains private at the root
import { prepareSignedChatVideo } from 'zalo-personal-sdk';
// @ts-expect-error old video issuance remains private at the root
import { createUploadedChatVideo } from 'zalo-personal-sdk';
// @ts-expect-error shared action inspection remains private at the root
import { isChatMediaUploadActionUsed } from 'zalo-personal-sdk';
// @ts-expect-error shared action retirement remains private at the root
import { retireChatMediaUploadAction } from 'zalo-personal-sdk';
// @ts-expect-error private feed authority remains private at the root
import { ownedRealtimeFrameFeedAccess } from 'zalo-personal-sdk';
// @ts-expect-error private cancellation authority remains private at the root
import { createProtocolAbortScope } from 'zalo-personal-sdk';
// @ts-expect-error enabling preparation stays private at e2ee
import { prepareSignedChatVideoThumbnail as e2eePrepareThumbnail } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error receipt issuance stays private at e2ee
import { createUploadedChatVideoThumbnail as e2eeIssueThumbnail } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error old video preparation remains private at e2ee
import { prepareSignedChatVideo as e2eePrepareVideo } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error old video issuance remains private at e2ee
import { createUploadedChatVideo as e2eeIssueVideo } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error shared action inspection remains private at e2ee
import { isChatMediaUploadActionUsed as e2eeInspectAction } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error shared action retirement remains private at e2ee
import { retireChatMediaUploadAction as e2eeRetireAction } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error private feed authority remains private at e2ee
import { ownedRealtimeFrameFeedAccess as e2eeFeedAuthority } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error private cancellation authority remains private at e2ee
import { createProtocolAbortScope as e2eeAbortAuthority } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error new runtime operation exports from the root only
import { uploadSignedChatVideoThumbnail as e2eeUploadThumbnail } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error new runtime error exports from the root only
import { SignedVideoThumbnailUploadError as E2EEThumbnailError } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error private media implementation subpath remains closed
import * as privateMedia from 'zalo-personal-sdk/dist/chat-media-upload.js';
void [prepareSignedChatVideoThumbnail, createUploadedChatVideoThumbnail, prepareSignedChatVideo,
  createUploadedChatVideo, isChatMediaUploadActionUsed, retireChatMediaUploadAction,
  ownedRealtimeFrameFeedAccess, createProtocolAbortScope, e2eePrepareThumbnail, e2eeIssueThumbnail,
  e2eePrepareVideo, e2eeIssueVideo, e2eeInspectAction, e2eeRetireAction, e2eeFeedAuthority,
  e2eeAbortAuthority, e2eeUploadThumbnail, E2EEThumbnailError, privateMedia];
