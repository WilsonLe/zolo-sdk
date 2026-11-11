# Shared media libraries

`getMediaLibraryPage` pages the provider's stored attachments for a group or My Documents. `getMediaLibraryPreview` fetches a mixed preview. Categories are `media` for photos and videos, `file`, and `link`. Both reads default to 50 entries and accept an SDK limit from 1 through 100.

```ts
import { getMediaLibraryPage, getMediaLibraryPreview } from 'zalo-personal-sdk';

const target = { kind: 'group' as const, groupId };
const first = await getMediaLibraryPage(api, target, { category: 'media' });
if (first.hasMore && first.lastId) {
  const next = await getMediaLibraryPage(api, target, {
    category: 'media', lastId: first.lastId,
  });
}
const savedPreview = await getMediaLibraryPreview(api, { kind: 'saved-messages' });
```

Results retain provider fields such as `src_url`, `thumb_url`, `sub_type`, `fdata`, and `created_time`. Media, owner, group, and message identifiers are returned as strings. `lastId` is the provider's continuation cursor. Optional `lastFetchId` carries the previously fetched item boundary used by Desktop to stop overlap. Library URLs and encryption metadata are private account data.

`removeMediaLibraryItem(api, target, {category, mediaId, signal?})` explicitly submits one media-store removal. The installed client can also perform local storage cleanup and message deletion around this operation. Application state and the provider's permissions determine the resulting UI. A request failure after submission can leave the outcome uncertain. Reconcile the library before retrying. The SDK performs one request per call.

## Installed request contracts

| Operation | Group service `media_store` | My Documents service `media_store_send2me` | Encrypted parameters |
| --- | --- | --- | --- |
| Page | GET `/api/mediastore/list`, command 11841 | GET `/api/media/oneone/list`, command 12220 | `media_type`, optional `limit`, `last_id`, `lastFetchId`. Group adds `group_id` and `imei`. |
| Preview | POST `/api/mediastore/preview`, command 11843 | POST `/api/media/oneone/preview`, command 12221 | `limit` defaults to 50. Group adds `group_id` and `imei`. |
| Remove | POST `/api/mediastore/remove`, command 11842 | POST `/api/media/oneone/remove`, command 12222 | `media_type` and `media_id`. Group adds `group_id`. |

All six routes put account-encrypted `params` in the query, including POST requests with an empty body. The normal outer and inner response envelopes report provider errors. A page's decoded `data` contains `items`, `has_more`, and `last_id`. Preview `data` is an array. The installed client selects this cloud library for feature-enabled groups and My Documents. Ordinary direct-conversation media is loaded from local storage or the separate message-history path.

The installed Zalo 26.11.10 SHARED member contains the list, preview, and removal builders at bytes 12,422,348, 12,422,865, and 12,423,359, response consumers at 12,063,154–12,064,268, and service keys at 14,700,761. The matching Web startup chunk has the same preview and removal builders at 11,594,154 and 11,594,648, with page and preview decoders at 11,244,594 and 11,245,165. Encrypted HTTP fixtures cover all six routes, continuation, precision, rejection, and input validation. [Desktop evidence](desktop-evidence.md)

On 5 November 2026, the saved account's sampled group accepted the preview read and all three page categories, each returning an empty result. The same four My Documents reads returned HTTP 404. Nonempty provider records and removal behavior remain fixture-verified.
