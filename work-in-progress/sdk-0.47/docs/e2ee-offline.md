# Realtime offline queue pages

Use the authenticated chat socket already held by `startRealtimeFrameFeed`. The initial AUTH frame supplies a transport key and may also carry an encrypted successful response with `data.qCmds`. Each entry identifies a command and subcommand. `feed.authenticatedQueues` exposes those selectors. It resolves to `null` when the inventory is unavailable. The SDK keeps the key out of the decoded frame feed.

```js
import { startRealtimeFrameFeed } from 'zalo-personal-sdk';
import { extractE2eeTextEvents, requestE2eeOfflinePage } from 'zalo-personal-sdk/e2ee';

const feed = startRealtimeFrameFeed(api);
const page = await requestE2eeOfflinePage(feed, { cmd: 515 });
const encryptedText = extractE2eeTextEvents(page.frame);
// Process or persist the returned records before choosing whether to request page.next.
```

| Command | Returned records |
| --- | --- |
| `515`, `715` | Web direct messages in `data.msgs` |
| `517` | Web session events in `data.eesession` |
| `514` | Encrypted group messages in `data.groupMsgs` when offered by the provider |
| `518`, `519` | Direct and group encrypted receipts in `data.delivereds` |

The selector must appear in the socket's chat queue inventory. Supply `subCmd` when the inventory includes multiple subcommands for one command. Message and session requests start with `{first:true,reqId,lastId:"1",preIds:[]}`. Use `requestE2eeOfflinePage(feed, page.next)` for a single explicit continuation when `page.next` exists. It sends `first:false` with the previous response's exact `lastActionId`. The SDK leaves `preIds` empty because it maintains no previous-ID cache. A reply may omit the request ID, so a cancelled or timed-out request reserves its selector until a matching reply arrives or the socket closes.

`page.evicted` reports the provider's queue eviction flag. Treat an eviction as a possible gap. Pages contain provider wire records and need the appropriate authenticated E2EE sessions or sender keys for decryption. A Web session can use `extractE2eeGroupDistributionEvents(page.frame)` for supported group sender-key events.

Receipt queues use numeric `lastId: 1` on both the first and subsequent requests and omit an ID cursor. Process and persist the receipt rows before explicitly clearing them through the receipt controls. Continue after that operation completes. A repeated fetch can return the same rows. The pager sends only the fetch frame. Processing acknowledgments, delivered or seen updates, and receipt deletion are separate operations. Desktop-specific queues remain outside this pager. Provider retention and pagination effects remain unverified on a live account. [Receipt handling](e2ee-receipts.md)

Native Desktop513/713/516 pages use the separate experimental [`requestDesktopE2eeOfflinePage`](desktop-e2ee-offline.md), requiring the live Desktop connection and its matching SDK feed. It shares this module's reservations/cursor owner and observes chat-wide resets without relabeling Web keys, checkpoints or selectors as a PC messaging identity. PC registration lookup is a separate explicit read; no key publication follows from paging.

The Web startup bundle `1.c72c0957b455ab70b73c.js` contains AUTH processing at byte 1,185,170, chat queue negotiation at 11,768,452, page request/reply handling at 3,391,205, E2EE queue definitions at 5,483,320, and receipt deletion at 13,447,846. Zalo Desktop 26.11.10's packaged SHARED member contains the corresponding request/reply logic at 3,691,868 and E2EE queue defaults at 6,951,800. Local encrypted fixtures verify the SDK's frame encoding, negotiated subtype, cursor precision, continuation, and cancelled-request handling.

## Ordinary message queues

Use `requestChatOfflinePage(feed, { cmd, resumeActionId? })` from the main package. Commands 510 and 710 carry direct `msgs`, while 511 and 711 carry `groupMsgs`. Pass a subcommand when the authenticated socket announces multiple selectors for the chosen command. The result includes the provider records in `messages`, their `threadType`, eviction status, and an optional same-feed `next` cursor. The top-level `lastActionId` drives that continuation. Persist `resumeActionId` from the selector's `queueStatus.lastId` with the records for reconnection. Keep the prior saved ID when a page omits it. On a new connection, pass the saved string with the matching announced selector. A cursor eviction can leave a history gap.

A page with `resetActionId` tells the application to reset its saved ordinary queue cursors to that ID. The SDK returns an empty message page and ends that continuation. The desktop resets its saved IDs before processing message rows at SHARED 12,587,861.

Qualified numeric-success positive-decimal reset metadata on an owned ordinary/Web/native page reply invalidates this shared owner's staged chat continuations and marks sibling pending reads stale. A matching retired timeout/cancel drain still observes that reset metadata, without ingesting retired rows or issuing a continuation. Failed/string-zero/malformed reset metadata has no such authority. Stale errors expose source frame/ID only through explicit `getReset()` recovery metadata. The ordinary recovery runner also checks after its awaited application callback so it cannot report success after an interleaving reset; it cannot undo an application transaction. Applications own durable generation/cursor reconciliation. Reaction/control resets remain separate.

Reserve each selector for one paging API and use the returned page as its ingestion source. The pinned listener can also emit `old_messages` for 510/511 subcommand 1, and replies may omit the request ID. The SDK starts with `lastId: "1"` when no prior ID is supplied and leaves `preIds` empty. Preserve the exact provider ID, even if it exceeds JavaScript's safe integer range. The Web queue table and cold-start default appear at startup bundle offsets 12,650,286 and 1,430,940. The desktop persists per-selector queue status around SHARED 1,486,000–1,496,000 and uses the top-level action ID for continuation around 3,692,591. Local tests distinguish those two IDs and cover group and direct records. Live offline queue recovery remains unverified.
