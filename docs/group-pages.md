# Experimental group pages

These three source-derived reads use an existing authenticated API. Each returns one provider response. Live provider acceptance remains unverified. The member-page route is a legacy path, and native encrypted-ID synchronization is feature-gated.

```ts
import {
  getGroupListPage, getGroupMemberPage, getEncryptedGroupIds,
} from 'zalo-personal-sdk';

const page = await getGroupListPage(api, { page: 1, count: 100, signal });
const members = await getGroupMemberPage(api, 'g123', { page: 1, signal });
const encrypted = await getEncryptedGroupIds(api, signal);
```

| Function | Response |
| --- | --- |
| `getGroupListPage` | `groups` in provider order and a shallow `raw` page record. |
| `getGroupMemberPage` | A shallow `raw` group record, with optional `currentMems`, `admins` and `memberIds` array observations. |
| `getEncryptedGroupIds` | An ordered `raw` array and one `entries` wrapper for every original slot, with an optional primitive `id` observation. |

The functions issue at most one GET apiece. The application controls subsequent page requests and reconciliation. They perform no automatic retry, pagination, profile/avatar enrichment, membership update or E2EE-store import.

## Select a page

Both page functions accept `page`, `count` and `signal`. Page defaults to 1 and count to 100. Page must be a positive safe integer; count must be an integer from 1 through 1,000. These are SDK input rules and do not establish provider limits or availability. Invalid values are rejected before I/O, without coercion or clamping.

The member function accepts a positive decimal group ID of up to 40 digits, optionally prefixed with one `g`. It removes that prefix for the request. Leading zeroes, whitespace, Number/BigInt input and other spellings are rejected. Supply ordinary options with own data properties; unsupported properties, accessors and Proxy options are rejected.

List-page `hasMore`, `total` and `suggestGroup` remain raw provider fields. Member-page `hasMoreMember` also remains raw: traced native consumers use different continuation rules. The SDK adds no Boolean default, total, cursor or universal next-page predicate.

## Read raw observations

An actual empty list page has `groups:[]`. Missing or malformed required groups are an error. Every group row is preserved, including duplicates and unsupported values; rows are not promoted into a complete group model.

A member response may contain only group metadata. Missing or unsupported member collections omit their convenience projection while preserving the original own field and value in `raw`. Real empty arrays produce present empty projections. Admins, members and member IDs remain separate ordered observations, without merging or inferred roles. A missing identity or collection does not establish removal, nonmembership or an empty complete roster.

Encrypted-ID results preserve every raw slot and duplicate. A nonempty well-formed string of at most 256 UTF-8 bytes receives an unchanged `id`; a safe integer Number receives its string spelling. Other slots retain `raw` and omit `id`. No prefix, normalization, eligibility or trust decision is added. A returned ID does not establish an encrypted session, key availability or a trusted recipient. Unsafe integer JSON tokens preserved by the shared reader remain exact text.

Returned outer records, copied arrays and entry wrappers are frozen. Raw nested values remain shared and unfrozen. Qualified collection projections use the same owned array as their corresponding `raw` field. The SDK does not mutate or freeze the provider's source objects or recursively inspect opaque nested values.

Local projection rules permit at most 20,000 root properties, 256 UTF-8 bytes per root key and 20,000 slots per selected collection. Qualified arrays must be dense ordinary arrays without extra named properties or accessors. These are local projection limits; the shared HTTP reader still consumes the full response before projection. They do not bound the whole raw graph or HTTP body size.

## Errors and cancellation

Invalid options, group grammar or signal produce a fixed `TypeError`; invalid page/count produce a fixed `RangeError`. Request failures use the existing `ZaloProtocolError` contract: `unsupported-service`, `request-failed`, `invalid-response` or `aborted`, with existing safe status/provider-code handling. Malformed successful results and projection-cap failures are `invalid-response`, rather than successful empty pages.

A genuine already-aborted signal prevents dispatch. Each call releases its signal subscription on settlement. Cancellation follows the existing transport and response reader; a custom adapter that ignores its signal has no new forced-settlement or universal-timeout guarantee. Errors expose no raw response or original cause from these local validators.

## Wire and availability

| Read | Group-service GET | Account-encrypted fields |
| --- | --- | --- |
| List page | `/api/group/getlg/v3` | `page`, `count`, fixed avatar sizes 160 and account `imei`. |
| Member page | `/api/group/getgi/v2` | `grid`, fixed avatar sizes 160, `mpage`, `mcount` and account `imei`. |
| Encrypted IDs | `/api/group/getlg/e2ee` | No `params` field; normal common query only. |

All three use ordinary account encryption/cookies, strict HTTP 200 and disabled redirects. Cookie matching uses the full destination URL and its path. [Cookie scope](cookie-scope.md). They preserve the advertised group-service base path and have no alternate-service fallback. They add no language, native command number, request ID, peer/device selector or cloud credential. Existing transport cookie handling remains in effect.

Installed Desktop 26.11.10 has a compiled UI/cache-miss path for V3 list pages. Its old full-list startup loop is gated off by shipped configuration. Both traced V2 member consumers are legacy/default-gated. Encrypted-ID synchronization is also feature/default-gated. Those shipped flags do not prove effective account flags or current server acceptance; these functions do not read or change private app configuration.

Existing `api.getAllGroups()` reads the V4 revision list through `group_poll`; `api.getGroupInfo()` reads a batch metadata map; `api.getGroupMembersInfo()` resolves caller-supplied user profiles; `getGroupContexts()` reads purpose/role records. Their contracts remain separate. These page observations do not establish complete group coverage, membership freshness or live client parity.
