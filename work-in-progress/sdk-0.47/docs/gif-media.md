# GIF catalogs and messages

The SDK uses the authenticated session's `sticker` service for GIF catalogs and searches. Calls use GET and encrypt the fields below as `params`. Giphy operations default to offset 0 and limit 10. Guggy defaults to limit 20, as in the desktop picker. The desktop gates Guggy behind a server feature setting.

| SDK operation | Path and internal command | Fields beyond pagination | Decoded result |
| --- | --- | --- | --- |
| `getGifCategories` | `/api/message/giphy/cates`, 11294 | | `data_list` of category records |
| `getGifsByCategory` | `/api/message/giphy/gifs`, 11295 | Numeric `cate_id` | `data_list` of GIF assets |
| `getTrendingGifs` | `/api/message/giphy/trending`, 11296 | Session `imei` | `data_list` of GIF assets |
| `searchGifs` | `/api/message/giphy/search`, 11297 | `keyword` | `data.data_list` of GIF assets |
| `getGifsByDictionary` | `/api/message/giphy/gifsbydict`, 11299 | Numeric `dic_id` | Provider payload |
| `getDefaultGuggies` | `/api/message/guggy/default`, 11749 | | Array of Guggy assets |
| `searchGuggies` | `/api/message/guggy/search`, 11750 | `keyword` | Array of Guggy assets |

Pass a catalog GIF directly to `sendGif(api, { threadType, threadId, clientId, gif })`. It needs the original URL and dimensions plus the normal rendition URL. Use a fresh numeric client action ID for each new message. The SDK sends only the explicit request. It passes the URLs in the request and leaves fetching and message rendering to Zalo.

Direct sends use `POST /api/message/gif` (11292) and group sends use `POST /api/group/gif` (11194), both on the `file` service. For these routes the POST has an empty body and encrypted `params` in the URL query. The URL GIF payload uses `type: 0`, `href` for the original URL, `thumb` for the normal rendition, `width`, `height`, `msg`, optional `contentId`, `ttl`, and a decimal string `clientId`. It uses `toid` for a direct thread and `grid` with `visibility` for a group. The SDK defaults `src` to the client's unknown-source value of `-1` and defaults TTL and visibility to 0.

The command registry lists `/api/message/giphy/dicts` (11298), with no request builder found in the inspected bundles. The dictionary-ID operation exposes the decoded response because its caller-specific DTO is unconfirmed.

The [installed SHARED member](desktop-evidence.md) contains URL and local GIF send builders at 12,429,445–12,431,296, Giphy requests at 12,431,296–12,432,555, Guggy requests at 12,488,803–12,489,325, the GIF picker caller at 11,986,478–11,987,486, and catalog response consumers at 16,091,200–16,092,951. The Web startup bundle independently contains the same URL send and discovery builders at 11,601,846–11,603,846 and 11,660,063–11,660,580. Local fixtures verify the AES query payloads, empty POST body, response wrappers, and lossless message IDs. A live saved session returned eight categories with `limit: 3` and 20 trending GIFs with `limit: 1`, so treat the returned length as provider-controlled. Other catalog routes and GIF message delivery remain unverified on a live account.

## Send a local GIF

Pass the animation and a PNG thumbnail as bytes. The SDK checks the file headers and uses the thumbnail's dimensions for the message. It enforces the advertised `sharefile.max_size_gif` for each file, with a 3 MiB default and a 16 MiB SDK ceiling.

```js
const message = await sendLocalGif(api, {
  threadType: 'user',
  threadId,
  clientId,
  fileName: 'animation.gif',
  gifBytes,
  thumbnailPng,
});
```

The first POST uses `/api/message/upthumb` (11293) on the `file` service. Its multipart field is `fileContent` and its encrypted query contains a separately generated thumbnail correlation ID and the session `imei`. The SDK checks the echoed `clientFileId` before using the returned thumbnail URL.

The GIF POSTs use `/api/message/gif` or `/api/group/gif` on the same service. The query has `type=1` and encrypted `params` containing the decimal string message action ID, original file name, total size, PNG width and height, thumbnail URL, TTL, destination fields, the whole GIF's hexadecimal MD5, total chunk count, and one-based chunk index. Each multipart `chunkContent` field carries up to 512,000 consecutive bytes. Inner response codes `1` and `220` permit continuation. Code `0` confirms completion.

The SDK sends one chunk at a time and stops on cancellation or failure. Multipart requests reject redirects to keep the submitted bytes on the requested host. `ZaloGifUploadError.lastAcceptedChunk` records the confirmed prefix. `submission-unknown` means a chunk may have reached the service before the transport failed or returned an unreadable response. `incomplete` means every chunk received an interim acknowledgment. Verify the outcome before retrying an uncertain submission.

The installed SHARED member contains the thumbnail processor at 11,489,500, file slicing at 1,330,283, and multipart builders at 12,427,322–12,430,482. Its CPU worker `pc-dist/cpu-heavy-worker.cfeba43a9a8e4e40dda3.js` computes whole-file MD5 at 142,427. The Web startup bundle independently contains the thumbnail and chunk builders at 11,598,611–11,601,846. Local fixtures verify encrypted queries, cookie scoping, multipart boundaries and bytes, response correlation, and partial failure. Live upload and delivery remain unverified.

## Forward an existing ordinary GIF

`forwardGif(api, input)` forwards caller-owned normalized source metadata to one ordinary user or group. The application selects the source, destination and stable numeric client action ID.

```ts
import { forwardGif } from 'zalo-personal-sdk';

const receipt = await forwardGif(api, {
  threadType: 'user', threadId, clientId,
  source: {
    normalUrl, thumbnailUrl, originalUrl,
    width: null, height: null, title: 'Original caption',
  },
});
// receipt.msgId is exact text; receipt.raw retains the decoded acknowledgment.
```

The file-service POST uses `/api/message/forward` (11199) with `toId` and IMEI, or `/api/group/forward` (11818) with `grid` and `visibility`. Group routing strips one optional lower-case `g` prefix. Common query and account-encrypted form `params` carry numeric `clientId`, `ttl`, fixed `zsource:-1`, numeric `msgType:4` and JSON-text `msgInfo`. HTTP 200 is required before consuming the response body. The common restricted transport rejects HTTP 3xx, any `Location` header (including an empty value), a response marked redirected, or a changed response URL before body consumption. It cancels rejected response bodies when available and issues no follow-up request. Existing initial GIF sends and local uploads keep their original `/gif` contracts.

The source projection is exact:

| Source member | `msgInfo` member |
| --- | --- |
| Required `normalUrl` | `href` |
| Optional `thumbnailUrl` | `thumbUrl` |
| Optional `originalUrl` | `hdUrl` |
| Optional `width`, `height` | Same names |
| Optional `title` | `msg` |

For optional source fields, undefined is omitted and explicit null is retained. URLs and dimensions receive no fallback. An empty caption stays empty; missing caption is omitted. Dimensions accept null, nonnegative safe integers or bounded decimal strings, preserving a supplied string's leading zeros. To represent the installed producer's failed dimension parse, supply explicit nulls. The helper accepts normalized fields rather than consulting the official message database or parsing an arbitrary original-message DTO.

Optional `referenceLog` is an opaque UTF-8 string, including empty. It becomes JSON-text `msgInfo.reference` containing `{type:3,data:referenceLog}`. Optional `decorLogJson` is validated JSON-object text and remains an outer string-valued `decorLog`, preserving its original text. No originating message IDs or provenance are synthesized. Initial-GIF `type`, `src`, `contentId`, `thumb` and recommendation action fields are absent from this forwarding record.

Inputs must be ordinary own-data records with the declared fields; proxies, accessors and unknown fields reject before dispatch. Optional own undefined values mean omission, including direct `visibility:undefined`; a defined direct visibility is invalid. Client ID is a positive safe integer; TTL and group visibility are nonnegative safe integers with explicit SDK defaults of zero. Destination IDs are positive decimal strings of at most 40 digits, preserving leading zeros when at least one digit is nonzero. The helper does not consult the native conversation TTL or visibility store.

Locators are nonempty HTTP(S) UTF-8 strings of at most 64 KiB, without credentials, whitespace, controls or backslashes. Their original query/fragment spelling is retained. Explicit E2EE/PCloud session capsules in the query are unsupported for this ordinary source. Optional caption/reference/decor text is bounded to 64 KiB each. Dimensions use safe integer values or 1–40 decimal digits within the same safe range. These are declared SDK input limits, not provider guarantees. The operation performs no URL probe, HEAD, asset fetch, renewal, upload, local echo, hidden E2EE selection or automatic fallback.

A successful result is frozen `{msgId,raw}` with a shallow frozen complete decoded acknowledgment. A usable message ID is positive safe numeric data or decimal text up to 40 digits; the public ID is text and is never rounded. Leading zeros in a returned string stay intact. Raw nested extensions remain original decoded references. This confirms the request acknowledgment; delivery, rendering and asset lifetime need separate evidence.

`GifForwardError` has a fresh fixed code/message, `submitted`, `outcomeUnknown` and optional safe numeric provider/HTTP status. Pre-abort, concurrent reuse and missing service are distinguished from handoff. After handoff, a qualified nonzero provider refusal is known; HTTP/transport/body/schema failure or cancellation otherwise leaves the outcome unknown. An observed cancellation uses code `aborted`, with false/false flags before dispatch or true/true afterward. A zero provider code does not establish refusal. The helper never retries. Reconcile an uncertain result before a later explicit attempt.

Concurrent calls of this helper share a process-local per-API/client-ID lease, released on every terminal path. It does not coordinate other helpers, processes or the official app. This whole-response transport adds no default deadline or generic response-size bound; the caller supplies cancellation policy.

Static evidence is SHARED 12,095,005–12,095,294 (active GIF projection), 12,099,525–12,099,690 (ordinary/encrypted dispatch), 12,460,083–12,460,744 (singular request), 13,502,130–13,502,252 (explicit TTL) and 16,788,599–16,788,763 (reference envelope). The installed common completion path consumes `msgId` at 4,300,400–4,304,800. Local independent encrypted-request/acknowledgment fixtures validate this explicit operation; no new message or live forward was submitted. Ordinary file/photo clone, renewal, album/layout and rich multi-target forwarding remain separate unfinished work.
