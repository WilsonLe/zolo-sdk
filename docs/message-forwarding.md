# Ordinary rich-message forwarding to multiple recipients

`forwardOrdinaryMessage(api, input)` forwards one caller-selected ordinary source message to one homogeneous batch of user or group destinations. Sources cover plain text, normalized RTF text, stickers and links. Each target carries its own stable client action ID and explicit TTL. The result preserves the provider reply and reports only unambiguous per-target observations.

```ts
import { forwardOrdinaryMessage, OrdinaryMessageForwardError } from 'zalo-personal-sdk';

const result = await forwardOrdinaryMessage(api, {
  threadType: 'user',
  targets: [
    { threadId: firstUserId, clientId: firstActionId, ttl: 0 },
    { threadId: secondUserId, clientId: secondActionId, ttl: secondConversationTtl },
  ],
  source: { kind: 'text', text: selectedText, rtfProps: selectedSerializedStyles },
  signal,
});

// Persist observed replies and retain unresolved actions for explicit reconciliation.
await applicationStore.recordForwarding(result);
```

Choose fresh unique positive safe-integer action IDs and retain them with the action before submission. The SDK captures them; it does not create IDs from the clock. `threadId` is positive decimal text of at most 40 digits, retaining leading zeroes; a group ID may have one lowercase `g` prefix, removed for the wire. Targets must be distinct after normalization, and client IDs must be distinct. One call accepts 1–50 dense targets. Fifty follows the installed UI's chunk size as an SDK bound, not a proved server maximum. Both per-target TTL and optional top-level `ttl` are nonnegative safe integers; top-level defaults 0 independently of the required target TTLs. The app selects conversation TTLs from its own state.

The selected destinations must be ordinary messaging destinations. Native UI also partitions encrypted targets, handles large groups through singular sends, splits larger batches and prepares previews/local records. This explicit operation submits the selected ordinary batch. Those orchestration paths and the separate prepared [E2EE forwarding API](e2ee-forwarding.md) keep their own contracts. The pinned text-only `api.forwardMessage` remains unchanged.

## Source forms

| Kind | Input and exact wire projection |
| --- | --- |
| `text` | Required `text` becomes `msgInfo.message`. Nonempty `rtfProps` is copied verbatim into the actual RTF wire field; empty/undefined omits it. It is serialized text, without a reconstructed style schema. Positive optional `containType` adds `paramsExt:{containType,shouldParseLinkOrContact:1}`; zero/undefined omits that object. Wire `msgType` is string`'1'`. |
| `sticker` | Required `stickerId`, `categoryId` and `type` become `emoId`, `catId`, `type`. Optional `extInfo` is preserved as its JSON value when truthy; null/false/zero/empty/undefined becomes `''`, matching the native projection. Arrays and objects remain arrays/objects. Wire kind is string`'2'`. |
| `link` | Required `url` becomes both `link` and `linkTitle`. Optional `title` becomes `message`; `description`, `thumbnailUrl`, `type` and `extData` become `linkDesc`, `linkThumb`, `linkType` and `extData`. Omission, null and empty values stay distinct. A JSON-looking string remains a string. Wire kind is string`'3'`. |

Sticker IDs are nonnegative safe integers or decimal strings up to 40 digits, including category 0. Type fields retain safe integers or bounded strings; no closed provider enum is inferred. Link type can also be null or absent. Text/RTF/title/description and explicit provenance texts are bounded at 64 KiB of well-formed UTF8. Empty text is an explicit supplied value rather than a default for a missing source.

`extInfo` and `extData` accept bounded ordinary JSON data: null, Boolean, finite number, string, dense array or plain/null-prototype string-key object. The SDK captures it before any callback or await. Proxy/accessor/custom serialization/function/BigInt, nested undefined, sparse/extra-key arrays and cycles reject without invoking them; repeated noncyclic aliases are copied independently. Each extension is limited to 2,000 nodes, depth 16 and 64 KiB serialized JSON. These are SDK admission limits, not provider schema guarantees.

Known URL fields accept selected HTTP(S) URLs up to 16 KiB, retaining spelling, percent-case, query order, plus signs and normal fragments. Whitespace, controls, backslashes and userinfo reject. Known PCloud/E2EE session query names reject, including supported encoded/case/leading-question aliases; malformed or repeated-encoding query names are unsupported. No suffix is stripped into a send. Values, fragments and opaque extensions are not a universal secret detector. Choose ordinary source metadata and the intended published locators explicitly.

Optional `referenceLog` supplies exact string data, including empty, for nested JSON text `{type:3,data:referenceLog}`. `decorLogJson` supplies exact complete JSON text with a nonnull object or array root for the outer `decorLog`; it is validated without reserialization. The whole prepared parameter set, before SDK IMEI injection, is bounded at 512 KiB. The API submits selected metadata; preview/renew/clone/source retrieval and local message rendering remain application workflows.

## Request and partial result

One FILE-service POST uses `/api/message/mforward` with `toIds:[{clientId,toUid,ttl}]` plus IMEI, or `/api/group/mforward` with `grids:[{clientId,grid,ttl}]` and no IMEI/visibility. Account-AES form params and common version/type query reuse the existing authenticated transport. The request adds independent top-level `ttl`, string kind, `totalIds`, JSON-text `msgInfo` and optional decor log. It adds neither singular `zsource` nor a top-level client ID. Redirect errors and exact HTTP 200 qualification precede the normal two-layer account reply decoder.

`OrdinaryMessageForwardResult` contains deeply owned/frozen `raw`, `reportedSuccesses`, `reportedFailures` and `unresolvedTargets`. Each report contains the captured `target` and its `row` in the owned raw provider data. The native field is **`failed`**; unexpected `fail` remains raw and is not renamed. Row extensions remain available. No required message-ID/error DTO or complete-recipient result is manufactured.

Only actual `raw.success` and `raw.failed` arrays contribute rows. Other field values stay raw. A row matches only its own positive safe numeric client ID or the exact canonical string of one captured ID. Leading-zero/exponent strings, missing/foreign IDs and coercive values do not acquire another target's identity. A matched ID must occur exactly once across both arrays; duplicates and success/failure contradictions leave that target unresolved. Reports keep provider order; unresolved targets keep input order. Recognized unique reports survive unrelated unrecognized rows. A decoded empty reply can leave every target unresolved.

These are current provider reports. They establish neither receipt/rendering, complete membership of the arrays, source-asset lifetime nor absence of undocumented effects. `row.error` is raw row data, not authority for a whole-request SDK refusal. The SDK preserves uncertainty for the application to reconcile rather than converting missing targets into failures.

Raw results are JSON objects copied/frozen under 20,000 nodes, depth 32 and a cumulative 1 MiB UTF8 budget for strings and keys. These are post-decode structure bounds; they are not an HTTP read-byte, deadline or aggregate memory guarantee. Existing configured transport limits still apply.

## Cancellation, concurrency and errors

`forwardOrdinaryMessage` and [static-location forwarding](location-forwarding.md) privately reserve input client IDs together for their API instance until the local operation ends. Any overlapping active call across these two helpers is `busy` before handoff; disjoint calls may proceed. This owner-only lease does not coordinate other send APIs/processes and is not a durable replay cache. A genuine signal is privately bridged without caller-owned getters/methods/reasons. The owner wait uses an unexposed signal and a distinct derived transport signal; actual abort settles locally even when a transport ignores it, while late results/rejections are contained. Input and selected metadata are snapshotted before asynchronous work.

`OrdinaryMessageForwardError(code, submitted=false, outcomeUnknown=false, providerCode?, status?)` has fresh fixed messages and no raw source/body/URL/cause. Codes are `busy`, `aborted`, `unsupported-service`, `request-failed` and `submission-unknown`. Input/descriptor/value violations reject with a fixed TypeError before dispatch.

The conservative handoff marker precedes asynchronous cookie lookup/adapter invocation; submitted does not prove a wire attempt or server receipt. Before that marker, submitted/outcomeUnknown are false. A current genuinely decoded nonzero account-envelope refusal is `request-failed,true,false`; public or previously obtained errors cannot supply that authority. Other failures after handoff are `submission-unknown,true,true`; actual cancellation is `aborted` with the corresponding handoff/uncertainty facts. SDK-emitted optional status stays undefined because this owner has no private current-HTTP-status provenance; arbitrary public error hints are not relabelled as current status. SDK errors do not claim every target failed or select a retry. The lease is released on every local terminal path; keep IDs and reconcile uncertain actions before another explicit attempt.

## Evidence and validation

All 34 independently authored batch-forwarding fixtures, 31 location fixtures and 130 focused existing recall, forwarding and protocol tests pass locally. The checks use synthetic account data and HTTP adapters. No live message, account or recipient action has been performed for this slice; these checks do not establish current provider admission, feature flags or recipient rendering.

Installed Desktop 26.11.10/build26.11.10.3400 is pinned in [Desktop evidence](desktop-evidence.md). SHARED SHA256`32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` has source projection12100191+, enum1536873, adapter12460744+, common forward transform12458543+, target/top TTL helpers13501366+ and reference serialization16788606. Renderer STARTUP SHA256`899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121` has source normalization10255k+, RTF1026467, per-target producers10285k–10312k, link preview normalization10347k–10365k and registered kind handlers10428k+. This is a different member from MAINPROC.

Native UI's newer forward flag has shipped default 0; compiled reachability is not an account's observed flag. Its group producer separately falls back for groups at/above the configured threshold (shipped 100 members). No large-group eligibility, hidden E2EE state, automatic preview or album policy is inferred by this primitive. Complete client forwarding, trusted relink and the original all-operation/native goal remain unfinished.
