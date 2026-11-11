# Cloud media access and account reads

`acquireCloudMediaViewer` obtains the installed cloud viewer credential through an approved Desktop connection. `getCloudMediaQueuePage` reads one forward cloud queue page; `getCloudDownloadUrls` resolves selected cloud noise IDs using that credential. Those metadata readers do not fetch the returned locators. The separate explicit `fetchCloudResourceCiphertext` operation retrieves one caller-selected transport URL under an independent origin allowlist and returns an owned Buffer; it does not select a cloud record, decrypt media, recover a message or send a chat. A message ID is not a cloud noise ID. Four separate account-state readers expose usage, My Documents usage, subscription/migration metadata and cloud settings through the same viewer. The separate [offline PCloud decoder](pcloud-resource.md) accepts caller-supplied RSA keys, capsules and encrypted bytes; it does not acquire keys or fetch those locators.

```ts
import {
  acquireCloudMediaViewer, getCloudMediaQueuePage, getCloudDownloadUrls, restoreCloudMediaViewer,
} from 'zalo-personal-sdk';

// This explicit GET obtains credentials; server issuance/rotation effects are unknown.
const viewer = await acquireCloudMediaViewer(connection, { signal });
await protectedCredentialStore.save(viewer.sealState(wrappingKey));

// Empty string is the explicit initial queue cursor. This makes only one request.
const page = await getCloudMediaQueuePage(connection, viewer, '', { signal });
// The application processes records and atomically persists them with the cursor.
await cloudRecordStore.commitPage(page.mediaItems, page.lastNoiseId);
// Continue explicitly with page.lastNoiseId when appropriate; inspect page.hasMore.

// Select noise IDs from your reconciled records under your own application policy.
const result = await getCloudDownloadUrls(connection, viewer, noiseIds, { signal });
for (const id of noiseIds) {
  const locator = result.downloadUrls[id]; // Undefined when not supplied by the provider.
}

// Restore after reconnect using the same approved account, IMEI and auth origin.
const restored = restoreCloudMediaViewer(newConnection, savedCheckpoint, wrappingKey);
// Dispose each handle when finished. This is local cleanup, not server revocation.
viewer.dispose();
restored.dispose();
```

The caller supplies a separate random 32-byte wrapping key and protected credential storage. Keep the key outside the encrypted checkpoint. Acquire is an explicit credential GET; it may have server effects that source inspection cannot establish. None of these operations opens a message socket, automatically retries or refreshes credentials, or accesses the installed application's profile. Only an explicit `fetchCloudResourceCiphertext` call downloads resource bytes.

## Credential ownership

The frozen cloud viewer handle exposes readonly `kind: 'cloud'`, metadata, `sealState` and `dispose`. Kind is nonenumerable and is outside the exact existing checkpoint metadata; authentic older cloud checkpoints remain supported. The separate [family workflow](family-media.md) uses a disjoint family handle, while family usage still requires this cloud handle. Its metadata contains the SDK identity binding, approved auth origin and local acquisition time. That time is not a provider issuance or expiry assertion. Raw viewer headers, cloud ENK, account UID, cookies and private transport are absent from the public surface and ordinary errors. Copied, proxied and cross-account handles cannot authorize requests.

The connection privately captures its approved client identity, account decoder and validated service map at bootstrap. Replacing public context fields, a snapshot method, custom API methods or the public service map does not retarget this feature. Credential and cloud metadata requests use destination URL path/domain cookie scoping, including valid scoped Set-Cookie updates. Invalid or cross-domain cookies are ignored. The separate resource GET sends no account cookies and imports no Set-Cookie. Redirects and a mismatched response URL are rejected; connection deadlines and body bounds remain active through consumption. Directly modifying an owned cookie jar's methods/store through a raw API context is outside this ownership contract.

Acquisition holds the SDK connection mutation lock and a process-local account acquisition lease until completion. These cannot exclude other processes or the official app. Cloud reads can run concurrently. A local viewer can still be sealed after its original connection closes; remote operations require a live matching approved connection. A reconnect may use its newly validated cloud service configuration.

Local encrypted state uses purpose `zalo-cloud-media-viewer.v1.`. Its wiped plaintext buffer contains `ZCV1`, public-metadata length/JSON, header length/raw UTF-8 bytes and cloud-key length/raw AES bytes. Private credentials are not JSON/Base64 key fields. Restore authenticates the envelope and validates exact canonical metadata, binding, lengths, header and key rules. It cannot establish server validity, expiry, revocation or protection from an older authentic checkpoint. Same-account/IMEI/auth-origin binding is SDK policy, not a proved provider requirement.

`dispose` aborts owned work and wipes held buffers. It does not revoke the server credential. Immutable JavaScript strings, HTTP copies and crypto/runtime temporaries cannot be promised synchronous erasure.

## Exact protocol and supported input

| Operation | Installed request |
| --- | --- |
| Viewer acquisition | Saved auth origin, GET `/api/getCloudViewerKey`, normal account decoder and common `zpw_ver`/`zpw_type`. No params body, IMEI, language or cloud header. |
| Queue page | First owned `zcloud` base, fixed `/cloudmedia/queue/pc/verify`, common query and cloud-encrypted `{lastNoiseId,loadType:1,listNoiseIds:[],tracking_source}`. Same cloud header and fallback. |
| Usage | GET `/cloudmedia/info/pc/v2/usage`, common query only. |
| My Documents usage | GET `/cloudmedia/info/pc/v1/usage-mycloud`, common query only. |
| Account info | GET `/zalocloud/cloudinfopcweb/v1/info`, common query only. |
| Settings read | GET `/cloudmedia/info/pc/v1/cloud-settings`, common query only. |
| Locator lookup | First owned bootstrap `zcloud` base, fixed `/cloudmedia/downloadurls/pc/v1`, common query, cloud-encrypted `{list_noise_ids:[...]}` and `cloud-viewer-key` header. The installed `https://zcld.chat.zalo.me` fallback is used only when that service is absent/empty. |
| Selected resource (SDK policy) | One GET to the exact caller-supplied transport URL, with `cloud-viewer-key` and `Accept-Encoding: identity`; no account cookies, common query fields or encrypted params. |

The viewer URL preserves the observed `_get({})` quirk: it ends with an additional `?` after the common query fields. For example, `...?zpw_ver=695&zpw_type=30?`. This is source reproduction; server parsing/admission has not been verified live. The cloud metadata readers preserve an advertised service base path before appending their fixed route. The resource fetch instead uses its explicitly supplied transport URL unchanged. The four account-state GETs use only `zpw_ver` and `zpw_type`: they add no `params` member, body, IMEI, language, plan or extra trailing `?`. They select their endpoint explicitly rather than reproducing the native client's plan-dependent aggregate.

Noise IDs are opaque strings. One call accepts 1–100 dense own entries, each nonempty and at most 256 UTF-8 bytes without controls. These are SDK bounds; 100 follows native client batching, not a proved server maximum. Strings retain case, leading zeroes, nondecimal content, order and duplicates. Numeric/BigInt coercion is not performed. The native string alphabet and real ID length have not been established by the request builder.

The viewer header is an opaque, nonempty header-valid value of at most 16 KiB; no JWT schema is assumed. The cloud ENK is a separate standard-Base64 raw AES key. The SDK supports 16-, 24- and 32-byte keys and strict padding/UTF-8 validation. These are explicit standard-AES restrictions; the native code itself has no equivalent key-length/padding guard. The SDK never hashes, truncates, pads or substitutes another key.

## Explicit cloud queue pages

`getCloudMediaQueuePage(connection, viewer, lastNoiseId, { signal, trackingSource })` makes one forward page request. Pass `''` explicitly to begin, or the exact previously returned cursor to continue. A cursor is an opaque string, at most 256 UTF-8 bytes without C0/DEL controls or malformed Unicode; it is never trimmed, incremented or converted from a message ID, timestamp or number. These are SDK input/result bounds, not a proved universal provider grammar. Returned cursors must be original JSON strings; a numeric token preserved as text by the lossless parser cannot qualify.

The plaintext has exactly `lastNoiseId`, `loadType:1`, `listNoiseIds:[]` and `tracking_source` in that order. The examined active producer uses this forward direction and empty filter. No page-size, arbitrary direction or selected-noise filter is exposed. Optional numeric `trackingSource` is `0` (Unknown, default), `1` (Start_session), `2` (Need_Verify_CMD), `3` (Re_login) or `4` (Client). These labels are telemetry values, not modes that execute those events. Settings must contain only own data fields for `signal`/`trackingSource`; invalid options make no request.

The frozen result contains `mediaItems`, `lastNoiseId`, `hasMore`, `responseCode` and `raw`. All three provider fields must be present. `mediaItems` accepts up to 1,000 object records, preserving provider order, duplicate IDs, unknown actions and nested fields. Rows and all nested raw JSON are owned and deeply frozen. Raw depth is bounded at 32 and nodes at 20,000 in addition to the connection's body/deadline limits. Structural caps report `response-limit`; malformed required fields report `invalid-response`. These row/layout limits are SDK restrictions, not provider guarantees. Common lossless JSON parsing preserves integer identifier tokens and unsafe integer tokens as strings; raw results are parsed data, not exact wire bytes.

`hasMore` is the Boolean projection of the original provider value, matching the active consumer: `false`, `0`, `null` and `''` are false; `'0'`, `[]`, `{}` and nonzero numbers are true. `raw.hasMore` retains the parsed value. An empty page does not imply completion, and repeated/empty cursors remain valid even when `hasMore` is true. The SDK does not loop, infer progress, commit a cursor or persist records. The application owns processing, atomic cursor/data persistence, continuation and restart policy.

Rows are queue actions, not uniformly current downloadable media. Add/remove/thread-delete/reset/temp/duplicate and unknown records remain raw. The SDK performs no sort, deletion, reset, action acknowledgment, message identity normalization or local model mutation. The installed client looks up message associations in its local cloud database; its message-key index is explicitly nonunique. Your reconciled records may contain multiple noise-ID candidates for one original message. A global message ID alone does not identify a cloud item, and this page reader does not choose a winner or maintain a complete index across later pushes.

## Explicit account-state reads

`getCloudMediaUsage`, `getCloudMyDocumentsUsage`, `getCloudAccountInfo` and `getCloudMediaSettings` each take `(connection, viewer, { signal })` and make one request. They return `{ known, responseCode, raw }`. `known` is a frozen optional projection; `raw` retains the entire bounded, deeply frozen parsed object. An empty provider object is valid, with empty `known`. Missing or unsupported optional fields remain raw and have no manufactured projection, default, quota or eligibility meaning.

```ts
import { getCloudMediaUsage, getCloudMediaSettings } from 'zalo-personal-sdk';

const usage = await getCloudMediaUsage(connection, viewer, { signal });
const quota = usage.known.quota; // number | undefined; zero remains zero.
const settings = await getCloudMediaSettings(connection, viewer, { signal });
const optIn = settings.known.opt_in; // Exact qualified value, without a bit mask.
```

| Read | Optional `known` fields, using original provider names |
| --- | --- |
| Usage / My Documents usage | `quota`, `usage`, `plan`; `service_usage.cloud_media`, `message_backup`, `my_cloud` are direct scalar buckets. |
| Account info | `subscription_info.expire_time`, `subscription_time`, `subscription_gw`; `migrate_info.last_update`, `status`. |
| Settings | `opt_in`; own-present `enable_community` truthiness described below. |

Number fields project only from original JSON integer tokens representable as safe JavaScript integers. Signed values, negative sentinels, zero and unknown numeric enum/flag values are preserved. Numeric strings, unsafe integers, fractional or exponent syntax do not project, even if JSON number conversion would round them to an integer. Raw values remain available under the common lossless parser policy; large integer digit tokens stay text. The SDK uses original token provenance and does not infer it by stringifying a rounded number. These are deliberately stricter projection rules than the native client's arithmetic coercions; unsupported optional values do not reject a useful raw object. Existing raw validation still requires finite JavaScript numeric values; it is not arbitrary-precision decimal or exponent parsing.

An actual optional object may produce an empty frozen projected object when it has no qualified members. Missing, null, array or scalar containers do not create one. Service buckets are never defaulted or added together. The reader does not merge locally computed per-conversation/per-type/family totals, replace usage from another bucket, adjust quota, suppress free accounts, change local plan, recursively refetch, cache, start uploads or apply settings patches.

`opt_in` retains qualified values and unknown bits without JavaScript 32-bit truncation. It is not converted to a closed set of enabled flags. Own-present `enable_community` projects only its original JavaScript truthiness: null/false/zero/empty string are false, while `'0'`, objects and arrays are true. Absence stays absent. The examined native predicate treats a present falsey value as a disabled signal, together with separate account/conversation gates; this SDK projection does not establish overall community availability or a Boolean-only wire format. `raw.enable_community` retains the parsed value.

Subscription/migration fields retain their names and qualified values without Date conversion or inserted `-1`, gateway, status or package label. Active consumers compare them on their millisecond message-clock scale. A successful read does not establish universal timestamp ranges/units, entitlement, expiry, migration readiness or permission to change a subscription. The [family workflow](family-media.md) separately implements explicit family credential acquisition/restore/profile and cloud-credential family usage; these four account-state readers do not compose or cache it.

## Explicit resource ciphertext fetch

`fetchCloudResourceCiphertext(connection, viewer, resourceUrl, settings)` uses a live matching `CloudMediaViewer`; a family handle cannot authorize it. Settings are required and contain `allowedOrigins`, with optional `signal`, `maxBytes` and `timeoutMs`. It returns an independent mutable Buffer of opaque response bytes. A successful fetch does not establish encryption, message ownership, GCM authentication or CTR integrity.

```ts
import { fetchCloudResourceCiphertext } from 'zalo-personal-sdk';

// Select the transport URL, file capsule, algorithm and key from your reconciled records.
// Configure resource origins independently; do not derive them from the incoming URL.
const ciphertext = await fetchCloudResourceCiphertext(connection, viewer, resourceUrl, {
  allowedOrigins: configuredResourceOrigins,
  maxBytes: 1024 * 1024,
  timeoutMs: 30_000,
  signal,
});

// This is a separate local operation on your existing decoder or enrollment handle.
const opened = decoder.openResource(ciphertext, encryptedFileCapsuleBase64, algorithmVersion);
// Version '2' remains unauthenticated; fetching does not change that result.
```

Supply an already selected, capsule-free **transport URL**. The native client can append `?zcloudurl=true` before transport; this helper retains a caller-prepared flag exactly but does not add it, assemble a playback URL or promise that every raw locator returned by `getCloudDownloadUrls` is directly usable. There is no implicit locator lookup, record association, key acquisition/refresh, capsule extraction, decryption, checksum, file/cache write, HEAD, Range or retry. Queue action reconciliation, nonunique message-to-noise-ID selection and the URL/capsule/key association remain application responsibilities.

`allowedOrigins` is an independent list of 1–32 exact canonical HTTPS origins, optionally ending in one slash. It must not come from the selected URL or provider record. The resource origin must match exactly, even for a Zalo host; it need not be a bootstrap service origin. The URL is a nonempty well-formed UTF-8 string of at most 16 KiB, with an absolute HTTPS scheme, no whitespace/backslash/control characters, userinfo or fragment. Its path/query spelling, plus signs, duplicate fields and percent-case are dispatched unchanged. Known `pcloudsession` and `e2esession` query names are rejected before I/O, including case, percent-encoded and leading-`?` aliases. Query names are decoded once without plus-as-space; malformed or repeated-encoding names are unsupported. Values are not scanned or decoded, and unknown secrets under arbitrary names cannot be inferred. The SDK does not strip a capsule suffix to turn invalid input into a request.

The GET sends only the private viewer header and fixed identity-encoding header, without SDK account Cookie/Authorization, cloud ENK, account User-Agent, family credentials, JSON/form defaults, common query fields or a body. Resource Set-Cookie is ignored. It uses `credentials: 'omit'`, `redirect: 'error'`, no referrer and no cache. A trusted custom transport must honor those options; a lying adapter cannot be detected from an empty URL alone.

Response admission requires exact HTTP 200, `redirected === false`, no Location or Content-Range header, and absent or single `identity` Content-Encoding. A nonempty response URL must match the canonical requested URL; empty response URL remains supported for trusted custom adapters. Present Content-Length must contain 1–32 decimal digits, with leading zeroes allowed. Declared and actual bytes must match; the actual cumulative limit applies even when the header is absent. Both an empty stream and a null body with absent/zero length are valid. There is no text/envelope decoding, decompression or provider-code extraction from this body.

The effective byte ceiling is the minimum of the call's `maxBytes` (integer 0–16 MiB, default 16 MiB), 16 MiB and the connection's captured `maxResponseBytes`. Existing connection defaults of 2 MiB and maximum 8 MiB remain authoritative: a 16 MiB call option cannot raise that network ceiling. Zero accepts only empty data. The separate offline decoder accepts caller-supplied files up to 16 MiB. Optional `timeoutMs` is an integer 1–600,000 and can only lower the captured connection deadline, whose default is 60 seconds and maximum ten minutes. One deadline covers request, body, copying and cleanup; chunks do not reset it.

Caller cancellation, viewer disposal and connection closure cancel owned work. Binding is checked before handoff, during reads/copies and after reader cleanup before return. The implementation owns one reader, copies chunks before later reads, bounds scratch/output storage and contains cancellation/release faults; it does not wait indefinitely for a noncooperating cleanup promise. Monotonic elapsed checks and periodic cooperative yields bound supported immediately resolving streams. Arbitrary synchronous blocking in a trusted adapter cannot be preempted. Returned bytes belong to the caller and survive later disposal. These are per-call bounds, not a whole-process or parallel-request memory cap.

SDK 0.40 passed local synthetic transport/decoder tests and an actual local HTTPS/native-fetch check. No live provider resource request or native interoperability result is claimed.

## Results and failures

Queue/locator parameters and replies use AES-CBC/PKCS7 under the cloud ENK, with Base64 encoding of `IV16 || ciphertext`. Requests use a fresh IV. This differs from account-envelope zero-IV encryption and has no MAC/tag; it does not authenticate a media file or message.

The cloud metadata response requires HTTP 200 and original outer code numeric `0`/`-904` or exactly string `'0'`/`'-904'`. Code `-904` has no inferred partial-success, expiry or entitlement meaning. Decrypted JSON may contain one additional JSON-text layer. It has no inner account-envelope unwrap or inner error-code gate: top-level `download_urls` is the relevant locator map, queue fields are consumed directly, and account-state readers require an ordinary object with optional fields. Empty/missing useful data or a malformed required field is an error.

`downloadUrls` is a frozen own-property record containing only requested usable string locators. It has a null prototype, so inherited-name IDs are ordinary keys. Empty strings/null/false/zero map entries count as missing; requested truthy nonstrings, including unsafe numeric literals, are invalid. `missingNoiseIds` preserves requested order and duplicates. Raw bounded provider extras remain separately available as deeply frozen JSON; common parsing preserves unsafe integer tokens as strings without qualifying them as original string locators. Returned locators are not normalized or fetched, and no server URL expiry or client cache lifetime is inferred.

`CloudMediaError` contains a fixed code/stage (`credentials`, `queue`, `locators`, `account`, `resource` or `state`), `submitted`, `outcomeUnknown` and optional numeric HTTP status or genuinely decoded provider refusal code. It omits credentials, bodies, locators and arbitrary causes. `submitted` describes the current conservative handoff. A possibly sent credential GET without a qualified result/refusal has `outcomeUnknown:true`; the SDK does not replay it. Queue, locator, account-read and resource-fetch failures have `outcomeUnknown:false` and never refresh the credential. Resource failures use stage `resource`; their raw byte responses and adapter/public Error objects cannot establish a provider refusal code. Noncanonical status aliases such as `'-0904'` fail qualification rather than becoming accepted success. Errors `-1`/`-205` remain explicit refusals; caller policy must decide whether to acquire another credential.

## Evidence and remaining recovery work

The source is installed Desktop 26.11.10/build 26.11.10.3400, [identified here](desktop-evidence.md). Zero-based UTF-8 SHARED anchors are viewer acquisition 15,414,117; cloud cipher 3,184,793; cloud decoder 15,410,337; locator builder 15,414,769; active URL map consumer 14,315,591; service/fallback 14,701,325/14,706,564; credentialed XHR 12,406,879 and 13,426,715. VENDOR SHA-256 `8f1198b0a1e8314fb6a6c1eec2084b21320991b8e842dfcf353d412ab0687354` establishes the raw-key CryptoJS branch and its missing key-size guard.

Queue source anchors are builder 15,413,253–15,413,720, active result/cursor consumer 884,372–887,000 and explicit initial cursor 883,150–883,750 in SHARED. The local association chain starts at 56,480 and 18,551; key derivation is 11,604,245 onward. The packed schema member `default-login-render-shared-worker-znotification.ecf23a19a4646ced572a.js`, SHA-256 `697c9eb35caeaba46877013978446223db25909c6316337cd5f4c28d06243e8c`, declares unique noise IDs and nonunique message keys at 229,899–230,920. These are static source observations. Resource transport source is SHARED jqP8 at 13,676,913/13,678,887, secure-options separation at 9,955,777 and MAINPROC JLyq at 1,328,554; the SDK applies stricter explicit-origin/no-redirect policies.

Account-state source anchors are builders 15,413,707/15,413,885/15,416,914/15,417,262; server usage consumer 14,882,325–14,883,700; scalar buckets 1,822,700–1,823,390; subscription/migration getters 16,437,755–16,438,800; settings cache 13,735,400–13,736,115; community predicate 6,394,480–6,394,960. The native aggregate mixes server data with local database totals; the SDK keeps its four reads separate.

On 6 November 2026, one user-approved bounded check using immutable packaged SDK 0.28.0 succeeded with five GETs: two saved-Desktop-session bootstrap calls, explicit cloud viewer acquisition, one initial queue page and one selected locator lookup. It opened no listener or chat and did not fetch the locator. This is evidence for those tested 0.28 operations on that account at that time, not complete inventory/history, retention, media recovery or a common snapshot. The current owner refactor and the account-state/family APIs retain separate local-only validation. Credential expiry, issuance/rotation effects and broader provider availability remain unestablished. A read-shaped GET does not establish the absence of undocumented server effects. Queue records provide application-owned association inputs, but do not supply a complete reconciled index, unique message-to-noise-ID resolver or independently authenticated media/key association. The separate experimental [phone/PCloud coordinator](pcloud-phone-key.md) and [offline decoder](pcloud-resource.md) retain their own trust and native-interoperability limits. The 0.40 explicit resource fetch fills the bounded ciphertext-transport surface only, with local synthetic and loopback validation. Provider resource admission, caller-prepared native URL semantics, complete association, key rotation and large-file/cache handling remain unverified or separate work. Full expired-message voice recovery remains incomplete. [Transcription](voice-transcription.md), [existing media locators](attachment-renewal.md) and [operation status](operation-status.md) describe their separate boundaries.
