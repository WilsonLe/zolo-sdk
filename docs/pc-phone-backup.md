# Existing PC-to-phone backups

The SDK reads an existing PC backup's metadata/configuration, explicitly signals a phone restore handoff, and passively projects backup controls. These operations use a live Desktop connection and its already-created SDK frame feed. They do not create an archive, upload files, fetch phone data, import a database or open another socket.

```ts
import { getPcPhoneBackupConfigs, getPcPhoneBackupMetadata,
  signalPcPhoneBackupRestore, extractPcPhoneBackupEvents } from 'zalo-personal-sdk';

const configs = await getPcPhoneBackupConfigs(connection, feed, { signal });
const result = await getPcPhoneBackupMetadata(connection, feed, { signal });
if (result.kind === 'metadata') {
  // result.metadata is the provider object; result.known has optional typed fields.
}

// Call only when the application explicitly intends to signal the phone.
const ack = await signalPcPhoneBackupRestore(connection, feed, { signal });
// ack.acknowledged confirms the signal's response, not phone acceptance/import.

const unsubscribe = feed.subscribe(frame => {
  const events = extractPcPhoneBackupEvents(frame);
  if (events) {
    // The application owns any attribution, UI, persistence or next action.
  }
}, [601, 603]);
```

These calls are separate choices: signaling does not automatically read metadata first, and reading does not signal a restore. The application owns the connection, feed and subscription. No helper stops them, resets cursors, removes files or cleans a local backup store.

## Request and ownership contract

All three requests use version1/subcommand0 and **data `{reqId}` only**:

| Function | Command | Successful response fields |
| --- | ---: | --- |
| `getPcPhoneBackupConfigs` |634| Numeric API error_code0 and own object data.configs. |
| `getPcPhoneBackupMetadata` |632| Numeric API error_code0 and own object data.metadata; numeric API1001 is the separate no-backup result. |
| `signalPcPhoneBackupRestore` |633| Numeric API error_code0 and own numeric data.err0. |

There is no IMEI, language, account-AES params, bkid, file locator, queue cursor or inventory lookup. These are direct socket API calls, independent of qCmds/ctrl_qCmds. The feed must come from `startRealtimeFrameFeed(connection.api)`, and connection must be a live SDK-created `DesktopSessionConnection`. A Web API, structurally similar connection, copied/custom feed or feed for another API does not satisfy that runtime ownership check.

Ownership is checked before pending resources and again immediately before handoff. Connection closure settles pending operations using the private Desktop lifetime signal; no credential snapshot or secret logging is needed. The helper never opens, replaces, redirects or reconnects a feed.

After feed.ready resolves true, the helper submits each request once. It shares a sequence and at most**32 pending calls per feed**, including calls waiting for authentication, across all three operations. IDs retain native req_decimal spelling, start from a random unsigned64-bit value per feed, increase monotonically and are never reused on that feed. This is SDK correlation policy, not a claim that the provider requires randomness or an app-global sequence.

A reply must have exact version1/command/subcommand0 and an own string data.reqId equal to a pending request of that command. Replies before that request begins handoff, aliases, inherited IDs, ID-less packets, other headers and old/other IDs are ignored. Only after correlation are transport/API/operation status fields interpreted. Concurrent requests may finish out of order. Synchronous valid replies take precedence over a later local send exception or connection close.

Options have optional signal and integer timeoutMs1–2147483647, default10000ms. The deadline covers authentication wait and reply. Cancellation/timeout removes only that request; late replies cannot complete a later request. One response subscription is attached while requests are pending and removed when the last settles. There is one private Desktop lifetime observer per feed, removed on closure, rather than one per pending call. Caller abort handlers and request timers are removed on settlement. Faulty unsubscribe methods cannot block settlement. A custom overridden synchronous adapter that ignores cancellation cannot be forcibly interrupted, and no resend is scheduled.

## Read results have no local defaults

Config results contain `{frame,raw,configs,retentionMilliseconds?}`. raw is complete decoded data, including reqId and unknown extensions; configs is the exact config object. A positive finite numeric configs.retention_time projects directly to milliseconds. A string/future form remains raw without a fabricated value. The native code does not multiply this field by1000.

Metadata results are a discriminated union:

- `{kind:'none',providerCode:1001,frame,raw}` only for a correlated **numeric API-envelope1001** with successful transport status.
- `{kind:'metadata',frame,raw,metadata,known}` for a successful metadata object. known optionally exposes bkid, sizeBytes, createdTimeMilliseconds, expiredTimeMilliseconds and deviceName. Empty/missing fields do not create fallback values or prove that a restore is usable.

Other refusals, malformed replies, closure and read failures do not become absence. In particular, transport1001 and string API `'1001'` are refusals rather than no-backup results. The SDK does not copy native UI behavior that collapses all read failures to “no backup.” API or operation status string `'0'` is not a successful numeric0.

Size is bytes; create/expiry values are epoch milliseconds. Known quantities retain safe nonnegative integer numbers or exact canonical nonnegative decimal strings up to40digits. Unknown forms remain raw. bkid is opaque: a nonempty string up to512 UTF-8 bytes or nonzero safe integer is preserved **without coercion or trimming**; it is not assumed to be a decimal ID/UUID. String and number IDs are not equated. Known deviceName text is limited to64KiB UTF-8. No current time, hostname, expiry, TTL, device default, checksum result or ordering is synthesized.

Returned wrappers and known metadata are frozen. frame/raw/config/metadata references retain complete private provider input, including unknown nested values; they are not deep-frozen, cloned or redacted. Keep raw account/backup information private rather than forwarding it into logs or bot messages.

## Restore handoff and errors

`signalPcPhoneBackupRestore` returns `{submitted:true,acknowledged:true,outcomeUnknown:false,frame,raw}` only after its correlated API error_code0 plus data.err0. **Command633 carries no bkid.** It cannot atomically select the backup previously read, prevent another client replacing that backup, or prove that the phone accepted, decrypted or imported any records. There is no automatic monitor, polling, notification retry, status read or follow-up action.

`PcPhoneBackupError` has a fixed message and code, operation (`configs|metadata|restore`), submitted, outcomeUnknown, optional safe providerCode and optional fixed reason. It contains no raw reply, request ID, backup ID, provider text, credential, cause or arbitrary local exception.

- Before handoff, invalid options/connection/feed, pre-abort, unavailable/closed feed, pending limit, deadline or local adapter failure report a fixed failure with submitted false and outcomeUnknown false.
- A correlated explicit nonzero transport/API/restore-operation status reports rejected with only a safe integer provider code. Future safe integer codes are retained, including bounded decimal-string nonzero codes; unknown/unsafe/malformed status values are not invented refusal metadata.
- After restore handoff, cancellation, timeout, closure, malformed status/response or local send failure reports **submission-unknown**, submitted true and outcomeUnknown true, with a fixed reason. The phone signal may have taken effect. Local errors, even caller-created SDK error objects, never supply provider-refusal metadata.
- Read failures retain their specific fixed code and handoff flag; outcomeUnknown false refers to the absence of a state-changing operation, not a claim that a read result was obtained.

There is no automatic retry or rollback. Known acknowledgement is returned even if cancellation/closure happens afterward. Local cancellation does not cancel or undo an already-submitted phone signal.

## Passive controls

`extractPcPhoneBackupEvents(frame)` returns ordered readonly wrappers or undefined. It reuses the shared successful non-reset601/603 account-control boundary: version1, integer subcommand0–255, absent/numeric0 transport status, own numeric inner error_code0, own controls array, at most20000 rows. Selected data/content strings are each at most64KiB UTF-8 and together at most1MiB per frame. These are SDK limits, not measured server maxima. Irrelevant families are ignored before selected-string budgeting; a valid frame without backup_pc2mb rows returns `[]`.

Each selected wrapper has controlIndex, actType:'backup_pc2mb', captured act, original rawControl/rawContent and optional change. Unknown acts, malformed selected JSON and unsupported fields remain raw. One-layer data normalization parses only a first character `{` or `[`, with no trim or recursive decode. Own data descriptors are captured without invoking accessors; private parsing/descriptor faults do not escape. Input and wire order are not mutated, deduplicated or folded.

Known projections are:

- `{kind:'backup-done',bkid?,raw}` for act backup_done. Native tolerates absent/nonobject data by substituting an empty object; the SDK instead preserves the exact normalized raw value, including undefined, and invents no object. An optional usable opaque bkid is retained when available.
- `{kind:'mobile-restore-status',status:1|100,bkid?,raw}` for act mb_start_restore with own numeric status1 or100. Native treats these as start/complete signals; the helper does not turn them into attributed import completion. Other status values remain raw wrappers without a change.

No request attribution is inferred from these controls. Native UI accepts an ID-less backup_done while monitoring and computes some restore-ID matches only for logging; the SDK does not reproduce those policies or clear another caller's state. Missing or mismatching bkid does not prove relation to a previous633 signal.

Control-domain reset metadata suppresses extraction; inactive values are absent/null/numeric0/string `'0'` in the bounded SDK domain. No reset/cursor/saveActionId/controlId/file cleanup is applied. A reset-named extension in a correlated632/633/634 API response is just raw API data and does not reset chat/reaction queues.

## Source and verification

Installed Desktop26.11.10/build26.11.10.3400, integrity-checked SHARED SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` and MAIN startup SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. Zero-based UTF-8 byte anchors:

| Bytes | Contract |
| --- | --- |
| SHARED7612400–7613400;14417800–14418700 | Command definitions/registration and exact632/633/634 reqId-only builders. |
| SHARED14413805–14416000 | API request IDs, correlation/error dispatch and10000ms default. |
| MAIN740700–743439;746700–747600 | Config/metadata/restore response consumers; numeric1001 and separate restore err0. |
| SHARED3931537; MAIN818900–820500 | Retention/create/expiry values consumed as milliseconds; native local defaults are not copied. |
| SHARED12029022; MAIN813617–818900 | backup_pc2mb dispatcher, optional opaque ID, backup_done and restore status1/100 policies. |
| MAIN801900–803600;807900–809900 | Native upload Success is not phone import confirmation; abort is local and sends no restore cancellation. |

Fixtures use real SDK Desktop/feed branding and codecs with synthetic HTTP bootstrap and an in-memory socket. They cover exact wire objects, all status levels, no-backup versus failure, unknown/omitted metadata, ownership, correlation, concurrency, early/late replies, limits, cancellation/deadline/close, local-error privacy, final handoff races and passive raw controls. The fixtures use no installed account store or phone restore signal. In a later authorized guarded Desktop check on6November2026, configuration634 was accepted and metadata632 timed out after5s; no raw frames were retained to diagnose that timeout. It does not prove backup absence or a wrong correlation contract. No live631/630/upload or phone import is established by these reads.

The separate [PC backup creation/recovery workflow](pc-phone-backup-creation.md) now formats caller-owned records, resolves global identities, builds a dedicated encrypted archive and binds631/630 plus sequential uploads to a durable authenticated checkpoint. These existing-backup read/signal/extractor functions do not invoke it. Both domains remain distinct from590 phone-to-client sync; upload ACKs and restore-signal ACKs do not establish phone import or live provider compatibility. [Mobile sync](mobile-sync.md)
