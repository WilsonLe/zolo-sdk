// Independent047 negative public-import checks. Root compiles without skipLibCheck.
// @ts-expect-error new pure snapshot helper stays private at root
import { snapshotSignedSavedVideoThumbnail } from 'zalo-personal-sdk';
// @ts-expect-error new pure snapshot helper stays private at e2ee
import { snapshotSignedSavedVideoThumbnail as e2eeSnapshot } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error the fixed operation is exported at root only
import { uploadSignedSavedVideoThumbnail as e2eeSaved } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error existing thumbnail preparation stays private at root
import { prepareSignedChatVideoThumbnail } from 'zalo-personal-sdk';
// @ts-expect-error existing thumbnail issuance stays private at root
import { createUploadedChatVideoThumbnail } from 'zalo-personal-sdk';
// @ts-expect-error existing video preparation stays private at root
import { prepareSignedChatVideo } from 'zalo-personal-sdk';
// @ts-expect-error existing video issuance stays private at root
import { createUploadedChatVideo } from 'zalo-personal-sdk';
// @ts-expect-error existing action inspection stays private at root
import { isChatMediaUploadActionUsed } from 'zalo-personal-sdk';
// @ts-expect-error existing action retirement stays private at root
import { retireChatMediaUploadAction } from 'zalo-personal-sdk';
// @ts-expect-error existing thumbnail preparation stays private at e2ee
import { prepareSignedChatVideoThumbnail as e2eePrepareThumb } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error existing thumbnail issuance stays private at e2ee
import { createUploadedChatVideoThumbnail as e2eeIssueThumb } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error existing video preparation stays private at e2ee
import { prepareSignedChatVideo as e2eePrepareVideo } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error existing video issuance stays private at e2ee
import { createUploadedChatVideo as e2eeIssueVideo } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error existing action inspection stays private at e2ee
import { isChatMediaUploadActionUsed as e2eeInspectAction } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error existing action retirement stays private at e2ee
import { retireChatMediaUploadAction as e2eeRetireAction } from 'zalo-personal-sdk/e2ee';
// @ts-expect-error private media module subpath remains closed
import * as privateMedia from 'zalo-personal-sdk/dist/chat-media-upload.js';
// @ts-expect-error private signed staging module subpath remains closed
import * as privateSigned from 'zalo-personal-sdk/dist/signed-photo-upload.js';
void [snapshotSignedSavedVideoThumbnail, e2eeSnapshot, e2eeSaved, prepareSignedChatVideoThumbnail,
  createUploadedChatVideoThumbnail, prepareSignedChatVideo, createUploadedChatVideo,
  isChatMediaUploadActionUsed, retireChatMediaUploadAction, e2eePrepareThumb, e2eeIssueThumb,
  e2eePrepareVideo, e2eeIssueVideo, e2eeInspectAction, e2eeRetireAction, privateMedia, privateSigned];
