# Voice transcription

`transcribeVoice(api, {url, feed, signal?, timeoutMs?})` submits an explicitly supplied ordinary voice URL to Zalo's AI service and waits for its correlated realtime transcription. The existing `RealtimeFrameFeed` must belong to the same API instance. The helper never opens or stops a listener, uploads a file, recovers an expired URL, sends a chat message, or retries a conversion.

```ts
import { transcribeVoice, VoiceTranscriptionError } from 'zalo-personal-sdk';

try {
  const result = await transcribeVoice(api, { url: voiceUrl, feed, signal });
  // Preserve result.text exactly; result.isTruncated reports has_more truthiness.
  await applicationStoresTranscript(result.requestId, result.text, result.isTruncated);
} catch (error) {
  if (error instanceof VoiceTranscriptionError) {
    // These fields describe submission boundaries, not permission to retry.
    await applicationReconcilesConversion(error.code, error.submitted, error.acknowledged, error.requestId);
  }
  throw error;
}
```

The URL is sent to the provider, which must be able to fetch and interpret the ordinary voice bytes. HTTP and HTTPS are supported, matching the installed fetchability check. The SDK rejects credentials, fragments, whitespace, local/blob URLs and URL query keys or values containing an `e2esession` capsule. It preserves accepted URL bytes. A caller supplies a usable ordinary locator; it does not forward encrypted file keys to the transcription service. Voice URLs, text, and request IDs belong to private application state.

## Submission and completion

The exact HTTP operation is `POST /api/aifeatures/voice2text` on service `ai_features`, with normal client-version query fields and an account-AES form containing `{url}`. No IMEI or language member is added, and redirects are disabled. The response's nonempty `req_id` is an acknowledgment, not transcription text. An HTTP `text` field is never used as the final result.

Final data arrives on control command 601 or 603 under `data.controls[].content`, with `act_type:'voice2text'`, `act:'convert_finish'`, and object or one JSON-string layer in `data`. The installed result is `{req_id,err,has_more,url?,text?}`. `extractVoiceTranscriptionEvents(frame)` maps it to `{requestId,errorCode,isTruncated,url?,text?}`; other control types and malformed records are ignored. `isTruncated` follows the installed consumer's `Boolean(has_more)` rule. The extractor does not download or open returned URLs.

The operation observes controls before HTTP submission. It buffers early results by server ID and waits for HTTP acknowledgment before accepting a matching result. Before acknowledgment, a newer event with the same ID replaces the older buffered event, as the installed pending-result map does. After acknowledgment, the first matching completion settles the operation. Concurrent calls can complete in either order. Correlation uses the server-issued ID on this same authenticated feed; the provider's transcript is not independently verified against the audio.

Error code zero with a string transcript succeeds; text, whitespace and Unicode are retained exactly. An exactly empty string produces `no-text`. A successful control missing usable text is an invalid response. A nonzero provider result becomes `rejected` with its numeric `providerCode`, including when unused text or URL fields are null or malformed. Optional unusable payload fields are omitted; they do not suppress a known provider refusal. Error messages omit URLs, transcripts, raw responses, causes and caller cancellation details.

The default deadline is ten seconds, matching the installed completion-timeout fallback. This API applies it to feed readiness, HTTP and final completion together; the caller can choose one millisecond through ten minutes. It races adapters that ignore abort, releases its waiting state, and aborts the request signal on cancellation, closure or deadline. A timed-out adapter may still have reached the provider; cancellation cannot undo accepted work.

## Uncertain outcomes and bounded state

`VoiceTranscriptionError.submitted` means this helper entered the submission step; it does not independently prove a network packet reached Zalo. `acknowledged` means a usable HTTP `req_id` was received. A provider refusal can be `submitted:true, acknowledged:false`. Cancellation, deadline, transport failure or malformed acknowledgment can also leave accepted work unconfirmed. Reconcile before another explicit submission; there is no automatic replay.

The feed retains at most 32 active operations, 128 early uncorrelated results and the last 256 known completed/failed IDs. Excess concurrency returns `busy`; overflowing the early-result buffer fails affected submissions with `result-overflow`. Request IDs are bounded to 256 UTF-8 bytes, source/result locators to 16,384 characters, transcripts to 65,536 UTF-8 bytes, stringified control data to 128 KiB, and control batches to 4,096 entries. These are SDK bounds, not provider limits. Oversized/malformed control records are ignored and may lead to a completion timeout.

A repeated known ID is rejected as `request-id-reused`. If two concurrent HTTP receipts share an ID, both operations fail: a subsequent ambiguous result cannot complete the earlier request with the later request's text. Known retired IDs also prevent a late result from satisfying a new submission within the retained window. After 256 distinct known IDs, older guards can be evicted. An uncertain submission without an HTTP ID cannot be tombstoned by ID. This bounded mechanism cannot guarantee uniqueness across feed reconnects or reconstruct unknown submissions; the application owns reconciliation. Feed closure aborts all active operations and discards buffers.

## Evidence and checks

Evidence is installed Desktop 26.11.10 build 26.11.10.3400, from integrity-checked packed artifacts. Offsets are zero-based UTF-8 bytes. [Artifact identity](desktop-evidence.md)

| Artifact / offset | Contract |
| --- | --- |
| MAIN 2,092,331 | Exact account-AES POST `{url}` and ordinary response decoder. |
| MAIN 2,093,779 | `convert_finish` selection, required server ID and numeric error, result DTO dispatch. |
| MAIN 2,094,700 onward | Positive remote `transcribe.convert_timeout_ms` or ten-second default. |
| MAIN 2,097,900–2,102,000 | Early-result map, server-ID correlation, acknowledgment handling and late results. |
| SHARED 3,844,414 | `ChGq` fetchability check accepts HTTP/HTTPS. |
| SHARED 10,009,353 onward | `WQgh` result reducer: exact empty-string no-text check and provider errors. |
| SHARED 12,027,300–12,030,700 | Controls grouped by `act_type`, JSON-string data decoded, `voice2text` dispatched. |
| SHARED 15,935,998 | `v9mf` result projection for request ID, truncation, URL, error and text. |

MAIN SHA-256 is `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`; SHARED SHA-256 is `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. Native URL recovery uses local message resources and re-upload; that separate lifecycle remains unimplemented. Automatic retry/recovery and native UI/QoS state are not invoked here.

Nine offline checks exercise the exact encrypted HTTP envelope and real loopback WebSocket feeds: early/late controls, independent concurrent results, receipt/result separation, cancellation/deadlines through an abort-ignoring adapter, feed closure, late IDs, bounded buffers, malformed/error/empty results, input and service validation, and the retained cross-request-ID-collision regression. The collision regression failed before the fix by resolving the first operation with the second operation's text; both now reject. No live conversion or new live listener was opened for these checks.
