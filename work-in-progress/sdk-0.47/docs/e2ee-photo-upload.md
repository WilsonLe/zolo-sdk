# Encrypted uploaded photos

The E2EE entry point provides `uploadE2eePhoto`, `createE2eePhotoParameters`, `sendPreparedE2eeDirectPhoto`, and `sendPreparedE2eeGroupPhoto`. This is the installed initial uploaded-photo path. It stages caller-sealed image bytes and sends a separate photo record using the direct or group encryption service. The SDK never uploads a raw media key or falls back to ordinary photo delivery.

Use already prepared, oriented JPEG or PNG bytes. The SDK does not resize, convert, decode, or generate a preview. `sealE2eeMediaFile` supplies the installed linear AES-256-GCM format for images up to its existing 16 MiB local limit. Its `ciphertext` has the same length as the original image, and its sensitive `fileKey` contains the 32-byte key, 12-byte IV, and 16-byte tag. An application providing its own linear sealer can use the original-quality uploader's larger limit. Each independently encrypted preview needs its own key and ciphertext.

```ts
import {
  createE2eePhotoParameters, sealE2eeMediaFile,
  sendPreparedE2eeDirectPhoto, uploadE2eePhoto,
} from 'zalo-personal-sdk/e2ee';

// conversation is an already authenticated E2eeDirectSession for this device.
// api and feed belong to the same approved account session.
const main = sealE2eeMediaFile(photoBytes);
const preview = sealE2eeMediaFile(thumbnailBytes);
const uploaded = await uploadE2eePhoto(api, {
  threadType: 'user', threadId: recipientId, clientId: actionId,
  quality: 'legacy-hd', width: 1280, height: 960,
  ciphertext: main.ciphertext, feed,
});
const thumbnail = await uploadE2eePhoto(api, {
  threadType: 'user', threadId: recipientId, clientId: thumbnailActionId,
  quality: 'legacy-hd', role: 'thumbnail', width: 160, height: 120,
  ciphertext: preview.ciphertext, feed,
});
const parameters = createE2eePhotoParameters({ uploaded, thumbnail, fileKey: main.fileKey });
const sent = await sendPreparedE2eeDirectPhoto(api, {
  uploaded, thumbnail,
  recipients: [{
    userId: recipientId, deviceId: 2,
    caption: conversation.encrypt('Photo'),
    parameters: conversation.encrypt(parameters),
    thumbnailKey: conversation.encrypt(preview.fileKey),
    normalKey: conversation.encrypt(main.fileKey),
    hdKey: conversation.encrypt(main.fileKey),
    rawKey: conversation.encrypt(main.fileKey),
  }],
});
```

Use a unique positive numeric action ID for every main and preview upload. The main action ID is retained by the final send. Supply frames for every destination device, including any sender subdevices required by the application's device topology. Every key slot must be independently encrypted even when several slots contain the same main key. A raw key cannot be passed as a prepared frame. For groups, use group-sender-key frames and `sendPreparedE2eeGroupPhoto`; replace `normalKey` with `originalKey`, and use `threadType: 'group'` while staging.

## Upload and quality contracts

| Quality | Service | Upload route after `/api/{message,group}/` | Local bounds | Preview |
| --- | --- | --- | --- | --- |
| `legacy-hd` | `file` | `photo_original/upload` | 5 MiB; 2,560 px per axis | Separately stage `role: 'thumbnail'` and supply its descriptor at send. |
| `original` | `zcloud_up_file` | `zcloud-upload/photo` | 100 MiB; 30,000 px per axis | Uses the main upload preview and main key, matching installed `skipGenThumbForPhotoE2EE`. |

Original mode needs no separate thumbnail descriptor. Its final `thumbnailKey`, `normalKey` or `originalKey`, `hdKey`, and `rawKey` are different prepared frames for the same main key. The metadata adds `is_original: 1`. The original service must be advertised by the authenticated endpoint map; absence is an error. The uploader requires the returned original URL for this mode and never substitutes an HD-only response for it.

Both upload paths submit multipart `chunkContent` with account-encrypted query parameters: `totalChunk`, `fileName`, `clientId`, `totalSize`, one-based `chunkId`, `isE2EE: 1`, `eeType`, `imei`, and `toid` or `grid`. The query `type` is 2 for direct and 11 for group. The visible filename defaults to `encrypted.jpg`; the JPEG/PNG suffix selects the upload filename contract and does not validate encrypted image contents. Dimensions and byte lengths are caller supplied and remain provider-visible.

`uploadRendition` defaults to `normal`, matching the shipped `e2ee.force_upload_normal: true`. An explicit `HD` value follows the installed main-photo branch when that override is disabled. A thumbnail always uses `normal`. This describes the encrypted uploader's rendition parameter; `quality` separately selects the legacy or original route.

The default chunk size is 256,000 bytes. A valid advertised `sharefile.chunk_size_file` of at least 64,000 takes precedence; a chunk above the transport's 16 MiB limit is rejected. Linear encryption does not require block-aligned chunk boundaries. Every request disables redirects and is submitted once. The API does not silently replay chunks or a final message.

The response can contain inline `normalUrl`, `thumbUrl`, and `hdUrl`, or acknowledge `photoId` and `finished`/`isFinish` before a `photo_success` control arrives on realtime command 601 or 603. A caller-supplied feed is observed before upload so early controls are retained. It must belong to the same API instance. The SDK detaches its own subscription without stopping that feed. A completion timeout defaults to 120 seconds and can be shortened.

`UploadedE2eePhoto` is a frozen, serializable account/destination-scoped descriptor containing locators, dimensions, size, and IDs. It contains no raw media key. The application retains sealed media and key material separately and may restore a descriptor after reconnecting to the same account. Final delivery validates the account, role, destination, and key-free HTTPS locators. A legacy preview needs the same account and destination plus a different action ID. Original mode rejects a separate preview descriptor to preserve the established path.

## Final encrypted record

Initial delivery uses `/api/e2ee/pc/message/photo` on `chat_e2e`, or `/api/e2ee/pc/group/photo` on `group_e2e`. It uses E2EE version 0 and compatibility version 0. Direct delivery wraps records in the existing `listParams`/`destType: 3` request; group delivery uses its direct record. This path has no forwarding `msgType` or `msgInfo` wrapper.

| Prepared field | Final record |
| --- | --- |
| `caption` | `desc`; empty when omitted |
| `parameters` | `prmE2EE` |
| `thumbnailKey` | Capsule in `thumbUrl`; preview upload for legacy, main preview for original |
| `normalKey` | Capsule in direct `normalUrl` |
| `originalKey` | Capsule in group `oriUrl` |
| `hdKey` | Capsule in `hdUrl` |
| `rawKey` | Capsule in `rawUrl` |

The public locators are retained and only the `e2esession` suffix contains the prepared ciphertext. The installed URL stringifier assumes a query-free locator and appends `?`; this API also preserves any existing ordinary query parameters by appending `&` when needed. Raw Base64 `+` characters are not changed by URL query encoding. `photoId`, main `clientId`, width, height, and `zsource: -1` remain outside the ratchet, matching the installed record. The helper does not send an ordinary-photo `jcp` quality flag on this encrypted path.

`createE2eePhotoParameters` builds the exact ordinary standalone metadata before ratchet encryption: `width`, `height`, `hdUrl`, `rawUrl`, `hd`, and, for legacy photos, `rawThumbUrl`. The `hdUrl`, `rawUrl`, and `hd` members contain raw main-key capsules; these are sensitive plaintext until the entire metadata JSON is encrypted into `parameters`. Legacy `rawThumbUrl` preserves the provider preview locator before the independent preview replaces visible `thumbUrl`. Original mode omits that generated-preview field and adds `is_original: 1`.

## Errors and scope

`E2eePhotoUploadError` reports a fixed `code`, accepted chunk count, and any known photo ID or safe provider code. In-flight network failure or cancellation can leave a submission uncertain. An error does not automatically retry. Completion cancellation, timeout, or feed closure detaches the observer and releases the active upload guard.

Provider duplicate code 1 is deliberately reported as `duplicate-upload`. A provider `secureKey` replacement is reported as `key-reconciliation-required`, without including its value. The installed app can reconcile these cases using its private upload cache and key state. This API cannot prove that a duplicate receipt or replacement key belongs to caller-supplied sealed bytes, so it does not issue a sendable descriptor for those cases. The app must reconcile explicitly before another attempt.

Prepared final delivery has the same explicit submission/retry responsibilities as other prepared operations: preserve the action ID and frames for that submission and reconcile uncertain acceptance. Validation checks frame structure and target kind; it cannot prove that the plaintext encrypted by the caller matches its staged bytes or metadata. This slice covers raw legacy HD and raw original standalone photos. Signed multi-site encrypted upload, the feature-gated newer HD endpoint, JPEG XL, automatic image processing, albums, photo mentions, and key-cache reconciliation remain separate gaps. No live provider upload or send was performed for verification.

## Primary artifact evidence

The installed Zalo Desktop 26.11.10 build 26.11.10.3400 [SHARED artifact](desktop-evidence.md) has SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. The following are UTF-8 byte offsets in that member, inspected as shipped code:

| Offset | Contract |
| --- | --- |
| 1,342,661; 15,120,382 | Linear versus block encryption identifiers; only video can select block mode in the URL helper. |
| 1,330,101 | Encrypted-blob chunking retains the GCM tag in cryptography state and slices the encrypted bytes at the configured size. |
| 1,415,605 | Photo, PhotoThumb, and fixed `HD`/`normal` rendition constants. |
| 3,451,600–3,456,900 | E2EE upload parameters, chunk numbering, flags, duplicate handling, and asynchronous URL completion. |
| 3,939,238–3,942,170 | Separate raw original and legacy routes; photo staging fields and destination selection. |
| 6,975,496 | Installed `force_upload_normal: true` default. |
| 7,407,145–7,408,560 | Initial metadata construction and original-mode `is_original`; calls `sendFileAsync` with the photo flag. |
| 7,410,742–7,414,150 | Inline response URL mapping, secure-key controls, and photo variant mapping. |
| 9,119,079 | Original quality sets `skipGenThumbForPhotoE2EE`. |
| 10,608,800–10,609,834 | Separate encrypted local thumbnail upload and original preview retention. |
| 10,609,834–10,613,150 | Exact protected-field ordering, URL capsule replacement, photo version, and initial `/photo` submission. |
| 15,120,382–15,122,100 | Raw Base64 capsule stringification and suffix replacement; the SDK preserves existing ordinary locator queries. |
| 15,952,432–15,953,700 | Main/preview URL key enrichment, including original-mode main-key preview. |

Offline fixtures decrypt the account request envelope, reconstruct all uploaded ciphertext chunks, and independently open each direct/group capsule and media file with a separate receiving session. Loopback realtime fixtures cover early completion, missing originals, replacement keys, timeouts, cancellation, and closure. These establish local wire and cryptographic behavior; authenticated provider acceptance remains unmeasured.
