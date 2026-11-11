# Profile metadata, verification and client activity

`getProfileMetadata(api, targetUserId, signal?)` reads another user's extra profile information. `getProfileVerificationStatus(api, signal?)` reads the authenticated account's verification status. Both use the advertised `profile` service and the normal encrypted account response decoder. They make one request, reject redirects, and perform no cache writes, asset downloads, verification-message submission, or profile-mode change.

```ts
import { getProfileMetadata, getProfileVerificationStatus } from 'zalo-personal-sdk';

const metadata = await getProfileMetadata(api, applicationSelectedUserId);
const status = await getProfileVerificationStatus(api);
if (status.status === 1) {
  // This is the provider's currently observed verified code.
}
```

The target ID must be a positive decimal string of at most 40 digits and must identify another user. The installed public helper rejects the authenticated own UID as well as its special self sentinel `0`; the SDK rejects both before I/O. Use the existing `api.fetchAccountInfo()` operation for the signed-in profile. The metadata target is not a phone number or group ID. The status route has no target parameter and reads the authenticated account. Authorization and feature availability remain server decisions.

The metadata result keeps the provider's field names and extensions:

| Field | Contract |
| --- | --- |
| `photos` | Optional array of unchanged URL strings, or null. Order and empty strings are preserved. The helper does not follow the URLs or reinterpret them. |
| `photoMetas` | Opaque provider data, retained unchanged. The installed UI accesses this value by the photo's index, but its inner layout, top-level array/object shape, and length relationship are not established. |
| `groupIds` | Optional array of group identifiers, or null. Order and an existing `g` prefix are preserved. Safe numeric IDs normalize to decimal strings; large JSON integers are parsed without precision loss. |
| Other fields | Retained as decoded provider extensions. |

Missing fields stay missing; null and empty arrays remain distinct. The helper does not zip photos with metadata, truncate mismatched arrays, build a guessed metadata schema, filter hidden groups, or manufacture the UI cache's `fetched` or `ts` fields. A directly returned object and an object encoded in one additional JSON-string layer are both supported, matching the shipped public profile helper. Malformed JSON, a further string layer, and non-object results are rejected.

Local SDK bounds are 10,000 photo strings, 64 KiB UTF-8 per photo string, 20,000 group IDs, and 40 decimal digits per ID. These are not measured server maxima. Photo URLs, metadata and group membership are account data; the helper returns them to the caller without logging them.

Verification returns the full provider object with required numeric `status`. The installed enum is:

| Value | Observed meaning |
| --- | --- |
| `1` | Verified |
| `-5` | Needs verification |
| `-3` | Pending manual review |
| `-2` | Pending contact review |
| `-1` | Automatic review failed |
| `-6` | Manual review failed |
| `-4` | Forced re-verification |

The SDK retains future safe-integer codes outside this table, including zero, instead of defaulting them to a known state. A string code is not coerced to a number. Provider extensions remain intact. A verified status is a provider response, not an independent assertion about account ownership, eligibility for every feature, or a permanent status. The installed client caches a verified code; this helper deliberately performs a fresh explicit read and does not copy that cache policy.

The exact requests are:

| Helper | Request |
| --- | --- |
| Metadata | GET `/api/social/profile/extra`, common client query and account-AES query `params` containing `{profile_id:targetUserId,imei}`. |
| Verification | GET `/api/social/profile/verification/status`, common client query only: no encrypted `params`, IMEI, language, or target ID. |

Provider failures retain the safe numeric `ZaloProtocolError.providerCode`. Invalid response errors omit the provider body, transport errors omit the original exception, and cancellation is forwarded. Neither read automatically retries. The adjacent `/api/social/ekyc/push-oa` and `/api/social/profile/mode` endpoints are separate mutations and are not invoked by either helper.

Evidence is installed Zalo Desktop 26.11.10 SHARED, SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. Offsets below are zero-based UTF-8 bytes. [Artifact identity](desktop-evidence.md)

| Bytes | Evidence |
| --- | --- |
| `12498912`–`12499170` | Metadata builder, command 11864, profile service and encrypted fields |
| `12109430` | Normal account-response metadata wrapper |
| `345958`–`346200`, `16520700`–`16521450` | Parallel photo/metadata indexing and group-array use |
| `11401952`–`11402320` | Consumer accepts existing `g` prefix as well as raw group IDs |
| `13937821`–`13938580`, `16520700` | Public UI helper rejects own UID/self sentinel, accepts one extra JSON layer, and adds cache-only `fetched`; profile UI separately skips own UID |
| `12533988`–`12534280` | Verification GET builder, command 12150, common query only; adjacent push mutation is separate |
| `9160080`–`9160710` | Status extraction, cache update, and verified-cache short circuit |
| `15404456`–`15405030` | Seven observed verification status values |

`test/profile-metadata.test.mjs` independently decrypts synthetic requests and returns synthetic encrypted responses. It verifies the exact routes and fields, omitted-params status read, both metadata encodings, opaque metadata preservation, group-ID precision/prefix/order, missing/null/empty data, all observed and future status values, malformed responses, pre-I/O own-UID rejection, cancellation and sanitized failures. No live profile operation was performed for these fixtures. The own-UID regression failed before the guard was added and now verifies rejection with zero requests.

On 6 November 2026, separate read-only verification against one existing friend accepted the metadata request with HTTP 200 and provider code 0: the result contained zero photos and three group IDs. A separate authenticated-account verification-status read also succeeded. No profile IDs, group IDs, names, photo URLs, or returned status values are recorded here. The earlier own-UID metadata probe was input misuse under the installed public helper's contract; the SDK now rejects that case before I/O. These measurements establish successful reads for the tested account and target, without claiming that every account or target is available. No adjacent verification-message or profile-mode mutation was tested.

## Friend Desktop/Web activity observations

`getFriendClientActivity(api, signal?)` reads one provider map from GET `/api/social/friend/active-pcweb` (12072). It uses the `profile` service, common client query and the standard nested account-AES response. This operation requires HTTP 200 before consuming the body. It supplies no encrypted params, IMEI, language, target IDs or cursor and rejects redirects. The common restricted transport also enforces the existing metadata/status calls' redirect rejection. It rejects HTTP 3xx, any `Location` header (including an empty value), a response marked redirected, or a changed response URL before reading the body. Rejected response bodies are cancelled when available; no follow-up request is issued.

```ts
import { getFriendClientActivity } from 'zalo-personal-sdk';

const result = await getFriendClientActivity(api, signal);
const observed = result.entries[applicationSelectedUserId]?.known;
if (observed?.isActivePC === 0 && observed?.isActiveWeb === 0) {
  // Exactly the numeric-zero comparison used by the installed share picker.
}
// Unsupported fields and rows remain available in result.raw.
```

Each entry is `{ raw, known? }`. Ordinary object rows produce a frozen `known` object with any own finite numeric `isActivePC` and `isActiveWeb` fields. Numbers retain their values, including zero, negative zero, negative values and fractions; no 0/1 enum, integer-token policy or Boolean online label is imposed. Strings such as `'0'`, booleans, null, missing values and other unsupported flag values stay raw without a numeric projection. The common lossless parser preserves unsafe integer tokens as strings, which remain unprojected. An ordinary row with no supported fields yields `known:{}`. Scalar, null, array, class/proxy or selected-accessor rows retain `raw` without `known`.

`entries` and `raw` are owned, frozen null-prototype maps, preserving every opaque provider key exactly. Keys are not converted to numbers, trimmed or validated as a new friend-ID grammar. Leading zeros, large decimal text and own `__proto__`/`constructor` keys remain distinct safe entries. Wrappers and known projections are frozen. `entry.raw === result.raw[key]`; nested raw rows are original decoded references and are neither cloned nor recursively frozen. Key enumeration follows the decoded object's own-key order, not original wire token order or duplicate-property retention.

An empty map is valid. Missing, falsey, scalar, array or JSON-string roots fail `ZaloProtocolError('invalid-response')`; an extra JSON-text layer is not parsed. At the post-decode feature qualifier, root accessors, proxies, symbols and nonenumerable properties fail without inspecting their selected values. Actual remote JSON cannot carry accessors/proxies; custom decoder tests separately account for mandatory Promise then-probes before this qualifier. Limits are 20,000 map slots and 256 UTF-8 bytes per original key, checked before row projection. These are SDK post-decode bounds. Raw API transport still reads the whole response before qualification; this feature adds no generic wire-byte or deadline guarantee. Normal cancellation, service and safe provider errors remain available, with no automatic retry.

The flags have no established timestamp, revision, expiry, page or completeness contract. This read does not establish realtime presence, a linked-device inventory, invitation eligibility or overall account availability. The native caller uses the strict-zero comparison while applying its own invitation-picker policy; the SDK returns observations and performs no filtering, invitation, contact refetch, cache write, ping or profile-mode change.

Source is the pinned installed SHARED member: builder 12,533,073 onward, normal decoder wrapper 12,119,429, active picker load 13,623,326 and reload 13,625,850–13,626,380, strict-zero consumer 13,621,787. The invitation entry point is 1,598,155 with its picker configuration at 1,594,748 onward. This is separate from upstream friend-online and last-online operations. Synthetic fixtures and public consumer checks validate the local contract; live availability for this new read remains unverified.
