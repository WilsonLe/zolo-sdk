# Direct-conversation pins and group reminder responses

The direct-board helpers support an explicit versioned workflow for reading pinned topics, pinning an existing ordinary text message, replacing the full ordering, and unpinning selected topics. They do not create or send a message. The application owns the board cache and the version associated with it.

```ts
import {
  getPinnedDirectBoard, pinDirectTextMessage,
  reorderDirectBoardItems, unpinDirectBoardItems,
} from 'zalo-personal-sdk';

const board = await getPinnedDirectBoard(api, peerId);
const created = await pinDirectTextMessage(api, {
  conversationId: peerId,
  version: board.version,
  message: {
    messageId: existingMessage.msgId,
    clientMessageId: existingMessage.cliMsgId,
    senderId: existingMessage.senderId,
    senderName: existingMessage.senderName,
    text: existingMessage.text,
  },
});

// Re-read a full board before constructing an application-chosen complete order.
const current = await getPinnedDirectBoard(api, peerId);
const order = applicationChosenOrder(current.topics);
const reordered = await reorderDirectBoardItems(api, peerId,
  order.map(topic => ({ topicId: topic.id, topicType: topic.type })),
  { version: current.version });
```

IDs and application functions in this example belong to the caller. Use the actual confirmed ordinary message's identity and text. This is a plaintext metadata operation for ordinary messages; it does not decrypt or pin an encrypted frame, recover missing message content, construct arbitrary media metadata, or provide a plaintext fallback for E2EE operations.

`getPinnedDirectBoard(api, conversationId, knownVersion = 0, signal?)` returns `{version,topics,raw}`. Each topic has normalized string `id`, numeric `type`, and its retained provider fields. Nonempty string `params` is decoded once; a string `params.extra` inside an object is decoded once as the installed consumer does. The SDK does not invent a universal params/extra schema across message, note, poll, and reminder topics. A present empty topic list remains empty. A missing list or version is invalid; it does not become a fabricated empty current board. Use the default revision zero when requesting the full board needed for a mutation.

The existing upstream `api.getFriendBoardList()` remains available as its separate raw read. Its declared `data: string[]` is not used as proof of a row format: the installed consumer iterates topic objects and decodes each object's params. This helper provides that established normalization and a caller-supplied known revision without injecting an IMEI member absent from the installed builder.

`pinDirectTextMessage(api,input)` requires `conversationId`, the current server `version`, and a confirmed message's `messageId`, `clientMessageId`, `senderId`, and unchanged `text`. `senderName` defaults to `''`. It uses the observed message-topic type `2`, text-message type `1`, pushpin emoji `📌`, `startTime:-1`, `duration:-1`, `repeat:0`, `src:-1`, and `pinAct:1`. Optional signed 32-bit `color` overrides the first numeric `settings.group.topic_colors` entry; absent configuration leaves color omitted, as the installed producer's undefined field does. Language uses the API's current `vi`/`en` value or an explicit `language` option. The result retains `{data:topic,version}` and provider extensions.

`reorderDirectBoardItems(api, conversationId, topics, options)` submits the caller's **complete desired order** of `{topicId,topicType}` references. `unpinDirectBoardItems` submits the selected subset with the same signature. Both require `options.version` and return the provider's `version` plus retained response fields. They do not manufacture a returned topic list from the input or update local board state. Empty lists are rejected: use selected references for unpinning, and a nonempty full ordering for reordering.

One mutation can be active per API instance and direct conversation. A second overlapping create/reorder/unpin call fails with a fixed busy message before another request starts. Different conversations can proceed independently. This guard does not synchronize other SDK instances or another device. Caller-owned state still requires one writer and reconciliation after conflicts or uncertain outcomes. The SDK never increments a revision locally or retries a stale revision automatically.

All these routes change or read pins for a direct conversation using the `friend_board` service:

| Function | Exact method/path | Encrypted JSON fields |
| --- | --- | --- |
| `getPinnedDirectBoard` | GET `/api/friendboard/list` | `{conversationId,version}` |
| `pinDirectTextMessage` | GET `/api/friendboard/create` | `{conversationId,topic,version,lang}`; `topic.params` is a JSON string |
| `reorderDirectBoardItems` | GET `/api/friendboard/reorder` | `{conversationId,topics:[{topicId,topicType}],version,lang}` |
| `unpinDirectBoardItems` | GET `/api/friendboard/multi_unpin` | `{conversationId,topics:[{topicId,topicType}],version,lang}` |

Despite their verbs, three GETs are mutations. Every request uses the usual common client query and account-AES `params` query, rejects redirects, and adds no IMEI or language member beyond the shown `lang` fields. No request is retried automatically. A provider rejection retains its numeric `ZaloProtocolError.providerCode`; it is not silently followed by a refresh and replay. Cancellation, transport failure, or malformed mutation acknowledgment can leave the outcome unknown. Read a current board and reconcile before deciding on another submission. A failed result parse does not roll back remote state.

Local SDK bounds are 1,000 topics per returned list/reference array, 40 decimal digits per identifier/revision, 64 KiB UTF-8 per pinned text, and 4 KiB per sender name. These are not proven provider maxima or pin-count entitlements. Direct conversation/sender IDs are positive decimal strings without the group prefix. Topic IDs and revisions retain decimal formatting and large-integer precision. Numeric-equivalent duplicate references are rejected. Server permissions, feature availability and pin limits remain authoritative.

## Group reminder responses

`respondToGroupReminder(api, groupId, eventId, 'accept' | 'reject', signal?)` is a separate explicit operation for an existing group reminder. It sends POST `/api/board/topic/updateEventResponse` on `group_board` with account-AES form JSON `{grid,type,eventId,imei}`. Accept is `1`; reject is `2`. The UI's `NONE:0` state is not exposed as an unproved reset operation. The group ID accepts the optional Desktop `g` prefix and sends the raw ID.

This helper returns `void` after acknowledgment, including a successful empty acknowledgment. It does not fabricate updated participant counts or the caller's cached `myResp`. Read fresh reminder details or use existing `api.getReminderResponses(eventId)` for authoritative participant lists. It neither creates a reminder nor accepts a personal task assignment. It follows the same no-retry, redirect rejection and uncertain-submission rules as the direct-board mutations.

## Existing and historical coverage

The existing upstream methods already cover group note/reminder create/edit through `/api/board/topic/createv2` and `updatev2`, direct reminders through the separate `/api/board/oneone/*` family, board/reminder reads, and polls. Existing [group board operations](desktop-gaps.md#boards-and-message-actions) cover modern group pinning, batch unpinning, reordering and topic deletion.

The shipped `/api/board/topic/create` and `update`, and `/api/board/pin` and `unpin`, are legacy branches selected when the modern group-board flags are disabled. Their modern equivalents are already implemented; this slice does not add duplicate feature-downgrade wrappers. The old `/api/group/topic/remove` builder takes only a group ID and has no established active high-level caller in the selected source. It is not equated with deleting a particular board topic. No automatic legacy fallback, arbitrary announcement serializer, or fabricated response contract is added.

Evidence uses installed Desktop 26.11.10 MAIN, SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`, and SHARED, SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. Offsets are zero-based UTF-8 bytes. [Artifact identity](desktop-evidence.md)

| Bytes | Evidence |
| --- | --- |
| MAIN `1084200`–`1089000` | Four exact friendboard GET builders, params/extra JSON serializers, source/pin defaults, response data/version wrappers |
| `1052989`–`1054300` | `{topicId,topicType}` projection, topic ID/type normalization, params/extra decoding |
| `1072689`–`1076000`, `1077200`–`1080300` | Read current cached/server version before mutations; use returned version and explicit local cache reconciliation |
| `1096300`–`1101480` | Existing-message producer, text field projection, palette color, emoji, ordinary-message defaults and full-order raising |
| SHARED `1531610`–`1531640`, `1531089`, `16741406`, `13876538` | Topic type 2, text message type 1, text pushpin selection and emoji mapping |
| `12520093`, `1539581`, `231742`–`232600` | Group event-response builder, accept/reject enum, and acknowledgment-driven UI counts |
| `12492100`–`12495600`, `12495600`–`12497500` | Feature-gated old/new group create/update and pin/unpin builders |
| `12446197` | Separate old group-topic removal builder without a topic ID |

`test/friend-board.test.mjs` independently decrypts synthetic requests and encrypts synthetic responses. It covers exact five-helper routes and serializers, large versions/topic IDs, topic params/extra decoding, preserved provider fields, color omission/override, read and response schemas, acknowledgment-only group status changes, per-conversation overlap/cancellation cleanup, invalid inputs, provider refusals, malformed responses and sanitized uncertain transport failures. No live pin, unpin, reorder, reminder response, message or announcement mutation was performed.

On 6 November 2026, a separate saved-Web-session read for one existing friend's direct conversation accepted revision zero and returned zero topics with a provider revision. Only counts and the presence of a revision were printed; no conversation identity or topic content was logged. Populated topic rows and all mutations remain fixture-verified.
