# Attachment link renewal

Use `renewAttachmentLinks(api, input, options)` to renew an ordinary file, photo, or video URL for a direct conversation, group, or My Documents. Supply the attachment's provider metadata and a client action ID. The source URL comes from `content.url` for files, `content.oriUrl` for photos, and `content.videoUrl` for videos. Set `videoThumbnail: true` to renew `content.thumbUrl`. Pass `isOriginalPhoto: true` for an original-quality photo. Use metadata from ordinary messages because encrypted attachment URLs can carry keys.

```js
const result = await renewAttachmentLinks(api, {
  threadType: 'group',
  threadId,
  kind: 'photo',
  clientId,
  content: receivedPhotoMetadata,
}, { feed, signal });
```

An immediate success returns `{status:'ready',links}`. A deferred response returns `{status:'pending'}` when called without a realtime feed. Supply the same API's authenticated feed to await completion on the existing socket. The SDK reserves a matching request by attachment kind, destination, and source URL. After a timeout or ambiguous request failure, it holds the match until the late event arrives or the feed closes. This prevents that event from resolving a new request for the same attachment. The call defaults to a 30-second deadline. Treat the returned links as private data.

Use `extractAttachmentRenewalEvents(frame)` if your app manages completion itself. It reads successful and rejected `renew_link` controls. The SDK returns links for the application to use in its own forwarding flow.

## Installed evidence

| Stage | Evidence |
| --- | --- |
| Request | `POST /api/message/renewlink` on `file`, internal command 12094. The account-encrypted form includes `{toId,msgType,msgInfo,clientId,imei,isGroup}`. `msgType` values are 1 file, 2 photo, and 5 video. `msgInfo` is the provider metadata JSON plus numeric `isE2EE` and `isOriginal`. My Documents uses the group flag in this route. SHARED 11,923,564 and 12,457,749. |
| Renditions | The builder removes the `jxlstatus=1` marker from recognized JPEG XL rendition URLs. It sets `msgInfo.url` from the original photo URL and keeps `oriUrl` in the metadata. The video path uses `renewType:1` for video and `renewType:0` for its thumbnail. SHARED 3,872,294, 7,584,762, 11,931,050–11,931,800, and 12,457,749. |
| Immediate result | After the two AES response layers, the desktop accepts `fileUrl` or photo rendition fields `normal`, `hd`, and `thumb`. An `async` response waits for a control event. SHARED 11,926,565–11,927,970. |
| Deferred result | Realtime commands 601 and 603 carry `renew_link` under `file`, `photo`, or `video`. File and video rows carry `destId`, `destType`, `originalUrl`, `renewUrl`, and `error`. Photo uses `img`, `normal`, `hd`, `thumb`, and `errorCode`. SHARED 11,930,157–11,931,450 and 12,026,600–12,027,620. |

The Web startup bundle independently contains the request builder at byte 11,629,038 and the deferred consumer near byte 11,108,929. Local fixtures cover request encryption, synchronous and deferred results, matching early events, late-reply isolation, and safe provider errors. Live renewal and forwarding remain unverified. [Desktop evidence](desktop-evidence.md)
