# Sticker discovery and personal categories

The main SDK entry point provides six explicit operations:

| Helper | Purpose |
| --- | --- |
| `getStickerKeywords(api, signal?)` | Read the suggestion keyword dictionary and `word_search` maximum word count. |
| `getStickerSuggestions(api, keyword, options?)` | Fetch the complete mixed sticker, GIF, and Guggy suggestion result. |
| `getTenorStickerMapping(api, signal?)` | Read Tenor-to-Zalo sticker/category mappings. |
| `getPersonalizedStickerCategories(api, signal?)` | Read the account's ordered category list and provider revision. |
| `replacePersonalizedStickerCategories(api, input)` | Explicitly replace that complete ordered list once. |
| `getGreetingStickerSuggestions(api, signal?)` | Read and decode the greeting sticker dataset. |

```ts
const suggestions = await getStickerSuggestions(api, 'xin chào');
for (const item of suggestions.sugg_sticker ?? []) {
  console.log(item.cate_id, item.sticker_id);
}

const current = await getPersonalizedStickerCategories(api);
if (current.version === undefined || current.version === null) {
  throw new Error('The provider supplied no sticker revision.');
}
// applicationCategoryOrder is the complete desired list, not a patch.
const updated = await replacePersonalizedStickerCategories(api, {
  version: current.version,
  categoryIds: applicationCategoryOrder,
});
const nextVersion = updated.data.version;
```

Results keep the installed provider field names and unknown fields. Safe numeric IDs retain their numeric type; decimal-string IDs and revisions retain their exact text. Large JSON integer values are preserved as strings by the shared response parser. The SDK validates known fields but does not invent complete GIF/Guggy asset schemas, fetch their URLs, populate local sticker databases, or send a sticker.

## Suggestion and mapping results

The keyword dictionary contains `keywords: string[]` and a nonnegative safe-integer `word_search`. Keyword text is preserved. For `getStickerSuggestions`, provide a nonempty keyword of at most 4,096 UTF-8 bytes. The SDK preserves its whitespace and Unicode without deriving it from chat content.

Suggestions can contain `sugg_sticker`, `sugg_gif`, `sugg_guggy`, and `expired_time`. Sticker references contain `cate_id` and `sticker_id`, plus any provider extras. GIF and Guggy rows remain open objects. Omitted or null collections retain their original form. `expired_time` is returned without an inferred unit conversion or automatic cache.

`options.guggy` is a boolean and defaults to false, matching the installed configuration. GIF suggestions are requested with the fixed wire flag `gif: 1`. A nonempty `options.zmdClass` of at most 512 UTF-8 bytes, without control characters, adds the paired fields `zmd_type: 1` and `zmd_class`. Neither model field is sent when the option is omitted. The SDK does not run the installed text-classification model or fabricate its label.

The Tenor response can contain `tenor_sticker_map` and `expired_time`. Map keys are retained as opaque provider keys. Each mapping has `eid` for the Zalo sticker ID and `cid` for the category ID; other fields remain intact. Missing/null map and expiry fields are preserved. This helper does not infer an expiry time unit, run a background refresh, or download the mapped asset.

The pinned upstream `getStickers` operation reaches the same suggestion route dynamically but returns only IDs from `sugg_sticker`. These helpers retain the full mixed result and related discovery data. Existing upstream search and sticker-detail operations remain available separately.

## Revisioned personal category replacement

The read snapshot can contain `sticker_cates`, `version`, `removeSticker`, and `expired_time`. Category order is significant. Category zero is the installed built-in category. Removed-sticker records can contain `sticker_id` and additional metadata. The installed personal-category consumer interprets its `expired_time` as seconds; this API returns the value without scheduling a timer.

A missing snapshot field remains missing. The SDK does not substitute the installed app's local defaults of category `[0]` or revision 1. Retain the provider revision and supply it explicitly when replacing the list. The input accepts up to 1,000 distinct category IDs; this is an SDK bound. Numeric-equivalent IDs such as `1` and `'01'` cannot appear together. An empty replacement is sent as an empty list, and zero is included only if the caller includes it.

The update result has an additional `data` object compared with the read. Its ordered list is `updated.data.sticker_cates`, and its optional new revision is `updated.data.version`. Both this inner snapshot's extras and the update wrapper's extras are preserved. A successful response without a usable ordered list is reported as an invalid response. A missing new revision requires caller reconciliation before another revision-dependent replacement.

Only one replacement can be active per authenticated API instance. A concurrent replacement is rejected with a fixed error before another request starts. This prevents the SDK from queuing several writes using the same stale revision. After completion or failure, a new explicit operation is permitted. The application still reconciles the provider's revision and state before deciding to submit again.

Despite its name, the installed update is a **GET that changes the account's category ordering**. The SDK follows that exact contract, disables redirects, and makes no automatic retries or refresh-driven updates. Provider refusals remain `ZaloProtocolError` with a safe `providerCode`; raw provider messages are omitted. Network failure, cancellation after submission, or a malformed acknowledgment can leave the write outcome uncertain. Cancellation does not roll back an accepted provider update.

## Greeting dataset

The greeting route returns a JSON string inside the ordinary decrypted response. The helper parses that one additional string layer, then returns the dataset. It rejects an already-decoded object, malformed JSON, or an additional string layer with the fixed invalid-response error.

Known fields are `_domain`, `morning`, `afternoon`, and `evening`. Each time bucket can contain `maleYoung`, `maleOld`, `femaleYoung`, and `femaleOld` arrays of filename strings. Future fields and profile labels remain intact. The installed app concatenates `_domain`, time bucket, profile label, and filename to select assets; this helper returns the dataset without choosing a demographic label, reading account information, constructing a download, or performing that download.

## Exact requests and evidence

Every helper uses the authenticated `sticker` service, GET, the standard client query fields, and an account-encrypted JSON `params` query. Each request includes the session's `imei` and rejects redirects. The following paths begin with `/api/message/sticker/`:

| Route | JSON fields before session `imei` | Command | Request-builder byte |
| --- | --- | --- | --- |
| `suggest/keywords` | `{}` | 11740 | 12,426,521 |
| `suggest/stickers` | `{keyword,gif:1,guggy:0\|1,zmd_type?,zmd_class?}` | 11741 | 12,426,742 |
| `tenor/mapping` | `{}` | 12015 | 12,427,106 |
| `personalized/list` | `{}` | 11745 | 12,486,711 |
| `personalized/update` | `{version,sticker_cates}` | 11746 | 12,486,937 |
| `suggestion` | `{}` | 11751 | 12,500,626 |

These are UTF-8 byte offsets in the installed Zalo Desktop 26.11.10 build 26.11.10.3400 [SHARED artifact](desktop-evidence.md), SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. The ordinary two-envelope AES response decoder is at byte 13,736,118. Consumer evidence:

| Bytes | Established behavior |
| --- | --- |
| 6,990,157 | Guggy disabled by default. |
| 11,710,087; 16,014,960 | Keyword dictionary and maximum word count. |
| 11,978,410; 14,185,159 | Full suggestion result, including separate sticker/GIF/Guggy collections. |
| 9,212,901; 9,221,670 | Tenor map field names and `eid`/`cid` interpretation. |
| 16,009,448–16,012,219 | Revisioned ordered-list update, extra update `data` layer, and read snapshot. |
| 16,013,993 | Removed-sticker lookup by `sticker_id`. |
| 12,089,257; 3,993,800–3,994,972 | Extra greeting JSON-string layer and time/profile dataset use. |

Encrypted fixtures verify exact routes, methods, query placement, request fields, response nesting, preserved provider extras and identifier precision, error privacy, cancellation, and the concurrent-replacement guard.

On 6 November 2026, separate saved-Web-session reads returned 3,215 keywords, an empty Tenor map, one personalized category with a revision, a greeting dataset with its domain, and four sticker references for the fixed greeting keyword `xin chào`. GIF/Guggy arrays were omitted in that suggestion response. Populated Tenor mappings and mixed GIF/Guggy records remain fixture-verified. No assets were downloaded and no personal-category replacement was submitted. Catalog/CDN resolution, recommended stickers, and AI sticker discovery remain outside this module because they have different transport requirements or unresolved consumer contracts.
