# Translation settings and manual messages

`getTranslationSettings` reads account translation settings once. `updateTranslationSettings` explicitly submits the complete settings for one selected thread. `translateMessage` uses the synchronous manual route and restores protected mention, link and emoji substrings before returning. The authenticated account must advertise `ai_features`; the provider determines feature entitlement and accepted language pairs. None of these helpers opens a socket, retries, changes a local cache, or schedules background work.

```ts
import { getTranslationSettings, updateTranslationSettings, translateMessage } from 'zalo-personal-sdk';

const snapshot = await getTranslationSettings(api, signal);
// This is an explicit account-setting mutation, not part of reading or translating:
await updateTranslationSettings(api, {
  threadId: applicationSelectedUserId,
  type: 0, // 0 direct chat; 1 group, with its unprefixed decimal threadId
  settings: { auto: false, suggest: false, srcLang: 'en', desLang: 'vi' },
}, signal);

const result = await translateMessage(api, {
  threadId: applicationSelectedUserId, type: 0, srcLang: 'en', desLang: 'vi',
  msg: { text: '@Alice hello', metadata: {
    immutableItems: [{ start: 0, len: 6, type: 0, mentionId: applicationSelectedUserId }],
  } },
}, { signal, timeoutMs: 7000 });

// result.text retains @Alice; result.mentions supplies restored pos/len/uid fields.
// result.raw contains the provider's correlated text and metadata before restoration.
```

The five supported language tags are `vi`, `en`, `zh-hans`, `zh-hant`, and `ko`. Inputs use these canonical tags explicitly; the helper does not run Desktop's local language detector, silently select a language, or accept a particular pair on the provider's behalf. Installed defaults list `en:vi`, `zh-hans:vi`, `ko:vi`, `vi:en`, `vi:zh-hans`, `vi:ko`. Provider rejection such as unsupported language remains a `ZaloProtocolError` with its numeric `providerCode`.

## Settings ownership

`getTranslationSettings(api, signal?)` returns `{version, info, raw}`. Each normalized `info` entry has `{threadId,type,settings}`. Present numeric-convertible `auto` and `suggest` fields become true only for numeric value `1`; string language fields are retained, including future provider tags. Missing/null `info` becomes an empty list. Missing, nonpositive or invalid revision becomes zero. A valid provider string revision is retained as a string to avoid losing precision, while `raw` always preserves the full decoded record and extensions.

`updateTranslationSettings(api, input, signal?)` requires both booleans and both canonical language fields. It encodes `{threadId,type,settings:{auto:0|1,suggest:0|1,srcLang,desLang}}` and returns `void` after the provider acknowledgement. This is a complete explicit settings submission, with no hidden read/merge step. Applications own revision persistence and reconciliation with other clients. Cancellation, timeout, transport failure or an invalid response after submission can leave a setting's remote result unknown; the helper does not automatically repeat the mutation or claim to roll it back.

## Protected content and request identity

`msg` is the complete proved manual wire message: `{text,metadata:{immutableItems}}`. Item offsets and lengths use JavaScript UTF-16 code units, matching the shipped `slice`, `.length` and mention positions. An astral emoji usually occupies two units, rather than one Unicode scalar or four UTF-8 bytes.

| Item type | Fields | Protected content |
| --- | --- | --- |
| `0` | `{start,len,type:0,mentionId}` | Mention substring and string identity, including a caller's explicit all-mention identity when applicable. |
| `1` | `{start,len,type:1}` | Link substring. |
| `2` | `{start,len,type:2}` | Emoji/emoticon substring. |

The SDK does not infer these spans by tokenizing arbitrary editor documents. Supply the established spans for your message. Unknown style/editor fields, missing metadata, overlapping/out-of-range spans and surrogate-splitting offsets are rejected before I/O. Unsupported rich data is not silently flattened. This scope does not include rich text style reconstruction or conversion of arbitrary editor nodes.

The outbound codec clones/sorts the proved item fields and submits all supplied protected items. Desktop's span encoder can discard excess emoji items according to the optional remote `immutable_items_max_per_request`; this helper instead enforces an explicit SDK item limit and never silently removes a caller-supplied item. The caller must respect any known provider feature limit. A provider maximum is not inferred from the local bound.

Each manual call creates one fresh `reqId` using the shipped generator: `pcw_` plus the decimal unsigned expression `(timestamp << 22) | (257 << 12) | sequence`. Timestamp is epoch-zero Unix milliseconds in 41 bits; node 257 occupies 10 bits; the sequence occupies 12 bits. Equal or reversed clocks retain the last logical timestamp and increment sequence. Sequence overflow advances one logical millisecond and resets sequence. The upper timestamp bound is `2**41-1`. The module owns this in-process generator, matching the shipped per-node singleton; there is no arbitrary request-ID override, implicit replay, or claim of cross-process uniqueness when independent processes share a timestamp and sequence.

The HTTP response's `reqId` must exactly match the generated string. The shared lossless JSON decoder preserves large numeric tokens as decimal strings before comparison. The manual response also requires string `text`; optional `metadata.immutableItems` defaults to an empty list.

Restoration matches each translated immutable item to the first unused original item of the same type. Mention IDs select the matching identity first; if the provider changes an identity or returns an omitted/null/empty identity, the shipped fallback chooses the next unused original mention. Outbound and restored mention identities remain required strings. The SDK then substitutes the original protected substring, adjusts all following UTF-16 offsets, and returns original mention identities. `result.metadata.immutableItems` and `result.mentions` refer to `result.text`; `result.raw` retains the unmodified correlated provider result and all metadata extensions.

The SDK is stricter than the Desktop renderer when protection cannot be completed: malformed, overlapping, extra/unmatched translated items or omitted protected source items reject as `invalid-response`. Desktop's permissive renderer can skip items in those cases. A successful SDK result therefore does not silently discard protected source content. Plain text uses `immutableItems:[]` and needs no reconstructed spans.

Manual options are `{signal?,timeoutMs?}`. The default wait is the shipped 7,000 milliseconds; allowed SDK range is 1–120,000 milliseconds. A local deadline raises `ZaloTranslationError` with `code:'timeout'`, cancels the request signal, and releases the helper wait even if a caller's custom adapter ignores cancellation. Caller abort raises `ZaloProtocolError` with `code:'aborted'`. A late custom-adapter result cannot become a successful return. Applications own custom-adapter resource cleanup when it ignores the signal.

Local bounds, not measured server maxima: 256 KiB UTF-8 for source/translated text, 4,096 immutable items, 128 UTF-8 bytes per mention identity, 40 decimal digits per thread ID and 20,000 returned setting entries. Protected items must have positive lengths and fit the associated text. Errors omit private content and original transport exceptions. Reads, explicit updates and manual submissions all reject redirects.

## Exact transport and source evidence

| Operation | Request |
| --- | --- |
| Read settings / 13395 | GET `/api/aifeatures/translate/v1/setting`, common client query only; no encrypted `params`, IMEI or language. |
| Update settings / 13396 | POST same route, common query and form body `params=accountAES(JSON.stringify({threadId,type,settings}))`. |
| Manual / 13397 | POST `/api/aifeatures/translate/v1/manual`, common query and account-AES form `{reqId,threadId,type,srcLang,desLang,msg:{text,metadata}}`. |

All responses use the nested account-AES response decoder. Automatic `/auto` and suggested `/suggest` routes require separate control-event completion and are implemented by the [shared-feed translation adapter](translation-realtime.md), which also waits for HTTP acknowledgement. Neither route is exposed as an HTTP-only text API. Original source evidence is retained in [pending-account-features.md](pending-account-features.md).

Evidence is installed Zalo Desktop 26.11.10, build 26.11.10.3400. Anchors are zero-based UTF-8 byte offsets in the exact shipped packed bytes; they are not JS character indexes.

| Artifact | SHA-256 | Anchors |
| --- | --- | --- |
| SHARED `default-login-main-startup-shared-worker-znotification.4bb5e1e2c2e9bab4f7b3.js` | `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` | Translation commands/type/language constants 10,487,264–10,496,000; `pcw_` prefix 10,494,403; int64 generator and per-node map 16,130,210–16,132,800; account decoder 13,736,118. |
| MAIN `main-startup.89bb530b91927fd5dd28.js` | `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121` | HTTP transport 2,262,235; settings parser 2,593,150–2,594,000; update projection 2,164,470; manual payload construction 2,171,611–2,173,350; response correlation 2,120,997–2,123,467; codec module `ugAl` 2,682,198–2,689,000; manual timeout default 2,642,319; group/UID mapping 2,690,966. |

The codec trace includes mention parsing through `u0hE`, link-token and Unicode/emoticon span discovery, type projection, outbound emoji-cap behavior, received span checks, original-substring restoration and conversion back to `{pos,len,uid}` mentions. Local discovery relies on Desktop's parser/config context; the SDK accepts its explicit proved wire form instead of pretending to reproduce that hidden editor/tokenizer state.

The REA analyzer's previously recorded macOS Swift-helper failure required the same integrity-checked packed-byte fallback as earlier slices. Offline fixtures were authored before the module and verify exact decoded wire requests, deterministic generated IDs, equal/reversed clocks, UTF-16 substring restoration, protected-content failure, raw field preservation, parameterless reads, mutation serialization, cancellation, deadlines, provider refusal and malformed data. No live translation, settings update, private account-file access or phone interaction was used for these fixtures.

On 6 November 2026, a separate saved-Web-session settings read returned provider code 212. Successful live settings records, settings changes and manual translation remain unverified. No translation text or settings mutation was submitted for that probe.

A subsequent saved-Desktop-session translation-settings read also returned provider code 212 on 6 November 2026 after successful account bootstrap. No translation request or settings mutation was submitted.
