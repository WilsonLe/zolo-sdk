# Encrypted file upload and delivery

`prepareE2eeFile(bytes, fileName)` seals 1 byte through 16 MiB using the linear AES-256-GCM format. It returns ciphertext plus the raw file key, original filename, and file metadata JSON. Keep those three message fields in protected storage until they are independently encrypted with each recipient device's ratchet or the group sender key.

This flow handles generic files with `fType:1` and no thumbnail. Photo renditions, thumbnail upload, and the block-based video format need their own upload contracts.

`uploadE2eeFile()` uploads ciphertext in sequence and returns an account and destination descriptor. Its visible upload filename defaults to `encrypted.bin`. Supply `uploadFileName` if your application needs another visible upload name. The original filename from preparation is delivered inside its encrypted message field. The default chunk size is 256,000 bytes. The advertised integer `sharefile.chunk_size_file` applies when it is at least 64,000 bytes, up to the SDK multipart bound.

```ts
import {
  prepareE2eeFile, uploadE2eeFile, sendPreparedE2eeDirectFile,
} from 'zalo-personal-sdk/e2ee';

const file = prepareE2eeFile(bytes, 'report.pdf');
await storeFilePreparationSecurely(file, clientId);

const uploaded = await uploadE2eeFile(api, {
  threadType: 'user', threadId: peerId, clientId,
  ciphertext: file.ciphertext, feed, signal,
});
await storeUploadDescriptor(uploaded);

const recipient = {
  userId: peerId,
  deviceId: peerDevice,
  registrationId: conversation.remoteRegistrationId,
  fileKey: conversation.encrypt(file.fileKey),
  fileName: conversation.encrypt(file.fileName),
  parameters: conversation.encrypt(file.parameters),
};
const submission = {
  uploaded,
  senderRegistrationId: conversation.localRegistrationId,
  recipients: [recipient],
};
await storeSubmissionAndRatchet(submission, conversation.sealState(wrappingKey));
await sendPreparedE2eeDirectFile(api, submission);
```

For group delivery, encrypt the same three fields with `E2eeGroupSender` and pass them with the group upload descriptor to `sendPreparedE2eeGroupFile()`. Direct sends need an independently encrypted record for every intended peer and sender subdevice. Save the exact prepared fields and advanced ratchet together before delivery. A retry uses the same prepared submission ID and ciphertext.

The final record contains the CDN file locator followed by `e2esession` holding the encrypted file-key frame. Treat that URL and the whole prepared submission as private. Parse the capsule as raw query text when opening it, preserving Base64 `+`, `/`, and `=` bytes. The receiver authenticates the capsule with its ratchet, then passes the resulting raw key material and downloaded ciphertext to `openE2eeMediaFile()`.

## Completion and failure recovery

A successful upload can return an inline URL, or it can return a file ID and finish flag before a `file_done` control supplies the URL. Pass a matching `startRealtimeFrameFeed()` when deferred completion is possible. The observer attaches before HTTP submission and buffers early controls. It correlates commands 601 and 603 by exact file ID. The default completion timeout is 120 seconds.

`E2eeFileUploadError` reports the last confirmed `acceptedChunks`, any known `fileId`, and a provider code when available. `submission-unknown` means the last HTTP operation may have succeeded. A duplicate-upload response requires reconciliation with the original ciphertext and key. Keep the prepared bytes and metadata when reconciling either result. The operation submits each chunk once. Cancellation during a request can produce an uncertain result, while cancellation between requests reports the confirmed progress.

The upload descriptor can be serialized and used with a resumed API for the same account and destination. Store it in your application's protected record. It carries the file locator and routing fields. The raw file key remains in the separately protected preparation. An endpoint acknowledgment confirms submission. Account-to-account delivery requires separate receipt evidence.

## Installed evidence

The source is the integrity-checked Zalo Desktop 26.11.10 SHARED member, also represented in the cached Web startup source. [Artifact identity](desktop-evidence.md)

| Part | Shipped contract |
| --- | --- |
| Encrypted chunks | `buildSendChunksInfo` sets `isE2EE:1`, removes `checksum`, and sends `totalChunk`, upload `fileName`, `clientId`, `totalSize`, `imei`, chunk index, and `toid` or `grid`. Multipart field `chunkContent` contains the encrypted bytes. SHARED 3,451,550–3,453,690. |
| Endpoint | Service `file`, `/api/message/asyncfile/upload` with query `type=2`, or `/api/group/asyncfile/upload` with `type=11`. The metadata is account-encrypted in query `params`. SHARED 3,940,347–3,940,655. |
| Completion | HTTP inner code 0 plus `finished` and `fileId` marks completion. The URL can arrive through `file_done`, whose content has `fileId` and `data.url`. The uploader can also resolve an inline `data.url`. SHARED 3,453,690–3,456,732, 7,410,488–7,413,734, and 12,023,860–12,024,472. |
| File metadata | The separately encrypted parameter JSON contains `fileSize`, plaintext MD5, `checksumSha`, `fileExt`, and `fType:1` for a normal file. The extension helper preserves its case and omits extensions of seven or more characters. SHARED 1,530,067, 7,407,140–7,410,309, and 16,730,006. |
| Final record | Key capsule, optional thumbnail key, metadata JSON, filename, and optional thumbnail metadata are independently ratchet-encrypted. The record keeps `fileId`, replaces the URL key capsule, and removes plaintext checksum, size, extension, and type fields. Direct command 16005 and group command 16105 use `/api/e2ee/pc/message/file` and `/api/e2ee/pc/group/file`. SHARED 10,610,400–10,613,129. |
| URL capsule | `stringifyUrl` appends a literal query value and `updateBase64KeyEncrypt` replaces its raw value without percent encoding. The receiver extracts the raw query with a regular expression. SHARED 15,120,741–15,122,100. |

Synthetic fixtures cover upload chunks, direct and group message fields, independent peer decryption of the resulting file, early and deferred completion, cancellation, timeout, feed closure, duplicates, and uncertain partial upload. Provider upload acceptance and peer interoperability require controlled live verification.
