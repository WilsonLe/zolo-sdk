# Passive signed device-list updates

`extractTrustedDeviceListEvents(frame)` reads ordinary decoded `user_devices` controls without starting a listener, making a request, consulting a clock or changing account/device state. It preserves selected raw wrappers in provider order and attaches a wire-qualified list only for the installed `update_user_devices` action.

```ts
import { extractTrustedDeviceListEvents, verifyTrustedDeviceList } from 'zalo-personal-sdk';

for (const event of extractTrustedDeviceListEvents(frame)) {
  if (!event.list) continue;
  const verification = verifyTrustedDeviceList(event.list, {
    primaryIdentityKey: applicationTrustedPrimaryPin,
    companionIdentityKey: applicationKnownLocalCompanionPin, // optional
    nowMs: applicationChosenVerificationTime,
  });
  applicationChooseHowToHandle(event, verification);
}
```

The extractor does **not** verify signatures or infer current trust. Supply identity pins independently, such as from authenticated pairing, rather than extracting a trusted primary key from the event being verified. A saved pairing list is historical evidence; current signature/expiry checks remain explicit. An ordinary Desktop session can exist without a verified companion. [List verification](trusted-devices.md) · [Pairing](trusted-device-pairing.md) · [Stored evidence](desktop-session-store.md)

## Event and qualification contract

Each frozen `TrustedDeviceListEvent` contains:

- `controlIndex`: the original selected row's position in `controls`.
- `act`: the captured raw action, including unknown actions without coercion or interpretation.
- `rawControl` and `rawContent`: the original wrapper references, including raw data, timestamps and unknown fields. These references are neither cloned, frozen nor mutated.
- Optional `list`: an owned, deeply frozen `QualifiedTrustedDeviceList`. Its root, `devices`, companion array and scalar companion records are frozen. The input is not frozen or modified.

`QualifiedTrustedDeviceCompanion` and `QualifiedTrustedDeviceList` describe the existing raw list schema with readonly fields. “Qualified” means the wire fields satisfy the existing parser's bounded schema, not that the identities or signatures are trusted. The result is compatible with the existing `verifyTrustedDeviceList(value, options)` without another verifier wrapper.

Only exact `act:'update_user_devices'` enters qualification. Its data follows the installed first-character normalization: JSON is parsed once only when the first character is `{` or `[`. Whitespace is not trimmed and another JSON-string layer is not unwrapped. The normalized value must be an object; the existing parser then requires `devices` with its established fields:

```text
devices: {
  masterId, encIdentity, lastUpdateTs, encSignature,
  companions: [{id,linkId,encIdentity,platform,status,expireTs,encAccSign,encDeviceSign}]
}
```

Omitted/null companions retain the raw parser's empty-array compatibility. The qualified snapshot projects only established scalar fields. Unknown provider extensions remain accessible in the original raw wrappers/data instead of being copied into the trust snapshot. Exact uint64 IDs/timestamp text is preserved; unsafe already-rounded JavaScript numbers are not repaired by coercion.

Unknown `user_devices` actions are retained raw without speculative parsing or a qualified list. For the known action, malformed/missing list data also leaves the wrapper without `list`. A missing `list` is not a revocation, missing-companion verdict, invalid-signature verdict or proof that no list exists: an SDK qualification budget can also omit it. The native consumer only handles the exact known action; preserving other actions raw is an explicit SDK extension.

## Transport, ordering and trust boundaries

The shared ordinary-control reader requires version 1, command **601 or 603**, a byte subcommand, successful transport metadata and an own numeric inner `error_code:0`. String `'0'` or missing inner status is not accepted. Active resets suppress the normal controls, and unsupported reset forms are excluded conservatively. Malformed selected protocol accessors/budget violations return an empty extraction result. Unrelated act types are excluded before their data is inspected or charged to the selected-text budget.

Wire order, repeated controls and companion-array order are retained. The native controller uses `content.ts` for diagnostics; actual list ordering uses the signed **`devices.lastUpdateTs`** under its app-state lock. The extractor does not compare those timestamps, deduplicate, reject older signed candidates or treat unsigned control time as a trusted clock. Raw `ts`, `controlId`, versions and unknown metadata retain their provider form without assigned units or authority.

Verification stays separate. The existing verifier checks the primary pin and signed list, optional pinned companion and its device signature, the 21-day list lifetime and stale pinned-companion expiry. A deadline is valid at equality. It sorts an owned copy of companion rows for signature serialization; it does not reorder the event snapshot. Current supported verification excludes Mobile platform 0 and Deactivated status 2 even though those numeric values can be structurally qualified. [Exact verifier scope and signatures](trusted-devices.md)

The native application can retain an expired signed list, schedule expiry checks, recover a list after control overflow and apply revocation/logout policy. None of those state transitions is reproduced here. Unverified or expired raw controls never trigger cache replacement, pin changes, enrollment, revoke, logout, automatic HTTP recovery or persistence. Applications choose whether/how to compare verified signed timestamps and recover using the separate explicit HTTP list read. No per-device overflow action is inferred from a reset or a missing update.

## Resource and input boundaries

The shared reader caps ordinary control rows at 20,000. Selected `data`/`content` strings each have a 65,536 UTF-8-byte limit and a combined 1,048,576-byte frame budget. Qualification attempts are additionally limited to **64 exact update actions per extraction**, decremented before normalization/parsing even for malformed or empty data. Later rows remain raw events without a list. Unknown actions and unrelated act types do not consume qualification attempts. With the parser's 256-companion cap, this bounds copied companion records to 16,384 per extraction. These are SDK resource policies, not measured provider limits.

The shared raw-list parser captures bounded own data fields and indexed dense companion slots without invoking caller getters, iterators, `toJSON` or object coercions. Unknown wrapper metadata remains uninspected. Malformed data is contained rather than returning private parser/accessor causes. The extractor adds no second list parser or recursive unknown-object walker; it freezes the parser's owned scalar output. Original raw wrapper references can still change if their owner mutates them, while an already-qualified list remains stable.

## Source and verification boundary

Installed Desktop **26.11.10**, build **26.11.10.3400**, exact packed sources and zero-based UTF-8 byte anchors:

| Source | SHA-256 / relevant evidence |
| --- | --- |
| SHARED | `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`; **12,027,012** common normalization, **12,030,203** user_devices dispatch, **3,001,900–3,003,850** successful/reset control path |
| MAIN startup | `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`; **2,028,922–2,029,450** exact action/data/ts consumer, **2,011,526–2,012,100** qualification entry, **2,018,836–2,019,090** signed timestamp ordering, **2,024,614–2,027,440** pinned verification, **2,015,480–2,016,159** separate overflow recovery |
| Common startup member | `bc6d781d17b13d56fac5657dbb64d40c4dd5a8a1c701a35d2eff99b0455285dc`; **57,120–57,610** exact devices/companion field mapper |
| Trust worker | `f647cc926a90750b61158ef26fec4a846ea97e9d5fe641785c50e0910b048acc`; **126,631–127,059** struct verification adapter, **173,981–175,000** platform/status/error enums |

The packed member hashes were revalidated against ASAR integrity entries without executing app code, workers or WASM and without retrying REA setup. The existing verifier's synthetic signatures were previously checked against the shipped WASM, whose hash and signature evidence are recorded in [trusted devices](trusted-devices.md); this slice reuses those fixtures without another WASM run.

Focused offline fixtures cover raw/unknown actions, source normalization, strict success/reset guards, ordering/duplicate/timestamp distinctions, owned readonly snapshots, accessor/iterator/resource limits and explicit composition with existing signed fixtures for valid, expired, tampered, wrong-primary and missing/invalid-companion results. No live account read, device update, network/socket operation, enrollment or revoke/logout action is used for this implementation.
