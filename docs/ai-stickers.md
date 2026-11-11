# Account AI-sticker list

`getAiStickerList(api, signal?)` explicitly reads the authenticated account's AI-sticker list. This is an availability-dependent provider operation. It does not require or claim a working Desktop AI-sticker tab.

```ts
import { getAiStickerList } from 'zalo-personal-sdk';

const list = await getAiStickerList(api, signal);
for (const entry of list.entries) {
  if (entry.known) {
    // Known provider fields only. The application owns any later rendering policy.
    showApplicationAiSticker(entry.known);
  } else {
    retainApplicationUnknownRow(entry.raw);
  }
}
```

The application supplies its own rendering/retention functions. Each call makes one authenticated `sticker`-service **GET** to `/api/message/sticker/ai/list`, installed command **12190**, with account-AES query plaintext exactly `{imei: sessionDeviceId}`. The common outer client type/version query is present. No language, page, keyword, limit or list-version field is added. The helper checks the normal outer/inner response envelopes, rejects redirects and performs no automatic retries.

The result is `{raw, entries}`. `raw` is the complete decoded provider object, preserving `version`, `expired_time` and all other fields without defaults, coercion or aliases. Their types, units, cache expiry rules and revision ordering are not inferred. The response must contain its own array-valued `stickers` field, matching the installed mapper's direct `.map` call. Missing, null or non-array collections are invalid responses. A true `stickers:[]` is a valid empty list and returns `entries:[]`.

Every provider row appears in `entries` in its original order, including null, primitive, incomplete or future rows. Each entry keeps its complete `raw` value. A conservative optional `known` projection contains only these established provider fields:

| Field | SDK projection |
| --- | --- |
| `id`, `cateid_root` | Safe integer numbers or exact signed JSON-integer-token strings of up to 40 digits, retained in their original type/text. Zero and negative values are not given provider meaning. |
| `url` | Nonempty, well-formed string of at most 65,536 UTF-8 bytes, retained unchanged. |
| `width`, `height` | Finite numbers, without a positive/integer requirement or unit conversion. |

All five must be own properties for `known` to be present. Unsupported values omit `known` while retaining the full row. The shared lossless JSON parser preserves unsafe integer tokens as exact strings; the helper never rounds them or coerces arbitrary objects. Already-rounded unsafe numeric values, fractional IDs, leading-zero/plus/exponent ID strings and unsupported URL/dimension shapes remain raw. This is an SDK projection, not proof that the native constructor or provider rejects every other numeric form. The native constructor only checks number type/non-NaN for IDs and dimensions and a truthy URL.

URL text receives no trust decision, scheme conversion, URI decoding or trimming. Whitespace, relative, HTTP and custom-scheme strings can be returned as metadata; the application must apply its own policy before using them. Private generated media URLs are returned only in the explicit result, never logged or placed in ordinary errors. The helper does not download assets, visit a mini-app, generate art, classify a user, create a cache, update personal category order or send a photo/sticker. AI-sticker sending uses a separate photo representation in the installed client and is not implied by this list read.

SDK resource limits are 10,000 rows, 20,000 root fields, 40 digits for projected ID strings and 65,536 UTF-8 bytes for projected URLs. The row count is checked before indexed projection. These are local bounds, not provider capacity or eligibility claims; the compiled `limit:40` configuration is not sent as a request limit. Output containers and known projections are shallowly frozen; opaque nested raw values retain their decoded structure. `ZaloProtocolError` supplies fixed messages and safe provider/HTTP codes for invalid responses and failures. Cancellation propagates to the one explicit account request, and no fallback route or automatic retry is used.

## Source, availability and verification

Revalidated installed Desktop **26.11.10**, build **26.11.10.3400**, MAIN startup SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121` and SHARED SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. Offsets are zero-based UTF-8.

| Source bytes | Established contract |
| --- | --- |
| MAIN **1,760,483–1,760,990** | Exact GET/IMEI request, sticker domain, command 12190 and account decoder. Decoder import `od = kCOK` is at **293,327**. |
| MAIN **1,765,524** | Complete tuple consumer: `expired_time`, `version`, and ordered rows `{id,url,width,height,cateid_root}`. It renames the category field for its own domain model. |
| MAIN **1,759,325; 1,759,887** | Native constructor's number/non-NaN and truthy-URL checks; separate UI mapper adds type/thumb/rendered defaults that this SDK does not manufacture. |
| MAIN **1,769,696** | Native cache/version update and expiry retention, separate from this explicit read. |
| MAIN **1,776,529**; SHARED **14,297,491** | Authenticated manager and picker consume the list behind `AIStickerTab`. |
| SHARED **13,833,500–13,834,500** | AI config default `enable:1`, tab bit 2 test and `enable` validator `oneOf([0,1])`. |
| SHARED **6,852,842; 4,454,183; 4,776,210** | Server config applies that validator; strict `includes` and invalid-field fallback confirm the gate conflict. |
| SHARED **12,404,373; 13,736,118** | JSON/account-AES parameter and ordinary response-envelope helpers. |

The normal inspected configuration path does not establish how bit 2 can enable the tab: values 2/3 would fail the shown validator and fall back to 1. That limits UI reachability claims, while the complete builder and typed consumer still establish this explicit provider read. Actual provider availability, entitlement and populated responses remain unverified. No generation or mini-app workflow is inferred from the route name or compiled promotion text.

The existing integrity-checked packed-source fallback was reused, without application execution or a REA setup retry. Focused encrypted fixtures independently inspect the exact GET/IMEI plaintext and exercise metadata/row preservation, lossless large tokens, conservative projection, true empty versus malformed collections, resource limits, error privacy, service absence and cancellation. No live account read, asset fetch, generation or account mutation was performed for this implementation. [Artifact identity](desktop-evidence.md)
