import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as sdk from 'zalo-personal-sdk';
import * as e2ee from 'zalo-personal-sdk/e2ee';
test('public roots exclude internal media issuance/action/preparation and private subpaths',async()=>{
 for(const m of [sdk,e2ee])for(const n of ['prepareSignedChatVideo','createUploadedChatVideo','isChatMediaUploadActionUsed','retireChatMediaUploadAction','ownedRealtimeFrameFeedAccess','createProtocolAbortScope'])assert.equal(Object.hasOwn(m,n),false,n);
 await assert.rejects(import('zalo-personal-sdk/dist/chat-media-upload.js'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
 for(const n of ['uploadChatVoice','uploadChatVideo','uploadChatVideoThumbnail','sendUploadedChatVoice','sendUploadedChatVideo','ZaloChatMediaError','uploadSignedChatVideo','SignedVideoUploadError'])assert.equal(typeof sdk[n],'function',n);
});
