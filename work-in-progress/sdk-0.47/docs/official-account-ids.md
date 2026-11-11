# Official Account URI-ID conversion

`convertOfficialAccountIds(api, externalIds, signal?)` converts an explicit batch of external Official Account references. The external text stays unchanged: there is no decimal-only restriction, prefix removal, trimming, Unicode normalization or URI decoding. Input IDs must be distinct by exact string equality.

```ts
import { convertOfficialAccountIds, resolveOfficialAccountUriId } from 'zalo-personal-sdk';

const batch = await convertOfficialAccountIds(api, ['external-oa-reference'], signal);
const converted = await resolveOfficialAccountUriId(api, 'oexternal-oa-reference', signal);
const first = converted.results[0];
if (first.status === 'mapped') {
  // An opaque provider conversation reference; the application decides how to use it.
  console.log(first.conversationId);
}
```

`resolveOfficialAccountUriId` accepts the conversation-ID component with its installed lowercase `o` prefix. It strips exactly one `o` and returns the same batch result shape for that single suffix. It accepts no full `zalo://` URI. For example, `ooexternal%2F` submits `oexternal%2F` unchanged. Calling either helper makes one conversion request, without opening a conversation, fetching a profile, downloading assets or updating a cache.

The result contains ordered `results` plus the complete decoded provider `raw` map, including unrequested keys and unknown values. A `mapped` entry has the requested `officialAccountId`, an opaque `conversationId` and its original `raw` value. Nonempty, well-formed text remains unchanged; positive safe integer values become decimal strings. The shared lossless JSON parser preserves large integer tokens as exact strings before this conversion. No returned reference is classified or validated as a friend/group ID.

An `unresolved` entry has one of four SDK interpretation reasons:

| Reason | Provider map state |
| --- | --- |
| `missing` | No own property for the requested text; this entry has no `raw` property. |
| `null` | The own value is `null`, retained in `raw`. |
| `empty` | The own value is the empty string, retained in `raw`. |
| `unsupported` | Any other value, including booleans, nonpositive/unsafe numbers, objects, arrays or unsupported text; retained in `raw`. |

These statuses do not establish deletion, account eligibility, a provider lookup failure or any other business state. Own-property lookups preserve opaque keys such as `__proto__` and `constructor` without treating inherited properties as results. The output containers and entries are shallowly frozen; opaque nested values in the raw map retain their decoded structure.

The helpers apply SDK resource limits of 1–100 IDs, 4,096 UTF-8 bytes per requested or recognized target text, and 20,000 returned map entries. Input strings with unpaired UTF-16 surrogates are rejected to prevent lossy UTF-8 encoding. Distinct whitespace and Unicode spellings remain distinct. These limits are local bounds, not provider batch-capacity or ID-format claims; the inspected active consumer requests one ID at a time. An empty object map `{}` is valid and yields `missing` for every requested ID. Empty transport bodies, invalid envelopes and non-object maps fail with `ZaloProtocolError('invalid-response')`; no extra JSON-string layer is inferred.

The request is an account-AES **GET** to the `profile` service at `/api/social/oa/convertid`, installed command **11863**. The encrypted object is exactly `{oa_ids: externalIds}` plus the common outer type/version query. No IMEI or language is injected. Normal outer/inner acknowledgements and HTTP errors use the shared protocol transport. The helpers submit once, reject redirects and preserve fixed error messages with safe provider/status codes. Cancellation propagates to the explicit request; no retry or alternate-route fallback occurs. This is separate from OA blocking and from upstream friend-ID operations.

## Source and verification

Revalidated installed Desktop **26.11.10**, build **26.11.10.3400**, SHARED SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. Byte anchors are zero-based UTF-8: prefix export **1,507,751** and value `He="o"` **1,530,580**; current `parseUriConversationId` **6,453,700** strips one prefix, requests `[suffix]` and reads `map[suffix]`; `openConversation` **6,454,600** stops on a falsy conversion before its separate conversation/profile lookups; URI regex **6,985,267** captures the ID component with `(.+)`, providing no decimal-only restriction; API wrapper **12,106,657** delegates through `kCOK`; builder **12,489,527** selects the profile domain, exact fields, GET and command; normal account decoder **13,736,118** unwraps the encrypted inner `data`. [Artifact identity](desktop-evidence.md)

The source proves an ID-to-reference map lookup, without a broader schema for nullable or future values. The SDK therefore retains unknown values and makes unresolved interpretation explicit. The previously established integrity-checked packed-byte fallback was used; no REA setup retry or application execution occurred. Focused fixtures inspect independently decrypted request fields and encrypted provider replies, opaque/Unicode IDs, one-prefix behavior, exact large integer tokens, missing/null/empty/unknown values, prototype-like keys, SDK bounds, errors and cancellation. No live conversion, account read or account mutation was performed for this implementation.
