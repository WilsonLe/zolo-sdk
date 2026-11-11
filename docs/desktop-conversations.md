# Conversation read markers, sharing restrictions, and labels

These operations follow the installed macOS Zalo 26.11.10 request builders. The fixtures verify the wire payloads without using a live account. Endpoints use the service hosts advertised by the login session.

| SDK operation | Service, HTTP route, and internal command | Encrypted request fields |
| --- | --- | --- |
| `getConversationReadMarkers` | `chat`, GET `/api/preloadconvers/get-last-seen`, 12009 | `param` is a JSON string containing `{group,oneone}` arrays of IDs. |
| `getBlockSharingConversations` | `conversation`, GET `/api/conv/blocksharing/getConvers`, 12178 | Empty object. |
| `setConversationBlockSharing` | `conversation`, POST `/api/conv/blocksharing/updateConvers`, 12179 | `{threadId,isGroup,isEnabled,clientLang}`. Flags are 0 or 1 and the client language is `en` or `vi`. |
| `createConversationLabel` | `label`, POST `/api/convlabel/manage/add`, 12163 | `{labelInfo,add}`. `labelInfo` is a JSON string with `{text,color,emoji?}`. |
| `updateConversationLabel` | `label`, POST `/api/convlabel/manage/update`, 12164 | `{labelInfo,add,remove}`. `labelInfo` is a JSON string with `{id,text,color,offset}`. |
| `deleteConversationLabels` | `label`, POST `/api/convlabel/manage/delete`, 12165 | `{labelIds}`. |
| `reorderConversationLabels` | `label`, POST `/api/convlabel/manage/reorder`, 12166 | `{lsLabelInfo}`. `lsLabelInfo` is a JSON string with `[{id,offset}]` in the requested order. |

Read markers describe the signed-in account's last-seen state. The SDK accepts up to 50 IDs of each type per request and batches longer inputs. The encrypted response holds a second JSON string at `data`, whose `data.clearUnreadInfo` supplies markers. Conversation and message IDs are returned as strings. The desktop also has a WebSocket command 577 for the same read when it uses a socket.

The sharing list describes conversations with the setting enabled and indicates whether the signed-in account enabled it. Group IDs may be passed with the desktop's leading `g`, which is stripped from the update payload. The SDK sends explicit changes in invocation order within an API instance and exposes server rejection codes. Eligibility and actor checks belong to the provider.

The label routes apply individual changes, with optional membership deltas in `add` and `remove`. Use `g<groupId>` in membership arrays. Read the current label list with the SDK's existing `api.getLabels()`. The desktop selects the per-operation routes when server configuration enables label API version 2. Its version 1 flow sends a complete revisioned list to `/api/convlabel/update`, exposed as `api.updateLabels()`.

The version 2 routes take no request revision and may return `version`, `oldVersion`, `lastUpdateTime`, and affected `labelData`. Pass the cache revision as `localVersion` to compute `shouldResync` from the server's prior revision. A mismatch means the mutation response cannot bring the whole cache current. The SDK reports that condition without fetching or replacing the cache. Label changes are sent in invocation order within an API instance.

The [installed SHARED member](desktop-evidence.md) contains the last-seen builder at byte 12,522,351, response consumer at 13,672,471, label serializers at 3,287,720, and command tables at 7,245,650 and 14,216,377. The installed `pc-dist/lazy/main-startup.89bb530b91927fd5dd28.js` member has SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. Its label request and revision logic starts at 1,938,150 and its sharing request builder starts at 2,056,870. Its sharing response consumer and toggle builder are at 2,067,180 and 2,079,616.
