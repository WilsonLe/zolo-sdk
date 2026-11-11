# Profile rank and stranger-warning metadata

`getProfileRank(api, targetUserId, signal?)` explicitly reads another user's provider rank and optional stranger-warning rendering metadata. It uses the advertised `profile` service, the account's IMEI, and the normal encrypted account-response decoder. It makes one request, rejects redirects, and does not retry.

```ts
import { getProfileRank } from 'zalo-personal-sdk';

const result = await getProfileRank(api, applicationSelectedUserId, signal);
// result.rank_type is a provider classification. Applications choose how to use it.
// result.data_render is opaque; result.raw retains the complete provider record.
```

The target must be a positive decimal string of at most 40 digits identifying another user. Zero, the authenticated own UID, group IDs, and malformed IDs reject before I/O, following the installed higher-level profile helper's target policy. The low-level HTTP builder itself does not enforce this policy. The 40-digit bound is an SDK limit, not a measured server maximum. Feature availability and authorization remain provider decisions.

The result is:

| Member | Meaning |
| --- | --- |
| `rank_type` | A nonempty modern `rank_type` string, otherwise a nonempty legacy `userRank` string. Modern values take precedence. Strings are not trimmed, uppercased, or restricted to the currently observed enum. |
| `data_render` | Present exactly when the decoded provider record contains this member. Its value is opaque, including null, empty objects, arrays, and future layouts. |
| `raw` | The full decoded provider object, retaining original `rank_type`, `userRank`, rendering fields, and unknown extensions. Large JSON integer tokens are preserved without precision loss. |

The currently shipped rank names are `WHITE`, `GRAY`, `BLACK`, and `UNKNOWN`. Unknown future strings are returned unchanged. These labels are the provider's classification, not an independent identity or trust assessment.

An object and an object encoded in one additional JSON-text layer are accepted. A null/empty result, absent or empty rank without a usable legacy string, malformed JSON, a second text layer, or a non-object result rejects with `ZaloProtocolError` code `invalid-response`. A non-string rank is not exposed as a typed rank; a valid legacy string can still supply the rank when the modern member is unusable. The original provider fields remain in `raw`.

This is a metadata reader rather than the installed banner renderer. The shipped modern renderer checks `bg_color`, `buttons`, `menu`, `showAcceptFriend`, and nested button/menu properties, including truthiness checks that reject some otherwise well-typed values. This helper does not apply those UI checks or promise that opaque rendering data is safe or suitable to display. It accepts a usable modern rank even when rendering metadata is absent or incomplete. Applications should choose their own rendering and validate any fields they consume.

For successful legacy records without rendering data, the installed conversation UI selects local gray/black/white resources; its default branch also handles unknown rank names. The SDK does not turn an unknown, empty, failed, or missing response into `WHITE`, manufacture a banner, or infer a backend fallback value. It also does not perform add-friend, accept, block, report, or trust actions; download assets; maintain a profile cache; or add local `fetched`/`ts` fields. Any provider members with those names remain ordinary raw provider data.

The exact wire request is GET `/api/social/profile/getrank` with normal common client query parameters and account-AES query `params` containing only `{profile_id:targetUserId,imei}`. No language or other target field is added. Provider rejection keeps a safe numeric `ZaloProtocolError.providerCode`; response and transport errors omit raw provider data and original exceptions. Cancellation is forwarded to the shared request transport.

Evidence is installed Zalo Desktop 26.11.10 build 26.11.10.3400, checked through the existing exact packed-byte fallback. The installed ASAR SHA-256 was revalidated as `9217d0e419c4f2b89033cf23e89073de0052d7417e6e16270afc2d68e31896d2`. The source members were also rehashed before this implementation:

| Source | SHA-256 |
| --- | --- |
| SHARED `default-login-main-startup-shared-worker-znotification.4bb5e1e2c2e9bab4f7b3.js` | `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` |
| MAIN `main-startup.89bb530b91927fd5dd28.js` | `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121` |

Offsets are zero-based UTF-8 bytes:

| Source bytes | Evidence |
| --- | --- |
| SHARED `12524601`–`12525000` | Profile-domain GET builder, account-AES `{profile_id,imei}`, command 12012. |
| SHARED `12119217`, `13736118` | Rank wrapper and standard nested account-AES response decoder. |
| SHARED `13941166`–`13942970` | Higher-level target restrictions, one extra JSON-text layer, modern/legacy rank selection, renderer validation, and cache-only `fetched`. No usable data rejects `invalid_data`. |
| SHARED `1557968`, `15059452`–`15061000` | Current rank enum and locally supplied banner resources. |
| MAIN `1194474` | Conversation banner consumes provider `data_render`, otherwise selects local resources by `rank_type`/`userRank`. |
| MAIN `1709115` | Profile loading reads rank and preserves existing cached profile rank on failure. |

`test/profile-rank.test.mjs` independently decrypts synthetic requests and supplies synthetic encrypted responses. It covers exact route/fields/common query, first advertised service, modern and legacy selection, one text layer, large-integer preservation, unknown rank strings, opaque/missing/null rendering, malformed core data, own/group/zero target rejection, cancellation, and sanitized provider/transport/service failures. The initial implementation used no live rank read or profile action. Static reachability establishes a shipped consumer, not live entitlement or response availability for any account.

On 6 November 2026, an attempted saved-Web-session read check stopped during account bootstrap before this endpoint was reached. A bounded retry and a separate status-only diagnostic found HTTP 200 and outer provider zero for both login/configuration requests, but the decrypted login result contained provider code 102 and no account data. This does not establish profile-rank endpoint acceptance or a meaning for code 102 beyond that observed refusal. After the user's fresh ordinary Desktop QR sign-in, a separate saved-Desktop-session read accepted another existing friend's rank metadata with one raw field and no rendering field. Its classification value and target ID were not printed. Profile actions were not submitted.
