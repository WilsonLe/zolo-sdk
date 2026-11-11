# Group conversation contexts

`getGroupContexts(api, groupIds, signal?)` reads purpose and role metadata for explicitly selected groups. It complements `getFriendContexts`; the existing upstream `api.getGroupInfo()` uses a different group-information route.

```ts
import { getGroupContexts } from 'zalo-personal-sdk';

const contexts = await getGroupContexts(api, applicationSelectedGroupIds, signal);
for (const [groupId, context] of Object.entries(contexts)) {
  await saveApplicationGroupContext(groupId, context);
}
```

The example's selection and storage belong to the application. Each call submits once. There is no automatic paging, batching, polling, local cache update, task-feature gate or classification.

## Input and result

Supply one to 100 distinct positive decimal group ID strings, each up to 40 digits. A single optional leading lowercase `g` is removed before submission: `g123` and `123` identify the same group and are rejected as duplicate inputs in one call. Leading zeros, numeric JavaScript values and other prefixes are rejected. Decimal strings preserve large IDs without floating-point conversion. The 100-ID request bound is an SDK limit, not an established provider maximum.

The result is `Record<string, GroupContext>` keyed by unprefixed decimal group ID. Each context retains its raw provider fields and may contain:

```ts
interface GroupContext extends Record<string, unknown> {
  purpose?: string;
  role?: string[];
}
```

The installed consumer recognizes `purpose` values `none`, `family`, `friend`, `work`, and first-role values `none`, `boss`. The helper preserves other strings, empty strings and empty role arrays. It does not infer work/family classifications or assign a role. Present `purpose` and `role` fields must have those types; explicit `null` is not an omitted field.

Missing requested entries remain absent, including an empty result map. They do not prove that a group was deleted or has no context. Provider entries beyond the requested set are preserved. No timestamp or placeholder is manufactured; a provider-supplied `ts` or other unknown field remains intact. Treat these decoded records as private account data.

Additional SDK response bounds are 20,000 map entries and 100 role strings per context. Returned map keys must be positive decimal strings up to 40 digits. Invalid inputs fail before I/O. Malformed responses and transport failures use sanitized `ZaloProtocolError` messages; explicit provider refusal retains its numeric `providerCode`. Cancellation uses `code: 'aborted'`, and a session without an advertised group service uses `code: 'unsupported-service'`. The helper never retries a failure and rejects redirects.

## Exact wire and evidence

The request uses the authenticated session's advertised `group` service:

```text
POST /api/group/userctx/multiget?zpw_ver=…&zpw_type=…
Content-Type: application/x-www-form-urlencoded
params = account-AES-CBC(JSON.stringify({ grids: normalizedGroupIds, imei }))
```

The shared protocol transport decodes the standard nested account-AES response. This account transport encryption is separate from the SDK's message E2EE primitives.

Evidence is the installed 26.11.10 SHARED member `pc-dist/lazy/default-login-main-startup-shared-worker-znotification.4bb5e1e2c2e9bab4f7b3.js`, extracted as `desktop-shared.js`, SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`, length 17,605,735 bytes. Anchors below are zero-based UTF-8 bytes. [Artifact identity](desktop-evidence.md)

| Anchor | Contract |
| --- | --- |
| `2684172` | Command 12607 maps to the group service and `/api/group/userctx/multiget`. |
| `12418674`–`12418923` | `getExtraGroupInfo` builds `{grids,imei}`, encrypts JSON into the POST form and appends common query parameters. |
| `12105249`–`12105800` | Public wrapper strips group prefixes, looks up the decoded map under unprefixed IDs, then manufactures prefixed local cache entries/timestamps and swallows failures. Those local transformations are excluded here. |
| `4240221`–`4240766` | Consumer reads optional purpose and role fields and applies its own classification. |
| `4240767`–`4241547`, `4248020` | Installed task-feature/timing gates and roughly 50-group scheduling belong to the native consumer. They are not API access checks or proven server batch maxima. |
| `4596158`, `4599157` | Conversation preview/new-message processing reaches the purpose-check path. |

Focused fixtures independently decrypt synthetic requests and encrypt synthetic provider responses. They cover the exact service/method/path/common query/IMEI, optional prefix normalization, duplicate and invalid input rejection, large IDs, missing/empty maps, unknown fields and future strings, malformed records, SDK limits, provider refusal, cancellation, absent service, and single-submission transport errors. The initial implementation used no live group-context request or account entitlement observation.

The 6 November 2026 saved-Web-session check stopped before this endpoint was reached. Login/configuration returned HTTP 200 and outer provider zero, but a separate decrypted-login diagnostic found provider code 102 and no account data. A bounded resume retry had also failed. Those Web checks did not initiate a QR or group/account mutation. After the user's fresh ordinary Desktop QR sign-in, one explicitly selected existing group's context read returned one map entry under the requested ID. No group context values, IDs or mutations were printed/submitted.
