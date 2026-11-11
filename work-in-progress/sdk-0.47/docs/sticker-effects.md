# Fullscreen sticker effect metadata

`getStickerEffect(api, effectId, signal?)` explicitly reads one fullscreen sticker effect's metadata. The ID comes from a sticker's `effectId` metadata; it is separate from the sticker/category IDs.

```ts
import { getStickerEffect } from 'zalo-personal-sdk';

const effect = await getStickerEffect(api, '9340000000000003101', signal);
if (effect.selection.status === 'attachment') {
  const locator = effect.selection.attachment;
  // The application separately decides whether and how to trust, fetch or render it.
}
```

Each call performs one authenticated `sticker`-service GET to `/api/message/effects`, installed command **11742**. Its account-AES query plaintext is exactly `{"effect_ids":[TOKEN]}`: a single **bare integer token**, never a quoted ID string or an arbitrary JSON fragment. Common outer client type/version query fields remain present; no IMEI or language is injected. It checks the normal outer/inner response envelopes, rejects redirects and makes no automatic retries.

Numbers must be safe integers; `String(number)` supplies their token text, including numeric `-0` becoming `0`. Strings preserve their exact signed JSON-integer token spelling, with one optional minus, a zero or a nonzero-leading digit sequence, and at most 40 digits. Thus string `'-0'` remains `'-0'` and selects that exact returned map key. Plus signs, leading zeroes such as `'01'`, whitespace, fractions, exponents, fragments and already-rounded unsafe numbers are rejected before I/O. Zero and negative tokens are accepted without assigning them provider meaning. This is the SDK's bounded serialization domain, not a measured provider ID range or maximum.

The result is `{effectId, selection, raw}`. `effectId` is the submitted token text. `raw` preserves the complete decoded provider map, including unrequested keys and unknown values. There is no extra JSON-string decoding layer. An empty map `{}` is valid. Only own map keys and own record fields are used for selection, including when application object prototypes contain unrelated properties.

| Selection status | Mechanical interpretation |
| --- | --- |
| `attachment` | The selected record has a nonempty, well-formed string `attachment` within the SDK byte bound. Its locator and complete raw record are returned unchanged. |
| `type-8` | The selected object has its own **numeric** `type:8`. The complete raw record is retained. String `'8'`, absent/null types and other values do not trigger this exclusion. |
| `missing` | The provider map has no own key matching the exact token text. The selection has no `raw` property. |
| `null` | The matching map value is explicitly null, retained as `raw:null`. |
| `unsupported` | Any other present value or unsupported attachment field, retained in `raw`. This includes false/zero/empty records, arrays, missing/null/falsy/non-string locators, over-budget text and unpaired UTF-16 surrogates. |

These statuses are SDK interpretation, not provider business states or proof of deletion, eligibility, asset availability or successful rendering. The installed consumer collapses missing/invalid/excluded results into one error; this helper makes those observations explicit. Numeric type 8 takes precedence over locator validation, so even `{type:8}` reports `type-8`. This precedence is an SDK choice for reporting the known field, not an additional provider response rule.

Locator text is not trimmed, normalized, URI-decoded, scheme-checked or trusted. Whitespace, relative text, HTTP or custom-scheme strings can therefore be returned as metadata. The caller must apply its own policy before using it. The helper never follows the locator, sends credentials to it, reads a ZIP, creates a cache, runs scripts, starts a renderer or sends a sticker. A metadata lookup is not a completed fullscreen effect player.

The SDK allows at most 20,000 returned map entries and recognizes at most 65,536 UTF-8 bytes per attachment locator. Oversized or malformed top-level maps fail with `ZaloProtocolError('invalid-response')`; unsupported selected field values remain present in the raw map. These are local resource bounds, not server limits. Output containers are shallowly frozen; opaque nested raw values keep their decoded structure. Provider/HTTP errors use fixed `ZaloProtocolError` messages and safe numeric codes. Cancellation forwards to the one explicit account request. No response body, account value or locator is placed in ordinary errors.

## Source and verification

Revalidated installed Desktop **26.11.10**, build **26.11.10.3400**, SHARED SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` and MAIN startup SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. Zero-based UTF-8 byte anchors:

| Bytes in SHARED | Contract |
| --- | --- |
| **12,425,186–12,425,413** | Exact sticker-domain GET builder, single bare `effect_ids` token array, account AES and command 11742. |
| **12,102,818** | Wrapper returns the normal `kCOK`-decoded result. |
| **7,296,886–7,297,200** | Requested map-key lookup, truthy attachment and strict `type !== 8` predicate. No attachment type or URL policy is established there. |
| **2,720,299; 10,186,374** | Current sticker click obtains cached `effectId` from sticker/category metadata and dispatches the fullscreen popup. Numeric zero is dropped by truthiness here, while truthy strings/negatives are not type/range-checked. |
| **14,656,963; 14,658,250–14,659,200** | Fullscreen popup state invokes `setupShowing(effectId)` and Cocos `loadInfo`. |
| **7,296,300–7,300,460** | Separate native attachment fetch, ZIP/blob metadata and renderer workflow; not reproduced by this metadata helper. |
| **13,736,118** | Normal account-AES response-envelope decoder. |

This is distinct from `/api/message/effect/get`'s sprite metadata and fixed `size:130`, whose current caller remains unestablished in the inspected chunks. It is also separate from keyword suggestions, catalog category/CDN resolution and the account AI-sticker list. [Artifact identity](desktop-evidence.md)

The existing integrity-checked packed-source fallback was reused without an application run or REA setup retry. Focused fixtures independently decrypt request plaintext and generate encrypted responses. They cover exact large/signed/zero tokens, strict type-8 behavior, missing/null/falsy/unknown fields, raw map extras and own keys, locator/resource boundaries, malformed inputs before I/O, provider/HTTP errors and cancellation. No live account request, attachment download, rendering or sticker send was performed for this implementation.
