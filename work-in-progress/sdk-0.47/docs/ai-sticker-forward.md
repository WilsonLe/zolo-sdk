# Forwarding existing AI stickers

`forwardAiSticker(api, input)` submits one ordinary direct/group photo-style forward from caller-owned normalized source metadata. It uses the installed AI forwarding producer, which differs from the [initial AI send](ai-sticker-send.md), text forwarding and capsule-backed photo forwarding.

```ts
import { forwardAiSticker } from 'zalo-personal-sdk';

const result = await forwardAiSticker(api, {
  threadType: 'user', threadId, clientId,
  source: {
    contentId, originalUrl, thumbnailUrl, normalUrl, hdUrl,
    width, height, thumbnailWidth, thumbnailHeight, photoId,
    webpJson: applicationSourceWebpJson,
    properties: { color, size, subType, type, extJson: applicationSourceParsedExtJson },
  },
  referenceLog: applicationReferenceDataText,
  signal,
});
```

The application chooses the destination, retains a stable positive safe-integer `clientId`, and supplies the source message's actual metadata. The helper does not look up a source message, test its URLs, upload bytes or infer forwarding provenance. It does not detect encrypted destinations or fall back from a prepared encrypted operation to ordinary transport.

Ordinary direct forwarding is file-service POST `/api/message/forward` (command **11199**) with `toId` and the current session IMEI. Group forwarding is file-service POST `/api/group/forward` (**11818**) with `grid` and `visibility`, without IMEI. Both use the standard client type/version query and account-AES form `params`; no language is added. The request carries `msgType:2`, `clientId`, `ttl` (default 0), fixed `zsource:-1`, and a nested JSON-text `msgInfo`.

The source fields become `description:''`, `title:''`, `oriUrl`, `thumbUrl`, `normalUrl`, `hdUrl`, `contentId`, thumbnail/base dimensions, complete WebP JSON text, source properties JSON and `photoId`. Ordinary `msgInfo.jcp` is JSON text `{"pStickerType":1}`; `pStickerType` is not separately left in the ordinary record. Source properties are reconstructed as `{color,size,subType,type,ext}`, with `ext` containing the supplied JSON object text as a string. These are source properties, not the initial-send fixed no-border constants.

Only HD has the native `hdUrl || normalUrl` fallback: omitted, null or empty HD uses the supplied normal URL. All three original/thumbnail/normal locators are required. Thumbnail dimensions use nullish fallback to the base dimensions; valid zero is preserved. `photoId` uses nullish fallback to 1; valid zero is preserved. That field is not a new upload ID or an inferred original message ID. Forward content ID is unconditionally copied by the source, so numeric zero is supported here even though the initial-send truthy guard rejects it. Group visibility defaults to 0 with an explicit nonnegative safe-integer override; one leading `g` can be stripped from group routing.

`referenceLog` is bounded text, including an explicitly empty string. It becomes `msgInfo.reference`, itself JSON text `{type:3,data:referenceLog}`. If the application has an object reference, it supplies its serialized object as this text; the helper does not manufacture one. Optional `decorLogJson` must be JSON object text and remains a separate clear request member. Neither string is interpreted as a message ID, recipient or authorization decision.

The ordinary result preserves provider extras and requires a usable exact decimal `msgId`. It acknowledges the submission, not recipient delivery, rendering, asset availability or provenance.

## Experimental prepared forwarding

Import `buildAiStickerForwardPlaintext`, `forwardPreparedE2eeDirectAiSticker` and `forwardPreparedE2eeGroupAiSticker` from `zalo-personal-sdk/e2ee`.

```ts
const plain = buildAiStickerForwardPlaintext(source, {
  referenceObjectJson: applicationReferenceObjectJson, // optional seventh field
});
// Each field, including empty/repeated values, needs independent authenticated encryption.
const [title, original, thumbnail, hd, parameters, normal, forwardRefLog] =
  plain.fields.map(field => applicationRatchet.encrypt(field));
await forwardPreparedE2eeDirectAiSticker(api, {
  threadId, clientId, senderRegistrationId,
  clear: plain.clear,
  recipients: [{ userId, deviceId, registrationId, title, url: original, thumbnail, hd, parameters, normal, forwardRefLog }],
  signal,
});
```

The frozen pure result contains six sensitive plaintext fields, or seven when an explicit reference object is supplied:

| Slot | Plaintext | Prepared `msgInfo` destination |
| --- | --- | --- |
| 1 | Empty title | `title` |
| 2 | Complete original URL | `oriUrl` |
| 3 | Complete thumbnail URL | `thumbUrl` |
| 4 | Complete selected HD URL | `hdUrl` |
| 5 | JSON `{width,height,hd,thumb_width,thumb_height,webp,contentId,pStickerType:1}` | `prmE2EE` |
| 6 | Complete normal URL | `normalUrl` |
| 7, optional | Explicit reference object JSON text | Wrapped `reference.data` |

The WebP object is embedded intact in slot 5. Its unknown fields, nested objects and integer-token spelling are not projected away or rounded by parse-and-stringify. The API validates bounded JSON object text and retains that text; it does not invoke a caller object's `toJSON`. The reference builder accepts only explicit object JSON text. The native append branch protects object references independently; an existing arbitrary string reference is not automatically protected by that branch. Prepared sends accept an optional independently encrypted `forwardRefLog` frame, not plaintext reference text.

These AI fields are complete URL ciphertext, not encrypted file-capsule keys. No `e2esession` capsule is appended or fabricated. Direct sends reuse chat_e2e POST `/api/e2ee/pc/message/forward` (**16012**) with `destType:3`, a `listParams` record per declared device, and top-level `msgType:2`. Groups reuse group_e2e POST `/api/e2ee/pc/group/forward` (**16112**) with top-level `msgType:2`, `grid` and visibility (default 0). Photo version/compatibility are 0/0. This group-forward visibility is source-established; the initial encrypted AI photo operation omits it.

### Explicit provider-visible metadata

The installed rebuild copies the original forwarding content before replacing the protected fields. Consequently `plain.clear` is required by the prepared API and remains outside the end-to-end ratchet, inside the account-AES request: `description`, content ID, base/thumbnail dimensions, complete WebP text, nested source properties, `pStickerType:1`, `photoId`, and `isAISticker:true`. Optional decor data also remains outside the ratchet. The prepared record keeps `pStickerType` directly and does not perform the ordinary `jcp` move.

**The clear WebP JSON can repeat a media URL.** This source-faithful forwarding operation does not promise that every URL copy is end-to-end protected. The clear projection is an explicit input; it is not silently recovered from ciphertext. Removing these source fields would require receiver/server compatibility evidence that is not established here. The builder's output also contains sensitive plaintext URLs and must be handled accordingly.

The caller owns source eligibility, peer authentication, direct/group key initialization, sender-key distribution, independently encrypting the correct six/seven-slot vector, durable ratchet advancement and destination/clear-metadata consistency. Structural frame validation cannot prove those bindings or decrypt and compare the clear copy. Direct/pre-key versus group frame kind, canonical encoding and version-3 protobuf structure are checked. Each vector rejects exact duplicate canonical frames as a local preparation rule; no cross-recipient ciphertext uniqueness or counter-contiguity rule is invented.

Prepared results retain the existing optional-ID/empty-success convention. A successful empty acknowledgement returns `undefined`; it is not turned into a synthetic provider message ID or verified delivery.

## Bounds, snapshots and submission outcomes

These are SDK resource/input limits, not measured provider ranges or entitlement rules:

- Forward content/photo IDs accept safe integer numbers (including zero) or exact signed JSON-integer-token strings with up to 40 digits. Strings are not trimmed or numerically coerced; string `'-0'` remains text, while numeric `-0` uses ordinary JSON zero serialization.
- Base dimensions are positive safe integers up to 100,000. Explicit thumbnail dimensions are nonnegative safe integers up to 100,000. Property color/size/subtype/type values are signed safe integers.
- Required locator text is nonempty, well-formed Unicode within 65,536 UTF-8 bytes. No scheme, trust or fetchability claim is made, and text is preserved without normalization or a liveness request.
- WebP, parsed-ext, reference and decor JSON/text inputs are bounded to 65,536 UTF-8 bytes. Object JSON must decode to a non-null non-array object. Prepared clear properties text may use up to 262,144 bytes to accommodate the nested escaped ext string; its known property fields and JSON-text ext are checked. Complete WebP and property extensions remain explicit raw text.
- Direct recipient arrays must have 1–128 own indexed entries, checked before each index read without executing the caller iterator. Decimal-equivalent user IDs such as `'01'`/`'1'` on the same device count as one address locally; one unambiguous route preserves its original wire text. Device slots are 0–2; optional registration IDs are positive uint32 values.
- Every frame is bounded to 524,288 Base64 characters. A shared 8,388,608-byte/ASCII-character budget counts ciphertext and repeated serialized clear/decor metadata before per-device copies. This limits that data, not every byte of the final form/JSON escaping overhead. Oversized repeated clear metadata is rejected before any recipient entry read.

Snapshots read caller fields once before asynchronous work and preserve caller arrays/objects. Getter failures become fixed input `TypeError`s. The helper submits once with redirect replay disabled. It does not retry, queue, HEAD/download assets, generate stickers, open a mini-app, update an application cache, refresh locators or persist state.

`AiStickerSendError` is shared with the initial AI operation. It exposes fixed `code`, `submitted`, `outcomeUnknown` and optional safe-integer provider/HTTP codes; no response text, locator, ciphertext, cause or adapter error message is copied. Public protocol-error metadata is read once in a contained snapshot. Throwing metadata accessors discard the whole snapshot; zero/unsafe/non-numeric provider codes do not establish a known refusal. A nonzero safe provider code is a known refusal. A missing service or pre-cancelled operation has no handoff. Once the adapter has been called, cancellation, network/HTTP failure or malformed acknowledgement can leave the outcome unknown. Handoff is conservative submission evidence, not proof of remote receipt or rollback.

Initial and forward calls share one active operation per API/client ID. Concurrent reuse is refused, not queued. This is not durable deduplication: after completion the application can explicitly reuse the ID. Reconcile unknown outcomes before another explicit submission.

## Source and verification boundary

Installed Desktop **26.11.10**, build **26.11.10.3400**, with revalidated packed-source hashes: SHARED `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`; MAIN startup `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. Anchors below are zero-based UTF-8 byte offsets. [Artifact identity](desktop-evidence.md)

| Evidence | Byte anchor |
| --- | --- |
| Current multi-target caller / destination encryption decision | MAIN 1,018,180–1,019,100 |
| AI source producer, properties and exact fallbacks | MAIN 1,773,963–1,775,115 |
| Delegation as photo forwarding | MAIN 1,760,384 / 1,765,952 |
| Ordinary transformation, nested `jcp`, reference/decor placement | SHARED 12,458,543 |
| Ordinary direct/group route and IMEI/visibility | SHARED 12,460,076 |
| AI six-field extraction versus file capsules | SHARED 10,613,158 |
| Shallow copy/rebuild, retained clear metadata | SHARED 10,616,898–10,617,580 |
| Object-reference seventh slot and encrypted forwarding dispatch | SHARED 10,620,527–10,621,820 |
| Photo version / version selection | SHARED 3,278,423 / 10,619,269 |
| Reference object/string handling and type 3 | SHARED 16,788,599 / 9,130,628–9,131,450 |
| Encrypted record serialization without clear-field cleanup | SHARED 12,450,580 |

The integrity-checked source fallback is reused without app execution or a REA setup retry. The native forwarder also performs a separate HEAD liveness probe and can retry no-response cases; this API deliberately exposes one submission without those side effects. The [AI-list tab gate conflict](ai-stickers.md) remains explicit. Source transport evidence does not establish generation availability, provider entitlement, asset lifetime, live forwarding success, recipient rendering or trusted pairing.

Focused offline fixtures account-decrypt exact ordinary direct/group payloads and use independent direct/group peers to decrypt every six/seven-slot field into the source metadata. They verify raw WebP numeric-token preservation, clear-copy visibility, nested property/reference differences, fallback distinctions, frame/recipient/resource bounds, snapshots, acknowledgement/refusal/unknown/cancel behavior, shared active IDs and sanitized adapter metadata. No live account read, upload, send, asset request, socket operation or generation is used by this implementation.
