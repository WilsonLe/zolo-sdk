# Family viewer, profile and usage

The family profile uses a distinct family credential. Family usage uses the existing cloud credential. These are separate explicit reads: the SDK returns owned observations without joining members, choosing duplicate winners, adding zero usage, caching or changing family/subscription state. Provider availability, entitlement and credential lifetime remain unverified live.

| Operation | Required credential | Destination/header |
| --- | --- | --- |
| `acquireFamilyMediaViewer` | Approved Desktop connection | Saved auth origin, account cookies and normal account response decoder |
| `getFamilyMediaProfile` | `FamilyMediaViewer`, `kind: 'family'` | Owned `zfamily` base, `zfamily-viewer-key`, family ENK |
| `getCloudFamilyUsage` | `CloudMediaViewer`, `kind: 'cloud'` | Owned `zcloud` base, `cloud-viewer-key`, cloud ENK |

```ts
import {
  acquireFamilyMediaViewer, restoreFamilyMediaViewer,
  getFamilyMediaProfile, getCloudFamilyUsage,
} from 'zalo-personal-sdk';

// Explicit credential GET; issuance/rotation effects are not established.
const family = await acquireFamilyMediaViewer(connection, { signal });
try {
  await protectedCredentialStore.save(family.sealState(wrappingKey));
  const profile = await getFamilyMediaProfile(connection, family, { signal });
  // cloudViewer is a separately owned existing CloudMediaViewer.
  const usage = await getCloudFamilyUsage(connection, cloudViewer, { signal });
  // profile and usage are separate observations, not one transactional snapshot.
} finally {
  family.dispose();
}

// Local restore after reconnect to the same approved account, IMEI and auth origin.
const restored = restoreFamilyMediaViewer(newConnection, savedFamilyState, wrappingKey);
restored.dispose();
```

The application supplies a separate 32-byte local wrapping key and protected storage, keeping that key outside the encrypted checkpoint. The family getter does not acquire a cloud viewer or adopt an installed application's key store or a server-info credential seed. The [cloud guide](cloud-media.md) describes cloud credential acquisition and storage. None of these methods opens a listener or implicitly fetches another credential, retries, acknowledges an action, downloads an avatar or applies a native UI/cache update.

## Credential ownership and compatibility

Handles expose required readonly `kind`, metadata, `sealState` and `dispose`. Kind is nonenumerable and frozen. Cloud and family interfaces are disjoint, so passing the wrong real handle fails type checking. Runtime authority still requires the exact privately branded handle of the expected kind; a copied object, Proxy, forged kind or borrowed method cannot supply or dispose another kind's credential. The private domain/header/key selection does not trust the public kind string.

Both metadata shapes contain exactly `identityBinding`, `authOrigin` and `acquiredAtMilliseconds`. The time is local observation, not provider issuance/expiry. Cloud's existing `zalo-cloud-media-viewer.v1.` purpose/AAD, `ZCV1` binary layout and canonical metadata are unchanged. Authentic older cloud checkpoints restore as cloud handles with the new handle-level kind. Structural mock implementations now need a kind property for typing and remain invalid runtime capabilities; factory/restore users retain the supported path.

Family state uses its own `zalo-family-media-viewer.v1.` purpose/AAD and exact `ZFV1` magic. The encrypted binary contains canonical public metadata, opaque header bytes and raw AES key bytes under the same bounded authenticated-state rules as cloud. It has no JSON/Base64 private key field. Cloud state cannot restore as family or vice versa. A caller-held wrapping key authenticates caller-owned storage, not server validity or protection from rollback to an older authentic checkpoint.

Family and cloud buffers, brands and per-handle cancellation lifetimes are distinct. Disposing one kind leaves the other's operations and completed frozen results intact. Disposal aborts owned work and wipes owned byte buffers; it does not revoke server credentials or promise synchronous erasure of immutable strings/HTTP/runtime copies. Local sealing remains possible after the original connection closes. Remote work requires a live matching approved connection; restore is local and the next read uses the reconnect's owned service map.

Both explicit acquisitions share the SDK's per-connection mutation lock and process-local account acquisition lease. This conservative policy also excludes concurrent cloud/family acquisition through another SDK connection for the same account. It is not a provider requirement or a cross-process/official-app lock. Reads remain concurrent, with no acquisition or cache lease.

## Exact wire requests

Family acquisition uses GET `/api/getFamilyViewerKey` on the saved approved auth origin, normal destination-scoped account cookies and the nested account AES decoder. It reproduces the native empty-object GET punctuation: `...?zpw_ver=695&zpw_type=30?`. There is no params packet/body, IMEI, language, cloud/family header or role input. The reply must supply useful own `viewer_key` and `enk`, with at most one additional JSON-text layer. An empty native catch fallback is an SDK error. The header is opaque/header-valid, at most 16 KiB; the ENK follows the explicit standard-Base64 16/24/32-byte AES subset. Canonical padded and unpadded forms are supported; malformed alphabet, lengths or unused pad bits are rejected. No JWT or expiry schema is assumed.

Profile uses `/zfamily/pc/family-profile/v1/family`; usage uses `/cloudmedia/info/pc/v1/family-usage`. Each appends only ordered `zpw_ver` and `zpw_type`, without params, body, extra trailing question mark, family ID, user ID, role, force or plan. The first privately owned service entry is selected, preserving its path prefix; missing/empty services use only the installed `https://zfml.chat.zalo.me` and `https://zcld.chat.zalo.me` fallbacks respectively. First-entry selection is SDK policy; native domain state can rotate its selected entry.

Reads use the selected credential's separate IV-prefix AES-CBC/PKCS7 response decoder, full destination URL cookie scope and valid scoped Set-Cookie updates. Redirects/wrong response identities are rejected. Stable approved client/account/API binding, final handoff guards, intrinsic cancellation and header/body deadlines/byte limits remain active. There is no cloud-to-family key/header substitution.

Both require HTTP 200 and original outer numeric `0`/`-904` or exact strings `'0'`/`'-904'`. Code `-904` has no inferred entitlement/expiry meaning. One extra JSON-text layer is allowed; there is no inner account-envelope unwrap or inner error gate. Canonical genuine provider refusals stay explicit. Native key clearing, malformed-UTF8 retry, stale profile and failure-to-empty-array fallbacks are not performed.

## Profile observations

`getFamilyMediaProfile` returns `{ known, responseCode, raw }`, requiring a useful ordinary root object; `{}` is valid. Raw data is owned and deeply frozen under the existing depth-32/node-20,000/body bounds. `known` projects optional `manager_uid` and `members`, using original field names. Missing fields/containers remain absent, without roles, manager lookup, family IDs or default members.

An actual empty members array projects `known.members: []`. Its 1,000-row cap is checked before projection; over-cap is `response-limit`. If any member row is null, scalar, array or nonordinary object, the whole known.members projection is omitted while every raw slot/order/duplicate remains available. No row is filtered or replaced. When all rows are objects, there is one frozen projected object per row, including an empty object when no fields qualify.

Member projections contain optional `uid`, `status` and `profile.avatar`/`profile.username`. An actual profile object can project to `{}`; missing/null/array/scalar profile containers omit that projection. UIDs require original nonempty JSON strings of at most 256 UTF-8 bytes, without C0/DEL controls or malformed Unicode. Leading zeroes, `'0'`, case and opaque nondecimal content are preserved. Numeric UID tokens retained as text by the lossless raw parser cannot qualify as original strings. No self-zero normalization, identity joining or host/permission inference occurs.

Status accepts original strings up to 256 UTF-8 bytes, including empty; avatar/username accept original strings up to 16 KiB, including empty. All require well-formed Unicode without C0/DEL. Unsupported/oversized values stay raw and omit only the typed field. Unknown statuses remain available; `WAITING_ACCEPT` and `ACCEPTED` are observed examples, not an exhaustive enum or acceptance API. Avatars are not fetched or normalized, and names are not interpreted as markup.

## Usage observations

`getCloudFamilyUsage` returns `{ known, responseCode, raw }` with a required raw array. A qualified actual `[]` yields `known.rows: []`; an error, falsey/missing data or object root cannot manufacture it. The raw root array is capped at 1,000 rows before projection. Any nonordinary row omits the whole known.rows array while preserving all raw JSON slots. Otherwise one frozen `{uid?,usage?}` observation is returned per original row, retaining duplicates and order.

UID uses the original-string policy above. Usage projects only original JSON integer tokens representable as safe integers, preserving signed values and negative zero. Numeric strings, unsafe integers, fractions and exponents stay raw/unprojected under the [account-read numeric policy](cloud-media.md). Common lossless parsing preserves integer identifier/unsafe integer digit tokens as text, not arbitrary-precision decimal/exponent syntax; nonfinite JavaScript numbers are rejected. These projection/row bounds are SDK policies, not universal provider validation.

The SDK does not coerce numeric/string IDs into a common map key, choose a last duplicate, assign zero usage, sum a family total, exclude self, derive a manager or merge profile and usage. Two successful reads have no established common revision or transactional snapshot.

## Failures, evidence and remaining scope

All operations use `CloudMediaError` with existing stages: `credentials` for either acquisition, `state` for local handle/persistence operations and `account` for either family read. A possibly sent unqualified acquisition failure has `outcomeUnknown: true`; the SDK does not replay it. Read/local failures have false, with no claim that source inspection proves every undocumented GET effect absent. Error output keeps fixed codes/stages and safe genuine status/refusal metadata, without raw header/key/cookie/URL/body/cause.

Source is installed Desktop 26.11.10/build 26.11.10.3400, [identified here](desktop-evidence.md). SHARED zero-based UTF-8 anchors are builders 15,417,442–15,418,734; key/header selector 15,411,280–15,411,810; separate storage 8,169,376–8,170,367; bootstrap seed 6,824,410–6,824,743; active profile/usage controller 1,252,364–1,253,596; strict UID lookups 1,253,851–1,254,912; optional profile/status UI 5,423,300–5,424,116. These are static observations. Independent synthetic fixtures and local package consumers remain distinct from live acceptance.

Family enrollment, invitation, acceptance, member removal/leave/manager change and subscription management are not established by these reads. A neighboring development/debug cancellation GET is not included as a production family action. Native UI status and local plan gates do not authorize such operations. Full family administration, live entitlement/credential behavior, complete cloud/media recovery and full client parity remain separate work in the [operation-status map](operation-status.md).
