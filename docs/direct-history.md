# Direct-message recovery queue

`getDirectMessageQueuePage(api, options?)` reads one page from the account's HTTP message recovery queue. It returns direct messages, an opaque cursor for the next poll, any queues that dropped entries, and a flag when the server resets the cursor. Pass an optional `threadId` to filter locally. The returned cursor still advances across the account, so fetch an unfiltered page when you need to retain messages for multiple threads.

```ts
import { getDirectMessageQueuePage } from 'zalo-personal-sdk';

const page = await getDirectMessageQueuePage(api, { cursor: previousCursor, signal });
// Commit the records and cursor together in your own store.
await savePage(page.messages, page.cursor);
```

Use the recovery poll separately from the realtime listener. It needs a session that advertises an HTTPS polling endpoint with long polling enabled. An empty page is a normal poll result. Each call has a 60-second timeout, and callers can cancel earlier with `AbortSignal`. A cursor reset or queue eviction means there may be a gap. Keep returned records private and treat the cursor as belonging to the session account.

This helper supports recent recovery and an SDK-managed archive. The recovery queue is account-wide, and its reply can include E2EE records that need separate device and conversation keys. Full older history for a single direct thread remains outside the recovered contract. Availability and retention depend on the server. [Desktop history findings](desktop-gaps.md)

## Shipped protocol

Both the installed desktop client and Zalo Web have a long-poll fallback for message queues. The login bootstrap and subsequent configuration supply the `zpw_chts_new` polling bases. The helper uses the first endpoint from the login response retained by the web adapter. [Installed build and archive identity](desktop-evidence.md) · [Matching Zalo Web bundle](https://zalo-chat-static.zadn.vn/v1/lazy/1.c72c0957b455ab70b73c.js)

| Part | Static evidence |
| --- | --- |
| Endpoint | GET the advertised base with a trailing slash, followed by `zpw_ver`, `zpw_type`, `params`, and Unix seconds in `ts`. Preserve any base path prefix. Web chunk byte 11,639,791 and desktop SHARED byte 12,468,491. |
| Request | `params` holds `lastActionId,lastActionIdOther,` followed by a URL-encoded string. That string is Base64 of JSON mapping queue names to `{lastId,ids}`, then the literal suffix `,1`. Fresh state starts action IDs at `"1"` and initializes queues `1`, `2`, and `3` with the same cursor. When enabled by `enable_polling_last_action`, it sends up to ten retained action IDs per queue through its current cursor. Web bytes 1,421,283–1,423,455, 1,428,580–1,429,450, 1,430,520–1,431,020, 1,434,400–1,434,610, and 6,190,224. |
| Response | HTTP 200 with an empty body or successful envelope with an empty `data` string is an idle poll. Otherwise decrypt outer `data` with the account session key and parse inner `data`. Direct records are in `msgs`; group and official account records have their own arrays. Preserve identifiers without rounding. Web bytes 3,053,350–3,054,180, 3,054,740–3,055,855, 3,056,412–3,057,640, and 9,351,707. |
| Resume | Advance global action IDs and each queue's `lastId` monotonically. Queue status may contain an `evict` marker. On `resetLastActionId`, reset the main action ID and all queue IDs to the supplied cursor, clear retained IDs, and reset the second action ID to `"1"`. Web bytes 1,425,056–1,425,780 and 1,433,100–1,434,350. |

The desktop WebSocket has separate offline queues for direct messages and groups. Its sender uses an account-wide action cursor and requests another frame when the server sets `data.more`. The pinned `zca-js` listener provides a separate `requestOldMessages()` interface. Its `old_messages` event exposes the message array and thread type. The event interface does not expose the raw action cursor, `more` marker, or per-request correlation. [Pinned listener source](https://github.com/RFS-ADRENO/zca-js/blob/dadfef18bcac53537741855c99f084152da1fad9/src/apis/listen.ts)

## Older history and mobile transfer

The ordinary desktop direct-message scroll path reads local conversation storage. Group cloud and feature-enabled self-chat have separate paging routes. A group or self-chat cloud endpoint is therefore unsuitable as a general direct-message history API. [Group cloud eligibility and routes](desktop-gaps.md)

Mobile transfer has more than one shipped path. The legacy transfer request `/api/message/pull_mobile_msg` carries a public key, sequence range, and temporary session data. The desktop waits for phone-side results, then reads metadata such as the snapshot URL, checksum, encrypted key and database format. The active sync v2 handler sends command `590` with a sync request through the WebSocket and uses commands `592` and `591` for mobile wake and session disposal. The transfer depends on device participation, key state, downloads and local database import. A standalone HTTP builder does not establish a working sync client.

The installed archive provides those transfer observations in SHARED at bytes 7,612,384, 12,508,078–12,509,423, and 14,417,450–14,417,840. The consuming renderer appears in `pc-dist/lazy/main-startup.89bb530b91927fd5dd28.js` at bytes 704,750–706,350, 720,830–721,510 and 2,489,430–2,491,450. SHA-256 of that renderer member is `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`.

Offline fixtures exercise framing, account versus thread scope, lossless IDs, cursor continuation, reset, queue eviction, idle response, unsupported configuration, and cancellation. Live authenticated polling and a mobile transfer were not exercised.
