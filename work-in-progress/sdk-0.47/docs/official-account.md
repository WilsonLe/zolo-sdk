# Official Account blocking

`setOfficialAccountBlocked(api, oaId, blocked, signal?)` explicitly blocks (`true`) or unblocks (`false`) one Official Account. It returns `void` after provider acknowledgement. It does not read or toggle cached state, fetch a profile, or update a local profile/conversation cache.

```ts
import { setOfficialAccountBlocked } from 'zalo-personal-sdk';

await setOfficialAccountBlocked(api, officialAccountId, true, signal);
await setOfficialAccountBlocked(api, officialAccountId, false, signal);
```

The OA ID must be a positive decimal string of at most 40 digits. This is separate from upstream friend blocking: `api.blockUser` uses the `friend` service and `{fid,imei}`. Official Account blocking uses the `profile` service, an encrypted form POST, and exactly `{oaid}`. It adds no IMEI or language field.

| Desired state | Path | Installed command |
| --- | --- | ---: |
| Blocked | `/api/social/oa/block` | 12681 |
| Unblocked | `/api/social/oa/unblock` | 12682 |

The normal two-layer account AES response is checked. Successful encrypted acknowledgements may carry arbitrary unused inner data; successful outer acknowledgements with absent/empty `data` are also accepted, matching the shipped decoder. The helper does not invent a response schema. It submits once, rejects redirects, and makes no retries or friend-route fallback. `ZaloProtocolError` preserves safe numeric provider/status codes and fixed messages. Cancellation or transport failure after submission may leave the remote outcome uncertain; the caller owns reconciliation before another explicit request. Account/target eligibility and live provider acceptance remain unverified. The shipped OA-profile UI omits its Block action for Zalo-bot profiles; the helper does not claim that those targets are supported.

## Block controls

`extractOfficialAccountBlockEvents(frame)` is stateless. Pass decoded frames from an existing `startRealtimeFrameFeed` subscription; it opens no socket and acknowledges nothing. Commands 601/603 can carry controls with `act_type:"oa"`, `act:"block"` or `"unblock"`, and `data:{uids:[...]}`. The installed normalizer also parses JSON-string `data` starting with `{`; the extractor accepts that same object form and converts numeric IDs only when safe. It preserves provider order and duplicates in each batch, returning frozen `{blocked,officialAccountIds}` records. Large integer JSON tokens retain their exact decimal strings. It never changes the input or a client cache.

Missing redundant inner status is allowed after transport decoding; explicit nonzero or malformed outer/inner status is rejected. Invalid/empty UID batches are ignored as a whole, including already-rounded unsafe numeric IDs. The SDK applies local limits of 4,096 controls per frame, 10,000 UIDs per batch, and 1 MiB per JSON-string control body. These are resource bounds, not provider capacity claims. Bare application payloads and transport status validation retain the shared feed's existing boundary; validation of raw subscribers does not replace the pinned listener's decoder/events.

## Source and verification

Revalidated installed Desktop 26.11.10 build 26.11.10.3400 SHARED SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` and MAIN SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. UTF-8 byte anchors: exact API builder SHARED **12,441,596**; API decoder wrapper **9,156,181**; awaited acknowledgement/local-state consumer **9,178,575**; OA control consumer **9,186,910**; action constants **10,483,220**; shared control JSON normalization **12,027,140–12,027,600** and OA dispatch **12,030,414**; current OA-profile button **12,678,357**; MAIN toggle consumer **1,710,835**; common account response decoder SHARED **13,736,118**. [Artifact identity](desktop-evidence.md)

The existing integrity-checked packed-byte inspection fallback was used because REA's macOS artifact helper had previously failed; no setup retry or application execution occurred. Focused fixtures cover both decrypted request branches, encrypted/empty acknowledgements, refusal/transport/cancellation behavior, input/service boundaries, object/string controls, exact large IDs and malformed/status rejection. No live block/unblock or account probe was performed.
