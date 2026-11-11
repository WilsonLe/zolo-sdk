# Automatic and suggested translation

`translateMessagesAutomatically` translates one explicit batch of existing message identities. `suggestMessageTranslation` translates one explicit draft/message through the suggested route. Both wait for the HTTP acknowledgement and correlated realtime result. They reuse the existing API's authenticated `RealtimeFrameFeed`; neither opens/stops the feed, selects messages, detects language, changes settings, sends a chat message, retries, or writes an application cache.

```ts
import { translateMessagesAutomatically, suggestMessageTranslation } from 'zalo-personal-sdk';

const header = {
  threadId: applicationSelectedThreadId, // decimal ID without Desktop's g prefix
  type: 1 as const, // 0 direct chat, 1 group
  srcLang: 'en' as const, desLang: 'vi' as const,
};
const batch = await translateMessagesAutomatically(api, {
  ...header, feed, signal,
  msgs: [{ text: '@Alice hello', metadata: {
    cmi: applicationClientMessageId, gmi: applicationServerMessageId,
    immutableItems: [{ start: 0, len: 6, type: 0, mentionId: applicationMentionUserId }],
  } }],
});

const suggestion = await suggestMessageTranslation(api, {
  ...header, feed, signal,
  msg: { text: 'Hello world', metadata: { immutableItems: [] } },
});
// These results are restored translations. No draft or chat message was sent.
```

The source/destination languages are explicit canonical `vi`, `en`, `zh-hans`, `zh-hant` or `ko`. The supplied pair is projected unchanged into the request; no local detector or current thread setting is consulted. Provider entitlement and accepted language pairs remain server decisions. Thread IDs are positive decimal strings, with numeric thread type `0` or `1`.

## Complete rich messages

The manual, automatic and suggested APIs share the validated codec in `translation-codec.ts`. [Manual translation](translation.md) documents the proved item schema and UTF-16 offsets: mention type `0` with string `mentionId`, link type `1`, emoji type `2`. Each message must explicitly provide `metadata.immutableItems`, including `[]` for plain text. Unsupported editor/style fields and missing, overlapping, out-of-range or surrogate-splitting spans fail before I/O. The helper does not silently flatten rich content or omit protected items.

Automatic input additionally requires `metadata.cmi` and `metadata.gmi`. One through fifty messages are accepted; every identity pair must be distinct. Safe nonnegative numeric identities and decimal strings up to 40 digits are accepted and sent as strings. Original IDs, text and spans are cloned before asynchronous work. The caller owns message selection and eligibility; this low-level batch does not recreate Desktop's received-message, viewport, cache or retry policy.

Received text is restored using the original protected substrings and identities. Missing/null/empty provider mention IDs use the same first-unused-original fallback as the shipped renderer. Complete protection is required, matching the stricter manual SDK policy: malformed or unmatched protected spans reject rather than returning a successful result that lost content. Provider metadata is retained in each result's `raw` record.

## Two-leg completion and correlation

| Flow | Exact POST path on `ai_features` | Account-AES JSON fields |
| --- | --- | --- |
| Automatic | `/api/aifeatures/translate/v1/auto` | `{reqId,threadId,type,srcLang,desLang,msgs:[{text,metadata:{cmi,gmi,immutableItems}}]}` |
| Suggested | `/api/aifeatures/translate/v1/suggest` | `{reqId,threadId,type,srcLang,desLang,msg:{text,metadata:{immutableItems}}}` |

Both use normal client-version query fields and encrypted form `params`, without IMEI or language injection. Redirects are rejected. Successful empty account acknowledgements are accepted, as in Desktop. Any HTTP text field is acknowledgement data only and is never used as a translated result. Optional `httpResponse` preserves that decoded acknowledgement separately.

Each invocation creates one fresh bare decimal request ID: node `258` for automatic, `256` for suggested. The shared per-node int64 generator uses the same epoch-zero 41-bit timestamp, 10-bit node and 12-bit monotonic sequence as Desktop. Manual node `257` retains its `pcw_` prefix and existing public behavior. The generator handles equal/reversed clocks and sequence overflow; it does not claim uniqueness across independent processes that recreate the same timestamp/node/sequence.

Controls arrive on commands `601`/`603`, under `data.controls[].content`, with `act_type:'translate'`. Object data and one JSON-string data layer are supported. The request ID is read from `data.body.reqId`:

| Control act | Successful result body |
| --- | --- |
| `translate_incoming_resp` | `{reqId,...,msgs:[{text,metadata:{cmi,gmi,immutableItems}}]}` with numeric `err:0` on the enclosing data object. |
| `suggest_translate_resp` | `{reqId,...,msg:{text,metadata:{immutableItems}}}` with numeric `err:0`. |

The operation listens before submitting HTTP. A successful early control is buffered until acknowledgement; an acknowledged request waits for its control. The feed must belong to the same authenticated API instance. Wrong control types, stale request IDs and unrelated requests do not complete an operation. Matched nonzero provider error codes reject even when the message payload is absent or null.

Suggested translation keeps the first successful control leg. Later duplicate controls, including a duplicate error before the HTTP leg finishes, cannot replace it. HTTP refusal still fails the operation. Completion requires both legs and returns `{reqId,text,metadata,mentions,raw,rawControl,httpResponse?}`. `raw` is the provider message before restoration; `rawControl` is its enclosing translation control object.

Automatic translation collects partial chunks keyed by the exact `(cmi,gmi)` pair. It ignores duplicate and unexpected identities and malformed rows that cannot identify a usable message, as the native coordinator does. The first accepted result for each known pair wins. A malformed known message's protected metadata fails the operation. Completion requires HTTP acknowledgement and one restored result for every original pair. `messages` are returned in input order, independent of chunk arrival order, together with `reqId`, accepted `rawControls` and optional `httpResponse`.

Raw controls are retained only when they contribute a newly accepted message, so duplicate-only traffic cannot grow that list beyond the fifty expected identities. A successful automatic control with an empty/non-array `msgs` is invalid. A partial or all-unknown batch does not become a falsely complete result; it waits for the remaining expected identities until an explicit error, closure, cancellation or deadline.

Each operation also has a fixed **16 MiB aggregate retained-result budget**, shared across accepted controls, restored results and decoded HTTP acknowledgement data. A control is staged and validated, then charged before any of its new results are committed. A control that would exceed the budget fails the operation with `result-limit`; none of that control's results are added. Earlier committed results remain available privately only after HTTP acknowledgement. Unmatched and duplicate-only controls are ignored without being retained or charged. Nothing is silently dropped to produce an apparently complete success.

The budget uses UTF-8 JSON byte costs with a small envelope allowance. It charges every full accepted raw control, including unknown fields and unrelated rows that remain inside it; restored metadata/mentions and changed restored text are additional payloads. A result's `raw` message is the same object already retained inside that control and is not charged twice. Identical unchanged result text is likewise not counted as a distinct logical payload. The HTTP acknowledgement's complete decoded data is charged before retention. Its successful receipt sets `acknowledged:true` even when its oversized data triggers the limit. A fifty-message plain batch with each output at the 256 KiB message limit therefore fits when it carries ordinary metadata and no oversized extensions.

This is an application-payload accounting bound per operation, not a physical heap-size guarantee or a limit on all concurrent SDK work. Parsing a current frame/HTTP response and making explicit caller copies can temporarily allocate additional memory. The existing frame, text and pending-operation limits still apply; applications choose their concurrency and own any copies returned by private partial-result getters.

The shared JSON decoder preserves large integer tokens as exact decimal strings, including within stringified control data. Safe numeric IDs normalize to their string representation for comparison. This recovers numeric wire representations only when their literal digits remain exact. If the provider already rounded an identity before serializing it, the SDK cannot recover the original digits; that unexpected pair is ignored and the original stays unresolved. There is no approximate numeric match.

## Errors, partial results and lifetime

`TranslationRealtimeError` exposes a sanitized `code`, `submitted`, `acknowledged`, optional `reqId` and numeric `providerCode`. `submitted` means the helper entered its submission step, not independent proof of delivery. `acknowledged` means its HTTP acknowledgement was decoded. Cancellation or transport failure can leave accepted provider work unknown. No request is automatically repeated.

Codes distinguish unavailable/closed feed, concurrency bound (`busy`), retained-result budget (`result-limit`), missing service, provider rejection (`rejected`), unconfirmed HTTP submission (`submission-unknown`), malformed response, caller abort and deadline. Error messages contain no text, spans, raw responses, URL or original adapter exception.

Automatic failure also retains application data behind non-enumerable getters:

```ts
try {
  await translateMessagesAutomatically(api, input);
} catch (error) {
  if (error instanceof TranslationRealtimeError) {
    // Explicit access returns copies. Never infer that the unresolved messages were retried.
    const completed = error.partialResults;
    const remainingPairs = error.unresolved;
    await applicationReconcilesPartialTranslation(completed, remainingPairs);
  }
  throw error;
}
```

Only restored results from an HTTP-acknowledged request are exposed as partial results; an unacknowledged request does not label its early buffered controls as completed work. The getters return copies. Text, spans and unresolved identity lists are not serialized by `JSON.stringify(error)`. Applications own durable state and any explicit later resubmission.

The default end-to-end wait is 7,000 milliseconds for each flow, matching installed defaults. `timeoutMs` accepts 1–120,000 milliseconds. This SDK deadline also bounds feed readiness, HTTP body completion and final chunk arrival, including a custom adapter that ignores abort. Closure, cancellation, failure and deadline release pending state and abort the owned request signal; late responses cannot settle a new operation or escape as a successful return. A successful correlated completion wins before later terminal events. The shared feed itself remains caller-owned and is never stopped.

SDK bounds, not measured server maxima: 32 pending realtime translations per feed; fifty source messages per automatic request; 4,096 controls per frame and rows per automatic control; 16 MiB per JSON-string control payload; 16 MiB aggregate retained result per operation; the shared codec's 256 KiB UTF-8 text and 4,096 immutable-item limits. The underlying shared feed also applies its own frame limits. No automatic language detection, viewport selection, app-store merge, settings mutation, debounce, UI rendering, message sending or native retry/recovery flow is implied.

## Evidence and verification

Evidence is installed Zalo Desktop 26.11.10 build 26.11.10.3400, exact integrity-checked packed bytes. Offsets are zero-based UTF-8 bytes.

| Artifact / bytes | Contract |
| --- | --- |
| SHARED 10,493,920–10,494,450 | Route commands, control acts, node IDs and manual prefix. |
| SHARED 12,026,350–12,030,700 | Control grouping, one-layer JSON data decoding and `translate` dispatch. |
| SHARED 16,130,210 onward | Int64 generator and per-node state. |
| MAIN 2,181,300–2,184,400 | Automatic 1–50 distinct rich-message validation, pending originals, exact wire projection and HTTP acknowledgement. |
| MAIN 2,184,400–2,188,000 | Automatic partial chunks, identity pairs, duplicate/unexpected filtering, deferred completion and failure bookkeeping. |
| MAIN 2,225,500–2,235,300 | Suggested request projection, pending HTTP/control legs, first successful control and completion. |
| MAIN 2,126,540 onward | Translation push-event dispatch. |
| MAIN 2,642,100 / 2,642,319 | Automatic/suggested seven-second default deadlines. |
| MAIN 2,682,198–2,689,000 | Shared immutable-span projection/restoration and ID-generator wrapper. |

MAIN SHA-256 is `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`; SHARED SHA-256 is `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. Earlier REA analysis remains blocked by its recorded macOS Swift-helper failure, so this slice uses the established packed-byte fallback and claims no native runtime observation.

Offline fixtures were authored before the module and use real local WebSocket feeds plus independently encrypted synthetic account HTTP envelopes. Nine fixtures cover exact fields, nodes and IDs, both arrival orders, partial chunks and duplicates, concurrent flows, numeric ID corruption, protected restoration, malformed/refused/unconfirmed responses, JSON-safe partial access, feed readiness/closure, foreign feeds, cancellation, deadlines through an abort-ignoring adapter and pending-slot cleanup. A retained fixture failed before correcting duplicate suggested-error ordering. The existing seven settings/manual fixtures still pass after factoring the shared codec. No live translation or setting change was performed.

Six additional fixtures in `test/translation-result-budget.test.mjs` cover aggregate growth, pre-ack privacy, post-ack ordered/copy-isolated partials, oversized HTTP data, ignored duplicate/unmatched traffic, a legitimate maximum-text batch, and a suggested operation's combined control/HTTP budget. Before the fix, fifty individually permitted approximately 512 KiB controls returned a successful result retaining 26,223,142 JSON bytes. The retained regression failed on that candidate and now rejects with `result-limit` without exposing unacknowledged partial translations.
