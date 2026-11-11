# Emoji-status reads

The SDK reads the provider's emoji resource configuration and one page of friend emoji statuses. It preserves the decrypted provider objects, including unknown fields, IDs, asset locators and paging metadata. It does not create or delete a status, fetch assets, merge local state, schedule refreshes, or open a socket.

```ts
import { getEmojiStatusResourceConfig, getFriendEmojiStatuses } from 'zalo-personal-sdk';

// Obtain this advertised positive version from your account's provider config:
// emoji_status.sync_resource_config.resource_version.
const resources = await getEmojiStatusResourceConfig(api, advertisedResourceVersion, signal);

// Installed initial friend-status request. Each invocation performs one read.
const cursor = { version: 0, fromUid: '', maxEmojiStatusId: 0, page: 0 };
const page = await getFriendEmojiStatuses(api, cursor, signal);
```

The resource read has no default version: Desktop skips synchronization when the advertised resource version is unknown. The two functions use the authenticated `emoji_stt` service; a session that does not advertise it returns `ZaloProtocolError` with `unsupported-service`. Both GET requests carry only the fields below inside account-AES `params`, alongside normal common query fields. They add no `imei` or `language` member. Redirects are disabled, caller cancellation is passed through, and neither operation retries.

| Function | Route | Encrypted request |
| --- | --- | --- |
| `getEmojiStatusResourceConfig` | `/api/v1/emoji-status/resource-config` | `{version}` |
| `getFriendEmojiStatuses` | `/api/v1/emoji-status/friends` | `{version, fromUid, maxEmojiStatusId, page}` |

Resource results contain `config.emojis`, whose observed fields are `id`, `caption.vi`, `caption.en`, `thumb`, `full` and `lottie`, plus `expireTime`. The raw caption fields are retained rather than replaced with Desktop's display defaults. Friend results contain `type` and `emojiStatuses`; the observed paging fields are `version`, `maxEmojiStatusId`, `lastUid`, `page`, `loadMore` and `expireTime`. Optional observed fields remain absent when the provider omits them. Malformed observed field layouts are rejected as `invalid-response`; unknown fields remain intact. Safe numeric IDs stay numeric and larger JSON integer tokens become exact decimal strings through the shared lossless parser.

Friend status records expose the observed `emojiStatusId`, `noisedOwnerId`, `emojiId`, `caption`, `createdTime`, `duration`, and optional `extraData.song.songId`. `noisedOwnerId` is the field Desktop maps to the local `userId`. The SDK retains its original name. It does not infer a status lifetime from these fields. Desktop's refresh scheduler treats the page's `expireTime` as seconds.

Applications own all cursor updates and persistence. These are the installed consumer's rules, recorded for callers building a sync loop:

| Result `type` | Meaning | Installed next-request revision/cursor rule when continuing |
| --- | --- | --- |
| `0` | Empty | Stops the cycle without replacing cached statuses. |
| `1` | NoChange | Takes result `version` and `maxEmojiStatusId`, retains request `fromUid`. |
| `2` | AddTop | Takes result `version`, `maxEmojiStatusId` and `lastUid`. |
| `3` | Refresh | Takes result `version`, `maxEmojiStatusId` and `lastUid`; replaces the local status map before applying records. |
| `4` | Paging | Retains request `version` and `maxEmojiStatusId`, takes result `lastUid`. |

For every continuing type, the installed page number is `(result.page ?? request.page) + 1`; `loadMore` controls continuation. An empty Paging result ends the cycle even if `loadMore` is set. NoChange leaves cached records intact; other non-Empty results merge records, with Refresh first clearing the map. These rules are not applied automatically by the SDK. Preserve your revision boundary across Paging requests instead of blindly copying every returned revision.

## Evidence and validation

Evidence is from installed Zalo Desktop 26.11.10 (build 26.11.10.3400), shipped artifacts only. Offsets below are zero-based UTF-8 bytes, not JavaScript character indexes.

| Artifact | SHA-256 | Anchors |
| --- | --- | --- |
| `pc-dist/lazy/default-login-main-startup-shared-worker-znotification.4bb5e1e2c2e9bab4f7b3.js` (SHARED) | `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` | `Vjnf` route/command constants at 9,938,386; service key `emoji_stt` at 14,701,510; standard two-layer account-AES response handler `kCOK` at 13,736,118. |
| `pc-dist/lazy/main-startup.89bb530b91927fd5dd28.js` (MAIN) | `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121` | HTTP resource/friend builders at 2,395,685 and 2,396,049; remote config at 2,392,059 and version getter at 2,394,079; resource DTO consumer at 2,418,370; initial cursor at 2,420,743 and friend loop at 2,423,251; cursor/merge rules at 2,425,913 and 2,426,393; record mapping at 2,427,005; result-type enum at 2,669,393. |

The REA artifact analyzer previously failed in its macOS Swift helper; this slice uses the same integrity-checked exact packed bytes retained by the earlier investigation. No REA runtime observation is claimed. The pinned `zca-js@2.2.0` has no corresponding operations, including its dynamic route suffixes.

Offline fixtures use the pinned authenticated API, synthetic AES envelopes and inert service URLs to verify exact decrypted GET fields, all five result types, preserved extension fields and large IDs, invalid input/result rejection, cancellation, missing service and redacted provider/transport errors.

On 6 November 2026, a separate saved-Web-session read accepted the installed initial friend cursor and returned type 3 (Refresh) with zero statuses. This establishes acceptance of that empty page, not populated-status decoding, every paging mode, or status creation. The resource read was skipped because that session supplied no usable advertised resource version. Resource availability remains fixture-only.
