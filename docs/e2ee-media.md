# Prepared encrypted GIFs and photos

Generic files also have a staged ciphertext upload and final send flow. [Encrypted file upload and delivery](e2ee-file-upload.md)

For initial uploaded photos, `uploadE2eePhoto()` stages caller-encrypted legacy HD or original bytes, and `sendPreparedE2eeDirectPhoto()` / `sendPreparedE2eeGroupPhoto()` deliver the protected photo record. [Encrypted photo upload and delivery](e2ee-photo-upload.md)

The E2EE package exposes `sendPreparedE2eeDirectGif()`, `sendPreparedE2eeGroupGif()`, `sendPreparedE2eeDirectPhotoByUrl()`, and `sendPreparedE2eeGroupPhotoByUrl()`. The GIF helpers use the catalog GIF path. The photo helpers use the photo-by-URL path. Each nonempty protected field must be a separate frame from the authenticated pairwise ratchet for the recipient device or the established group sender key. The SDK validates frame structure and selects the matching encrypted service.

| Prepared field | GIF | Photo by URL |
| --- | --- | --- |
| `url` | Encrypt the original GIF URL. | Encrypt the original photo URL. |
| `thumbnail` | Encrypt the preview URL if present. | Encrypt the preview URL if present. |
| `parameters` | Encrypt the JSON string with `width` and `height`. | Encrypt the JSON string with `width`, `height`, and `hd` when there is an HD URL. |
| `title` | The wire record uses a blank message. | Encrypt the title if present. |

GIF width, height, and recommendation source are visible in the encrypted service record after account decryption. Catalog and photo URLs are encrypted in the message fields. To store and distribute private bytes, use a compatible encrypted upload and publish flow.

```ts
import { sendPreparedE2eeDirectGif } from 'zalo-personal-sdk/e2ee';

const recipient = {
  userId: peerId,
  deviceId: peerDevice,
  registrationId: conversation.remoteRegistrationId,
  url: conversation.encrypt(originalUrl),
  parameters: conversation.encrypt(JSON.stringify({ width, height })),
  ...(previewUrl && { thumbnail: conversation.encrypt(previewUrl) }),
};

const prepared = {
  threadId: peerId,
  clientId,
  senderRegistrationId: conversation.localRegistrationId,
  width,
  height,
  recipients: [recipient],
};

await persistPreparedSubmission(conversation.sealState(wrappingKey), prepared);
await sendPreparedE2eeDirectGif(api, prepared);
```

The example prepares one device. Include a separately encrypted record for every recipient and sender subdevice selected by your application. Persist the exact prepared fields and advanced ratchet together before sending. Reuse that submission on retry. An endpoint acknowledgment confirms the send request, with delivery tracked separately.

## Linear encrypted file bytes

`sealE2eeMediaFile(bytes)` returns raw ciphertext and a sensitive `fileKey` string. The file is AES-256-GCM ciphertext with a detached authentication tag. The standard Base64 `e2esession` material encodes the 32-byte key, 12-byte IV, and 16-byte tag in that order. Give `openE2eeMediaFile(ciphertext, fileKey)` key material obtained from an authenticated message. It authenticates the ciphertext before returning bytes. Both helpers accept 1 byte through 16 MiB. Keep the raw file key inside the encrypted conversation and out of upload URLs and logs.

The desktop uploaded-photo flow keeps the CDN locator visible and replaces its `e2esession` value with a ratchet-encrypted key frame. The URL-based transport above instead encrypts the URL field. The file helpers provide the linear byte format accepted by `uploadE2eePhoto()` and the encrypted file uploader. Applications retain the raw media key separately and deliver it through an authenticated ratchet.

The separate main-package [PCloud decoder](pcloud-resource.md) can RSA-unwrap a cloud capsule and reuse this linear file format. It also supports the explicit cloud block-CTR format with an unauthenticated result. It does not obtain an E2EE key from a conversation, and the existing E2EE helpers retain their nonempty 16 MiB limit and public behavior.

## Installed evidence

The offsets are in the integrity-checked desktop SHARED member. [Installed artifact identity](desktop-evidence.md)

| Part | Shipped behavior |
| --- | --- |
| Routes | Direct GIF/photo use `chat_e2e` and command IDs 16011/16004. Group GIF/photo use `group_e2e` and command IDs 16113/16104. SHARED 2,678,006–2,678,761. |
| GIF | The catalog flow encrypts original URL, dimension JSON, and preview URL separately. The record uses `href`, `prmE2EE`, `thumb`, visible dimensions, `msg: ""`, `type: 0`, `src`, and `action: "recommend.gif"`. SHARED 1,554,399, 5,291,279, 10,604,096–10,605,820, and 11,986,789. |
| URL photo | Encrypts title, original URL, preview URL, and photo parameter JSON separately. It puts the original URL in `normalUrl` for direct and `oriUrl` for group. SHARED 10,622,908–10,625,279. |
| Submission | Direct serializes per-device records as `listParams` and supplies `destType:3`, `threadId`, and `clientId`. Group sends one record with `grid` and `clientId`. The wrapper uses account AES on the form. SHARED 10,592,734–10,593,562 and 12,450,628. |
| Linear file | The desktop cipher calls native AES-GCM and stores the tag separately. The key serializer concatenates key, IV, and tag. Uploaded photo records replace each media URL's file key with a ratchet frame. SHARED 2,973,780, 6,625,579, 10,609,800–10,611,532, 15,120,300–15,121,227, and 15,951,773–15,953,071. |

Offline fixtures verify all four request records and peer-side decryption of the protected fields. The file fixture checks a fixed AES-GCM vector and opens SDK output with Web Crypto. Provider media delivery and raw ciphertext upload require separate live verification.
