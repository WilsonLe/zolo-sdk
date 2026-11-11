# Desktop operations beyond the web adapter

This inventory follows the installed Zalo **26.11.10** archive. Byte offsets refer to the `SHARED` member identified in the [desktop evidence](desktop-evidence.md). The matching Zalo Web startup chunk independently establishes the same request paths, payloads, and response handling. Authenticated server compatibility remains unverified for these routes.

## Recent conversation previews

The desktop app asks for previews on startup. It passes its last locally cached message ID per conversation, or an empty map on a cold start. The response supplies a bounded recent preview feed.

| Part | Static contract | SHARED byte offset |
| --- | --- | --- |
| Route | `GET /api/preloadconvers/get-last-msgs` on the `conversation` service. Internal command ID `10053`. Include normal `zpw_ver` and `zpw_type` query parameters. | 2,677,097 and 12,522,049 |
| Request | Encrypt and URL-encode a JSON object with `imei` and `threadIdLocalMsgId`, a JSON string holding the cursor map. Map keys are `<userId>_0` for a direct conversation and `<groupId>_1` for a group. Values are the last message IDs. | 3,702,535 and 12,522,049 |
| Response | Decrypt the HTTP JSON body's `data` field with the account session key and parse the resulting JSON. The preview-specific client parser reads the decoded payload directly. The decoded object's `data` carries optional arrays `msgs`, `groupMsgs`, and `pageMsgs`, plus receipt and status fields such as `clearUnreads`, `clearUnreadsReact`, and `seens`. The desktop concatenates the three message arrays and adds per-message conversation metadata to derive `allmsgs`. | 12,118,914, 3,214,540, and 805,620 |

Preserve IDs as strings at the JSON boundary. The desktop parser quotes ID fields before parsing and includes `uidFrom`, `uidTo`, `uid`, `ownerId`, `destId`, `srcId`, `globalMsgId`, `globalDelMsgId`, `msgId`, `refMessageId`, `actionId`, `lastActionIdOther`, `lastActionId`, `resetLastActionId`, `lastId`, and `ids` in that handling. The request uses the session installation identifier that the existing web adapter calls `imei`. No extra device data is needed by this call.

## Group cloud history

This is a separate service from the adapter's existing `getGroupChatHistory`, which uses `/api/group/history` with `{grid,count}`. The desktop consults local storage first and may fill gaps by calling the cloud service. The app gates the cloud paths by per-operation configuration and limits that path to groups and feature-enabled self-chat. Regular direct conversation history in the inspected desktop flow is loaded locally.

| Part | Static contract | SHARED byte offset |
| --- | --- | --- |
| Routes | `GET /api/cm/getrecentv2` (12506) and `GET /api/cm/getoldv2` (12507) on the `group_cloud_message` service. Use the normal `zpw_ver` and `zpw_type` query parameters. | 2,697,693 and 12,506,080 |
| Request | Encrypt and URL-encode `{groupId,globalMsgId,count,msgIds,imei,src}`. Strip the desktop's leading `g` from a group ID. Desktop method defaults are cursor `"0"`, count `50`, `msgIds:[]`, and `src:-1`. The call path adds `isOA:1` for its self-chat case. `msgIds` holds cached IDs used for overlap checks. | 12,506,080 and 7,823,030 |
| Response | The normal two-layer response handler checks outer and inner error codes and decrypts the outer `data` to extract the inner `data`. The cloud caller parses that data as JSON with `groupMsgs`, `isOld`, `hasMore`, and `lastMsgId`. It also reads `minMsgId` and `maxMsgId` for boundary checks. Desktop may trim deleted messages, filter duplicates, or request another page after applying local state. | 13,736,118 and 7,821,430–7,827,255 |

`GET /api/cm/rgetv2` serves jump and forward pagination. Its encrypted request includes `groupId`, `globalMsgId`, `count`, `msgJump` (1 for jump and 0 for forward pagination), `msgIds`, and `src`. The caller uses the same response handler. The SDK's `getGroupCloudHistory` accepts `mode: 'jump'` or `mode: 'newer'` with the starting `messageId`. Both relative modes and normal paging accept `count` and `excludeMessageIds`. The SDK defaults to 50, allows counts from 1 through 100, and accepts up to 100 decimal message exclusions. These are SDK bounds. Static offsets 12,506,722–12,507,297 and 7,823,384–7,824,500.

When continuing backward from a page, use its `lastMsgId` as the cursor and its `isOld` to select the route. Zalo starts with the recent route and can continue to use it with a nonzero cursor until the server returns `isOld`. The app consumes `hasMore` as a numeric flag in cloud state. The SDK can expose these flags as booleans. The desktop combines this data with locally available history and E2EE state. Those are separate responsibilities. Static offsets 1,443,851, 10,542,840–10,543,900, and 10,548,500–10,550,280.

### Cloud reply threads

`getGroupCloudThreadPage(api, groupId, { anchor, root?, reverse? })` uses the reply-thread form of `GET /api/cm/getpath` (12504). The encrypted fields are `ownerId`, `groupId`, `cliMsgId`, `globalMsgId`, and numeric `reverse`. The optional root adds `rGlobalMsgId`, `rOwnerId`, and `rClientMsgId`. The request builder sends the `nretry: 0` HTTP header. The same two-layer decoder returns JSON containing `groupMsgs`, `rootMsgId`, `isRootDel`, `hasMore`, and `lastMsgId`. IDs in the SDK response retain their string precision. Static offsets 12,117,211–12,118,601, 12,519,308–12,519,647, and 13,736,118.

For the first page, supply the starting message's sender, client message ID, and global message ID. Desktop continues from the returned message with ID `lastMsgId` and carries the established root into subsequent calls. It substitutes the signed-in account's user ID when the matching message represents self with `uidFrom: 0`. If the response supplies a cursor and a known root without a matching message record, Desktop uses null owner and client IDs for the next anchor. The SDK exposes one page at a time so the caller can decide when to continue.

The archive also contains a range form of `getpath` with `{groupId,globalMsgId,count,reverse}` and an encrypted GET `/api/cm/mget` builder (12503) that sends `{groupIds}` and a caller-supplied `nretry` header. Scanning the complete packed archive found those builders without response consumers. `/api/cm/pc/dl` (12509) appears in the group cloud command map. Its method, parameters, and download response remain unestablished. Static offsets 12,507,309–12,507,580, 12,519,666–12,519,887, and 2,697,829.

## Other identified gaps

| Gap | Desktop evidence | What remains |
| --- | --- | --- |
| Group activity statistics | Group service `GET /api/group/analyse` (12407) with encrypted `{grid}`. The normal response helper returns plaintext JSON whose `data` array has `time`, `txtmsg`, `totalmsg`, `photomsg`, `stickermsg`, `filemsg`, `useractive`, `usernew`, and `userleft`. Offsets 12,501,057, 12,110,471, and 9,587,019. | Enough static evidence to build the read operation with defensive decoding. The server's eligibility rules and field nullability need an authenticated fixture. |
| Community quotas | Group service `GET /api/group/quota/community` (12181) with encrypted `{language,grId}` and `GET /api/group/quota/members-comm` (12182) with encrypted `{language,grId,uid}`. Group ID is nullable in the first request. Both use the normal response handler. Offsets 12,448,857–12,449,423 and 11,967,707–11,967,878. | The response envelope is established. The client wrappers do not expose inner quota fields, and the current UI quota component reads package configuration separately. An authenticated fixture is needed to define a typed response. |
| E2EE direct and group text | The app calls its Signal protocol manager to encrypt message and style fields and gets ciphertexts with recipient/device and registration metadata. It posts to `/api/e2ee/pc/message/sms` or `/api/e2ee/pc/group/sms` using separate service keys `chat_e2e` and `group_e2e`. The direct payload carries serialized recipient parameters, destination type, thread ID, and client ID. The group path uses a group ciphertext parameter object. Offsets 10,596,520–10,598,500 and 12,450,587–12,451,380. | The SDK implements cryptographic primitives and caller-driven distribution and delivery. Durable enrollment keys, automatic key-change handling, and live provider interoperability are open. See [encrypted chat](e2ee.md) and [group keys](e2ee-group.md). |
| Voice and video calls | The `voice_call` service has signaling for request, ring, answer, acknowledgment, and group operations. Renderer callbacks exchange call state with the native `zcall` module through Electron IPC. Signaling passes codec, RTP and RTCP addresses, call ID, and session identifiers. Offsets 2,694,823–2,695,881, 12,469,470–12,471,200, and 7,260,100–7,261,460. | The SDK connects the installed macOS media helper and has isolated lifecycle evidence. Account-to-account ringing, answer, media transport, and hangup need a controlled live call. See [native helper](native-call-bridge.md). |
| Direct message archive and mobile transfer | Desktop message loading queries local conversation storage. The separate transfer path uses `/api/transfer-sync-v2/request-sync`, `/api/message/pull_mobile_msg`, and `/api/message/get_crossdb` with a sync session and mobile transfer data. Offsets 10,542,840–10,543,900 and 12,507,760–12,508,995. | Recent previews and the web listener's account-level history can feed an SDK-managed archive. A complete per-conversation server history contract for ordinary direct messages has not been established. The transfer path depends on another device and its snapshot or sync state. |

## Matching public web build

On 5 November 2026, the public `chat.zalo.me` HTML referenced `render.081738ba2350940a6b28.js`. The renderer's startup chunk map and import list resolve chunk 1 to `1.c72c0957b455ab70b73c.js`. That chunk is 16,302,277 bytes with SHA-256 `29784a88e51221a64f854b059e49e68707ae58cee7a4114bc722ce028a887bf1`. [Zalo Web](https://chat.zalo.me/) · [Renderer](https://zalo-chat-static.zadn.vn/v1/render.081738ba2350940a6b28.js) · [Startup chunk](https://zalo-chat-static.zadn.vn/v1/lazy/1.c72c0957b455ab70b73c.js)

| Operation | Offsets in Web chunk 1 |
| --- | --- |
| Conversation previews | Request 11,693,354–11,693,621. Cursor map 3,401,271. Wrapper 11,300,210–11,300,540. Preview decrypt and message arrays 3,056,412–3,057,640. |
| Group cloud history | Requests 11,677,320–11,678,580. Cloud data parsing and mode dispatch 7,059,250–7,061,200. Prior-page `isOld` controls route selection at 9,736,593–9,736,800. Cloud state compares `hasMore` to numeric flags at 14,036,193 and 14,036,794. |
| Group activity statistics | Request 11,672,140–11,672,670. The generic encrypted response helper at 12,802,777 yields inner plaintext. The activity view parses that plaintext as JSON and consumes its `data` array at 8,834,946. |
| Community quotas | Requests 11,620,070–11,620,800. The generic encrypted response helper unwraps the payload. |
| Other routes | E2EE text routes at 2,510,089 and 2,510,771. E2EE send helper at 11,621,869. Call signaling begins at 11,640,904. Mobile transfer request at 11,680,227. Their presence in the shared Web bundle establishes the route spelling and request builders. Active feature availability remains unverified. |

## Additional SDK reads

These helpers use the account AES transport and preserve decimal message identifiers as strings. Offsets refer to the installed `SHARED` member.

| SDK export | Request and response | SHARED offsets |
| --- | --- | --- |
| `getBlockedFriends` | `GET /api/friend/blocklistv2` on `friend` with `page`, `count:50`, and `avatar:75`. The response carries `profiles`, `version`, and `has_more`. | 12,442,597 and 11,707,010 |
| `getImportantMessages` | `GET /api/message/fetchImportant` on `chat` with the current `uid`, `limit:50`, and one of `newestId` or `lastId`. `lastId:"-1"` requests the initial page. Decode the response's `message` JSON for `msgs`, `groupMsgs`, and `more`. | 12,461,302 and 12,933,337–12,934,350 |
| `getMessageStatus` | `POST /api/message/getStatusMsg` on `chat` or `/api/group/getStatusMsg` on `group`. The encrypted form object includes `param: JSON.stringify({data:[{tId, ids?}]})`. For groups, `ids` holds member IDs. The HTTP result includes JSON under `data` and the decoded status envelope contains `data.statusInfos[].ids`. Each entry has a member `id` and optional opaque string `seen` and `deliver` cursors. | 7,849,787–7,851,300, 7,852,900–7,853,692, and 12,522,852–12,523,394 |
| `getCommunityQuota`, `getCommunityMemberQuota` | `GET /api/group/quota/community` and `/api/group/quota/members-comm` on `group`, with session `language`, `grId`, and `uid` for the latter. The SDK returns the decoded provider payload. | 12,448,857–12,449,423 and 11,967,707–11,967,878 |

## Boards and message actions

The installed desktop app supplies these parameters to the account AES transport. Board updates take the revision from the pin-list response and pass it to Zalo unchanged. A stale version can cause a server conflict.

| SDK operation | Desktop contract | SHARED offsets |
| --- | --- | --- |
| `getPinnedGroupBoard` | `GET /api/board/pin/list` on `group_board` with `groupId`, `boardVersion`, and `imei`. The consumer reads `items`, `boardVersion`, and `pinLimit`. | 12,491,120–12,491,585 and 13,652,218 |
| `pinGroupBoardItem` | `GET /api/board/pinv2` with `grid`, `topicId`, and `type`. | 12,495,400–12,496,050 |
| `unpinGroupBoardItems`, `reorderGroupBoardItems` | `GET /api/board/multi_unpin` and `POST /api/board/pin/update`. Both send `topics` references and `boardVersion`. The first uses `grid` and the second uses `groupId`. | 12,491,585–12,491,975, 12,496,720–12,497,150, and 13,661,409 |
| `removeGroupBoardTopic` | `POST /api/board/topic/remove` with `grid`, `topicId`, and `imei`. | 12,495,070–12,495,580 |
| `recallMessages` | `POST /api/message/multi_undo` for direct threads or `/api/group/multi_undomsg` for groups. Each ordinary message supplies `cliMsgId`, `cliMsgIdUndo`, and normalized `globalMsgId`. The caller supplies a fresh action ID for each message. | 2,886,800–2,887,660 and 12,513,780–12,514,145 |
| My Documents | The app stores `send2me_id` from account bootstrap and uses it as the private conversation destination. The plain-text send uses the usual direct or group route according to conversation type. For cloud history the app sets `isOA:1` on both page and relative-position requests. | 7,006,261, 11,982,374, 12,452,429, 7,822,910, and 12,505,680–12,507,600 |

My Documents is Zalo's private storage conversation for the account. [Zalo Help](https://help.zalo.me/huong-dan/chuyen-muc/nhan-tin-va-goi/nhan-tin/my-documents-tren-zalo/)

## Phone/PCloud key recovery

The experimental [phone/PCloud coordinator](pcloud-phone-key.md) now joins a single explicit account-AES phone prompt to a pinned self-slot0 Signal reply and an atomic protected device/conversation/key disposition. It supports explicit zero-GET resume, storage-only repair and separate offline key-only enrollment restore. This closes a local SDK workflow gap; actual phone format, native self-session and resource interoperability remain unverified. Protected resource fetching, key rotation/multiple versions and complete archived-session promotion remain separate work.

## Experimental group page reads

The SDK adds three explicit reads through the ordinary account `group` service. Each returns one provider response and keeps paging, raw records and reconciliation with the application. [Group-page guide](group-pages.md).

| Read | Exact source request | Reachability and evidence limit |
| --- | --- | --- |
| V3 group list page | `GET /api/group/getlg/v3`, encrypted `{page,count,avatar_size:160,member_avatar_size:160,imei}`; SHARED 12,416,930–12,417,258. | A compiled personal UI/cache-miss chain exists. The old full-list startup path is gated by shipped `enable_flow_v2:true`; the richer suggestions wrapper has no proved active call in the bounded search. |
| V2 group member page | `GET /api/group/getgi/v2`, encrypted `{grid,avatar_size:160,member_avatar_size:160,mpage,mcount,imei}`; SHARED 12,418,288–12,418,667. | Both traced consumers are legacy/default-gated by `enable_flow_v2:true` and `drop_legacy_ginfo_api:1`. They use different continuation predicates; `hasMoreMember` remains raw. |
| Encrypted group IDs | `GET /api/group/getlg/e2ee`, common query only, with no `params`, IMEI or language; SHARED 12,417,400–12,417,546. | Native synchronization is feature/default-gated by shipped `deactivated:true` and `enable_grlist_sync_check:false`. Its local two-fetch/timestamp scheduling is not a server TTL or completeness rule. |

These are static installed-source observations, not effective account flags or live server acceptance. No lookup fallback, automatic pager, E2EE store seeding, key operation or private application-setting access is included. Existing V4 `getAllGroups`, batch `getGroupInfo`, supplied-user `getGroupMembersInfo` and purpose/role `getGroupContexts` keep their distinct contracts.
