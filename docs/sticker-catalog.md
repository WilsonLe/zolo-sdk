# Complete sticker catalog resolution

`getStickerCatalog(api, options)` reads the V2 catalog metadata and resolves its category data. It implements the installed checked-CDN and inline-fallback workflow, then adds the built-in category and applies the installed exclusion and ordering rules. A metadata-only response is not treated as a completed catalog.

```ts
import { getStickerCatalog } from 'zalo-personal-sdk';

const catalog = await getStickerCatalog(api, {
  // Exact HTTPS origins configured and trusted by the application beforehand.
  allowedOrigins: applicationStickerCdnOrigins,
  signal,
});
for (const category of catalog.categories) {
  showApplicationCategory(category);
}
```

The application owns the origin configuration and rendering functions. This helper fetches the catalog JSON only. It does not download category icons, sticker images, or animations, add a personal category, or send a sticker.

The reusable stages are `getStickerCatalogManifest(api, signal?)` and `resolveStickerCatalog(manifest, options)`. They allow the application to retain authenticated metadata and resolve it explicitly later. `getLegacyStickerCatalog(api, signal?)` exposes the separate V1 read with its exact builder contract; its decoded result is `unknown` because a V1 response consumer was not established in the selected artifact. It does not pretend that a legacy result is a resolved V2 catalog.

## Authentication and metadata

Both catalog builders use the authenticated `sticker` service and GET:

| Operation | Path | Command |
| --- | --- | --- |
| V2 manifest | `/api/message/sticker/category/list/v2` | 12020 |
| Legacy V1 read | `/api/message/sticker/category/list` | 11155 |

They place AES encryption of the **empty plaintext string** in the query's `params` field. This is distinct from encrypting JSON `{}`, encrypting the JSON string `""`, or omitting `params`. No `imei` or language JSON member is injected. The normal account request transport supplies its authenticated session and common client query parameters. Both builders reject redirects.

V2 metadata can contain `dataUrl`, `cs`, inline category `data`, and `exCateIds`. Other provider fields remain intact. The returned `manifest` preserves this metadata, including inline rows that were excluded from the resolved display list. `getStickerCatalogManifest` validates these known field shapes but does not download or claim to verify the CDN content.

## Controlled CDN transport

Supply `allowedOrigins` as exact HTTPS origins configured by the application, for example an already trusted CDN origin. Do not build this permission list automatically from a received `dataUrl`. An empty list permits inline-only metadata when no download URL is supplied; it does not authorize a CDN request.

The resolver follows the installed conversion of an initial, case-insensitive `http://` to `https://`, then requires the resulting origin to match the configured set. It rejects credentials, fragments, whitespace, control characters, backslashes, unsupported schemes, and protocol-relative URLs. It does not resolve relative paths against an account origin. Query parameters are preserved without appearing in error messages.

The CDN request uses a separate fetch transport with GET, `credentials: 'omit'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'`, and `cache: 'no-store'`. The SDK does not attach account cookies, authorization headers, the account user agent, or an encrypted account query. It never calls the authenticated account request adapter to fetch CDN content. An optional `fetch(url, init)` is a trusted application adapter and must honor these security options. Redirected responses, changed response URLs, and redirect status codes are rejected.

`timeoutMs` defaults to 30 seconds and can be 1–120,000 ms. For the combined `getStickerCatalog` helper this deadline covers both the account manifest and resolution; for `resolveStickerCatalog` it covers resolution. The deadline remains active through body consumption. Cancellation or timeout stops local work, cancels an active reader, and prevents a late account manifest from starting a CDN request. A late response from an adapter that ignored cancellation has its body cancelled.

`maxDownloadBytes` defaults to 4 MiB and can be at most 16 MiB. Both declared size and streamed body bytes are bounded; the bytes exposed after fetch's decompression also count. Invalid lengths, incomplete identity-encoded bodies, and ranged responses are rejected. `maxCategories` defaults to 10,000 and can be at most 100,000; it bounds provider rows and exclusion IDs before filtering. At most 32 permitted origins can be configured. These are SDK bounds, not proven provider maxima.

## Checked text and inline fallback

The installed checksum is lowercase hexadecimal `MD5(UTF8(downloadedText + "qebjuzwihygr"))`. The resolver uses the same decoded-text semantics as `Response.text()`, including UTF-8 replacement decoding and stripping an initial BOM. It compares the digest with `cs` exactly; it does not normalize an uppercase or otherwise different checksum.

Checked, parseable, nonempty CDN categories are preferred. A checksum mismatch, invalid JSON/category content, or a category list emptied by exclusions selects the inline `data` fallback. An HTTP error response also selects inline data without accepting its body as a catalog. This is stricter than the installed fetch consumer, which reads HTTP error bodies before applying the checksum check.

Network rejection, URL-policy violations, redirects, cancellation, timeout, malformed/incomplete bodies, and configured resource-limit failures are propagated. They do not silently become a successful inline catalog. The installed consumer also rejects network failures rather than taking its content-fallback branch. When no `dataUrl` is present, this SDK can resolve available inline data directly; it avoids the installed consumer's attempted fetch of an absent URL. If neither source supplies usable nonempty categories, the SDK reports `no-categories` instead of the UI consumer's empty error result.

The result reports `source: 'cdn' | 'inline'` and `checksumVerified`. Only an accepted CDN result has `checksumVerified: true`. An inline result includes `fallbackReason`: `missing-url`, `http-error`, `checksum-mismatch`, or `invalid-catalog`. Inline metadata comes from the authenticated manifest; the CDN checksum has not independently verified it.

## Categories, exclusions, and ordering

Category rows retain their provider fields. IDs remain safe numeric values or exact decimal strings; large JSON integer IDs are parsed without precision loss. The SDK validates present numeric `type`/`status` fields without filling missing fields or inventing a complete category schema.

The source applies exclusion filtering **only when `exCateIds` is nonempty**. In that branch it removes rows with missing/falsy IDs and rows whose string-key ID is excluded. Numeric ID zero is falsy, whereas string ID `'0'` is truthy. With empty exclusions, the SDK does not invent that filtering or deduplicate provider IDs. Malformed surviving rows do not become valid display categories.

For a usable list, the resolver prepends the installed built-in metadata:

```json
{
  "id": 0,
  "iconUrl": "https://res-zalo.zadn.vn/upload/media/2017/1/9/o_a62421af372795dd-0_1483937772450.jpg",
  "name": "Củ hành",
  "totalImage": 30,
  "version": 2
}
```

This is the shipped default icon configuration; the helper does not fetch that icon or read an application-local override. It then applies the installed comparator: unequal types sort descending numerically; equal types sort descending by status with **numeric** status 4 treated as zero. String `'4'` is retained as a numeric-string status rather than receiving that strict numeric special case. Missing values remain missing, and comparisons producing `NaN` retain stable order as in the installed comparator. The built-in row is added before this sort. No personal-category ordering is changed.

## Errors and verification

`StickerCatalogError` has fixed messages and a `code`, plus an optional safe HTTP `status`. Codes cover invalid metadata/URLs, failed or invalid downloads, configured limits, unavailable category content, cancellation, and timeout. Provider errors from the account manifest read retain the standard `ZaloProtocolError.providerCode`. The metadata-only and legacy builders use the standard transport's cancellation errors. No request or CDN download is retried automatically. Error messages contain no response bodies, account values, or provider URLs.

The installed Zalo Desktop 26.11.10 build 26.11.10.3400 [SHARED artifact](desktop-evidence.md) has SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. Relevant UTF-8 byte offsets:

| Bytes | Contract |
| --- | --- |
| 12,425,413; 12,425,614 | Separate V1/V2 GET builders and empty-string AES plaintext. |
| 16,004,270–16,005,800 | CDN text, salted-MD5 comparison, JSON/inline fallback, exclusions, built-in insertion, and ordering. |
| 16,002,850–16,003,400 | Built-in row fields and `Củ hành` label. |
| 16,666,470–16,668,500 | Built-in category zero, salt, and 30-image constant. |
| 6,966,058 | Shipped default built-in icon URL. |
| 1,331,548 | MD5 input uses UTF-8 `TextEncoder` bytes. |
| 11,554,908; 16,726,699 | Exact HTTP-to-HTTPS normalizer and its public wrapper. |
| 13,736,118 | Standard account response envelope decoding. |

Offline fixtures independently decrypt the empty-string account requests, check CDN options and checksum handling, preserve metadata/large IDs, exercise exclusions/sorting/fallback, enforce download limits, and cover active/late cancellation and stalled bodies.

On 6 November 2026, the saved Web session accepted V2 metadata. A first resolver probe using three compiled asset-origin pins rejected its different CDN origin. A separate operator-configured probe explicitly pinned `https://zalo-api.zadn.vn` and called the complete `getStickerCatalog` flow: it returned 388 categories from the CDN with `checksumVerified:true`. The received HTTP locator was upgraded to HTTPS as specified. The permission list was supplied explicitly; the SDK did not derive it or follow arbitrary manifest origins. No icons or sticker media were downloaded. The separate legacy V1 read returned HTTP 404. Recommended response semantics and AI discovery remain separate gaps.
