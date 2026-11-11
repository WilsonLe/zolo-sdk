# Managed realtime and offline recovery

`startManagedRealtime(connect, options)` opens one `startRealtimeFrameFeed()` at a time. Supply a bootstrap callback such as `(signal) => client.resume(signal)`. It runs again after a retryable disconnect. The supervisor checks that every attempt resolves to the same account before opening its socket.

`onConnection({ api, feed, signal })` runs for each feed before the key frame, so you can attach message listeners, E2EE controls, or other feed consumers. The connection signal aborts when that feed ends. Remove your listeners on abort. The supervisor waits for the callback to settle before opening a replacement socket. Async handlers should honor the connection signal and finish any pending database transaction before returning.

`realtime.ready` resolves to the first authenticated connection or `null` if the run ends first. `realtime.closed` resolves with the terminal reason, attempt count, and close code if available. `realtime.stop()` aborts startup, retry delays, and the active feed. Use `onStatus` for connection and retry notifications. These notifications contain no session material or provider close text.

The supervisor retries transient socket closes such as 1006 and 1012. It stops on displacement (3000 or 3001), server kick (3003), account changes, and incompatible listeners. The defaults allow five consecutive retries with an initial delay of 500 ms and a cap of 20 seconds. A connection lasting 30 seconds resets the backoff. The attempt has a 20-second deadline for bootstrap and the key frame. The packaged echo example shows live message handlers and cleanup scoped to each connection. [Echo example](../examples/echo.mjs)

## Recovering missed ordinary messages

Run `recoverChatOfflineQueue(feed, selector, options)` for a direct or group selector advertised in `feed.authenticatedQueues`. It fetches pages in sequence and awaits `onPage` before advancing. It returns the number of pages, the latest reconnect cursor, any reset or eviction, and a same-feed continuation when `maxPages` is reached. The default is 50 pages. Save the records and the provider's `resumeActionId` in one transaction. A reset can change the saved cursor for other selectors as well. [Wire details](e2ee-offline.md#ordinary-message-queues)

```js
const realtime = startManagedRealtime((signal) => client.resume(signal), {
  async onConnection({ api, feed, signal }) {
    attachLiveMessageHandler(api, signal);
    const queues = await feed.authenticatedQueues;
    const selector = queues?.find(({ cmd }) => cmd === 710)
      ?? queues?.find(({ cmd }) => cmd === 510);
    if (!selector || signal.aborted) return;
    const resumeActionId = await loadCursor(selector);
    try {
      await recoverChatOfflineQueue(feed, { ...selector, resumeActionId }, {
        signal,
        onPage: (page) => storeMessagesAndCursor(selector, page),
      });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  },
});
```

The application owns the live handler, cursor store, and deduplication across live and recovered messages. Reserve each selector for one pager and keep cursors scoped to the account and selector. Loopback tests cover reconnect, displacement, account changes, retry cancellation, handler cleanup, and durable paging backpressure. Live automatic reconnect and queue recovery remain unverified.

## Recovering ordinary reactions

`startRealtimeFrameFeed` also provides `authenticatedControlQueues`, parsed independently from AUTH `ctrl_qCmds`. It never merges this inventory with chat `qCmds`; missing/malformed inventory resolves to `null`, while an announced empty inventory resolves to `[]`. Both promises settle when a feed closes before authentication. The control capability is optional on older/custom `RealtimeFrameFeed` adapters and guaranteed by the SDK factory. Raw subscribers do not receive the private AUTH payload.

Use `requestReactionOfflinePage` or `recoverReactionOfflineQueue` only for announced 610_0/611_0 selectors. The managed helper awaits application persistence in one shared control-state lane, preserves separate continuation and durable cursor IDs, and returns explicit control-domain resets. A reset affects both reaction selectors and must be applied to all control cursors owned by that application store. Cancelled requests retain their selector reservation until a matching late reply is drained or the feed closes. These helpers send no receipts and open no additional socket. [Reaction recovery contract and storage example](reaction-recovery.md)

`getReactionLastSeenOnFeed` uses the distinct614_0 API on this same feed. It waits for authentication without requiring control-queue inventory and correlates each reply by its own exact string `data.reqId`. Cancellation can discard that ID immediately because late/ID-less replies cannot complete a different read. `extractReactionReadState` projects passive `clearUnreads` controls, declining control-reset frames. Snapshot `clearUnreadInfo`, preview `clearUnreadsReact` and offline action cursors remain distinct. Applications own monotonic marker merging and persistence across these paths. [Live reaction read-state contract](reaction-live-sync.md)

Native Desktop encrypted paging uses the same feed/cursor owner for fixed513/713/516, with a separately branded Desktop connection and API/feed match. A qualified chat reset also supersedes staged ordinary/Web/native chat cursors and pending readers, including a late matching reset on a cancelled request's drain. Recovery metadata is caller-private through getReset; no saved cursor or key is automatically changed. The supervisor recognizes the native pager's closed error during CLOSING and uses the actual close code for retry decisions. Caller application failures and uncertain state-changing outcomes remain separate. [Desktop page/reset contract](desktop-e2ee-offline.md)

## Passive account and conversation updates

`extractDesktopAccountSettingsEvents` and `extractConversationStateEvents` consume the successful, non-reset ordinary601/603 control path without opening or owning a listener. They share bounded own-data snapshots and exact one-layer first-character data parsing. Manual-unread marks use their separately established unconditional nested-content JSON parse. Unknown selected conversation shapes remain raw; neither helper applies a state reducer or advances a queue.

Settings patches retain arrival order without an invented revision contract. Conversation changes preserve their source meanings: mute replacement/removal, pin deltas, label/archive invalidations, manual-unread settings, TTL in milliseconds and block-sharing intent. Applications choose refetching, deduplication and account-scoped storage. Raw referenced objects are not deeply frozen or recursively sized. [Settings events](desktop-settings.md) · [Conversation events and limits](conversation-state.md)

`extractTrustedDeviceListEvents` preserves raw device controls and optionally qualifies the exact update action into a frozen scalar snapshot. It performs no signature/expiry check or state replacement. Use the existing verifier with independently supplied pins; unsigned control timestamps are distinct from signed list timestamps. At most 64 exact-action qualification attempts occur per frame, with later raw events retained. Missing or failed qualification never triggers revocation, logout or an HTTP recovery request. [Device update boundaries](trusted-device-events.md)

`extractAccountProfileEvents` shares the ordinary account-control path for alias, profile, hidden_chat and emoji_status. It preserves invalidations separately from observed values, retains mode without UI conversion, and exposes separate hide/unhide intentions without deciding cache-dependent overlaps. Hidden PIN changes emit only an invalidation; original raw references can contain credential material and must remain private. Emoji signals do not infer the current account, replace a friend collection or apply expiry/debounce timers. Last-online and emoji record times use milliseconds; explicit emoji debounce uses seconds. The application owns all fetch, storage and reconciliation decisions. [Account profile events](account-profile-events.md)

Raw feed subscribers accept a missing outer transport error code and safe integer/string codes, preserving valid nonzero codes for operation-specific rejection. A present malformed outer code produces `invalid-frame` and is not delivered to those subscribers. Bare application JSON without a transport envelope keeps its previous behavior. This validation does not replace the pinned listener's separate decoder or high-level events.

Photo, encrypted file/photo, ordinary voice/video and mobile-sync control consumers also support the installed successful transport form whose decoded inner object contains `data.controls` without a redundant inner `error_code`. They continue to reject present malformed/nonzero inner codes and nonzero transport codes. Retained real-loopback regressions cover the actual upload completion URLs and mobile batch progress, in addition to raw-frame delivery. These changes do not modify mobile request/reply commands 590/591 or perform live uploads/transfers.
