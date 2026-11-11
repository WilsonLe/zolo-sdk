# Initial AI-sticker sends

`sendAiSticker(api, input)` explicitly submits an ordinary direct/group AI photo-style message from caller-selected provider metadata. It uses the installed initial URL-send path. It does not upload bytes or forward an existing message.

```ts
import { sendAiSticker } from 'zalo-personal-sdk';

const result = await sendAiSticker(api, {
  threadType: 'user', threadId: applicationDestination, clientId: applicationStableActionId,
  sticker: { contentId: selected.id, url: selected.url, width: selected.width, height: selected.height },
  signal,
});
```

The application owns destination selection, action IDs and whether an ordinary message is appropriate for that conversation. The function does not detect encrypted conversations or silently route a prepared encrypted message through ordinary transport. The prepared encrypted APIs below are separate and experimental.

Ordinary sends use file-service POST `/api/message/photo_url` (command **11775**) or `/api/group/photo_url` (**11830**), account-AES form `params` and standard common client type/version query. No IMEI or language is injected. The exact AI presentation includes empty `title`, existing original/HD/thumbnail locators, dimensions, `contentId`, thumbnail dimensions, WebP JSON text, `jcp:'{"pStickerType":1}'` and fixed no-border properties. The properties' `ext` is itself JSON text `{sSrcStr:'',sSrcType:-1}` inside the outer properties JSON. It is not an ordinary sticker-ID request or an uploaded-photo receipt.

`thumbnailUrl` omitted or empty uses the native `thumb || url` fallback. Other nonempty locator text is preserved without scheme normalization, trust validation or a liveness request. TTL defaults to 0, `zsource` is fixed at -1, and groups default to visibility 0 with an explicit nonnegative integer override. A group ID can have one `g` prefix; direct IDs cannot. IDs are bounded decimal text, not inferred from contacts or a live profile read. `clientId` must be a positive safe integer supplied and retained by the application.

The ordinary success result preserves decoded provider extras and requires a usable exact decimal `msgId`. This is a provider acknowledgement, not recipient delivery or rendering. Missing/malformed acknowledgement data after submission is an unknown outcome.

## Experimental prepared encryption

Import `buildAiStickerPlaintext`, `sendPreparedE2eeDirectAiSticker` and `sendPreparedE2eeGroupAiSticker` from `zalo-personal-sdk/e2ee`. The main root exports the ordinary operation only.

```ts
const plain = buildAiStickerPlaintext({ contentId, url, width, height });
// Sensitive vector. Independently encrypt every slot with the correct authenticated ratchet.
const [title, original, thumbnail, parameters] = plain.fields.map(value => applicationRatchet.encrypt(value));
await sendPreparedE2eeDirectAiSticker(api, {
  threadId, clientId, senderRegistrationId,
  recipients: [{ userId, deviceId, registrationId, title, url: original, thumbnail, parameters }],
  signal,
});
```

The pure builder returns frozen `{fields,properties}`. Its exact four plaintext slots are:

1. Empty title.
2. The complete original provider URL.
3. The complete selected thumbnail URL.
4. JSON `{hd,width,height,contentId,thumb_height,thumb_width,webp:{width,height,url},pStickerType:1}`.

Its result contains private plaintext media locators. It performs no network, key lookup, enrollment, session mutation or persistence. The application authenticates the peer/session and independently encrypts all four fields, including the empty title and repeated URL values. It owns and durably advances its ratchet state before submission.

Prepared direct delivery uses the existing photo transport `/api/e2ee/pc/message/photo`; each declared recipient has encrypted `title`, `normalUrl`, `thumbUrl`, `prmE2EE` and fixed clear properties. Prepared groups use `/api/e2ee/pc/group/photo` with encrypted `oriUrl` instead of `normalUrl`, preserving the established initial photo transport without adding visibility. Commands are **16004 / 16104**, version/compatibility 0. WebP/content ID/dimensions are inside the protected fourth slot, while the required fixed no-border properties remain outside the ratchet. No file-key capsule is fabricated around the full URL ciphertext.

All four ciphertext fields are required. The helper checks canonical frame encoding, version-3 protobuf structure and direct/pre-key versus group kind. It does not decrypt, verify the MAC/signature, prove the plaintext vector, authenticate declared destination/user/device/registration hints or confirm that a ciphertext belongs to the API's identity. It does not impose a target/self-only recipient policy or claim cryptographic account binding. The caller owns those guarantees. Exact duplicate canonical ciphertext within one four-slot vector is rejected as a local preparation rule; there is no invented uniqueness rule across recipients or counter-contiguity requirement.

The result preserves the existing prepared-delivery convention: provider IDs are optional and an explicitly successful empty acknowledgement returns `undefined`. That is acknowledged transport completion, not a manufactured message ID or verified delivery. Group sender-key distribution and direct session initialization are separate explicit operations.

## Bounds, snapshots and outcomes

Presentation content IDs are safe nonzero integers or exact signed JSON-integer-token strings with up to 40 digits. Numeric 0 is rejected because the source truthy guard would omit required `contentId`; string `'0'` and `'-0'` remain exact strings. Dimensions are positive safe integers up to 100,000. Locator strings are nonempty, well-formed Unicode within 65,536 UTF-8 bytes; an empty thumbnail alone is the documented fallback. These are SDK input/resource policies, not measured provider ranges or entitlement rules. Locators may be relative, whitespace or custom-scheme text; the SDK makes no fetchability/trust assertion and never follows them.

Prepared direct batches must be dense arrays of 1–128 distinct user/device addresses. Their size is checked before any recipient index read, and each index must be an own property; a hole cannot borrow an inherited recipient. Snapshots use indexed slots without running a caller iterator. Numeric-equivalent decimal user-ID spellings such as `'01'` and `'1'` count as the same user for device-address uniqueness, while a single unambiguous ID keeps its original wire text. This is a local routing policy, not a claim about server alias handling or a remote exploit. Device slots are 0–2 and optional registration IDs are positive uint32 values. Each frame is bounded to 524,288 Base64 characters and aggregate prepared ciphertext to 8,388,608 characters. Oversized, sparse, duplicate-address, malformed-frame and wrong-kind inputs fail before I/O. Input fields are copied before asynchronous work, and caller getter failures become fixed input errors without their private messages. No input array/object is modified.

`AiStickerSendError` exposes fixed `code`, `submitted`, `outcomeUnknown` and optional safe provider/HTTP codes. Invalid local input is a fixed `TypeError`. Unsupported service and pre-cancelled work report no handoff. A numeric provider refusal is a known refusal. Once the internal transport hands off a submission, cancellation, network/HTTP failure or an unreadable response can leave its outcome unknown. `submitted` is conservative adapter-handoff evidence, not proof of remote receipt. Errors contain no locators, ciphertext, provider response bodies or underlying causes.

There is one active send per API/client ID; a concurrent call is rejected rather than queued. This is not durable deduplication: after completion/failure, another explicit call can reuse the ID. No retry, redirect replay, refresh, hidden asset HEAD/download, upload, generation, mini-app, cache update or automatic persistence occurs. An unknown result requires application reconciliation before another explicit submission; cancelling does not roll back a message already accepted.

## Evidence and verification

Installed Desktop **26.11.10**, build **26.11.10.3400**: SHARED SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`, MAIN startup SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. Zero-based UTF-8 anchors: MAIN **1,773,400** AI producer; SHARED **4,276,101–4,276,700** send options and **4,381,960** option propagation; **12,465,175–12,466,286** ordinary URL-send builder; **10,622,908–10,625,300** encrypted vector/clear properties; **10,592,734 / 12,451,200–12,452,620** encrypted group routing/common enrichment without visibility; **16,805,230–16,805,900** AI constants; **1,516,040 / 1,531,675** no-border constant; **13,501,366** TTL enrichment; **3,029,086 / 4,014,641** group visibility default; **3,443,224–3,446,800** source tracking. [Artifact identity](desktop-evidence.md)

The AI-tab bit-2 versus validated enable-0/1 gate conflict remains explicit in [AI list documentation](ai-stickers.md). Existing producer/transport evidence does not prove provider entitlement, generation availability, URL lifetime, recipient rendering or trusted companion pairing. [Forwarding an existing AI message](ai-sticker-forward.md) uses separate helpers with different routes, six/seven protected fields and explicit clear metadata copies.

Focused fixtures independently decode ordinary account-AES requests and use independent direct/group peers to decrypt all four prepared fields into the source-established AI metadata, including clear nested properties. They cover exact routes, provider IDs/empty acknowledgements, source thumbnail behavior, bounded/indexed snapshots, frame/routing validation, sanitized refusal/unknown/cancel outcomes and concurrent IDs. Inherited array-slot and ambiguous decimal-address regressions were retained and reproduced against the original candidate before the own-slot/normalized-uniqueness correction; single-route wire text remains preserved. The integrity-checked packed-source fallback was used without app execution or a setup retry. No live account read, message submission, upload, asset request or generation was performed for this implementation.
