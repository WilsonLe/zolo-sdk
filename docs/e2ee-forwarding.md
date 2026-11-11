# Prepared encrypted forwarding

`forwardPreparedE2eeDirect` and `forwardPreparedE2eeGroup` forward nine established content forms using the installed Desktop's encrypted forwarding route. A closed content union selects the wire fields and message type. Contacts use the existing [contact forwarding helpers](e2ee-content.md).

```ts
import { forwardPreparedE2eeDirect } from 'zalo-personal-sdk/e2ee';

const content = {
  kind: 'text' as const,
  message: conversation.encrypt('Forwarded text'),
  forwardRefLog: conversation.encrypt(JSON.stringify(originalForwardReference)),
};
await savePreparedForward(content);
const result = await forwardPreparedE2eeDirect(api, {
  threadId: recipientId,
  clientId: nextClientId(),
  senderRegistrationId,
  recipients: [{
    userId: recipientId,
    deviceId: 0,
    registrationId: recipientRegistrationId,
    content,
  }],
});
```

Use an authenticated direct conversation or established group sender key to prepare every protected field independently. `savePreparedForward` and `nextClientId` stand for application-owned persistence and action-ID allocation. Save the advanced ratchet and the exact prepared submission before sending. Direct recipients must all prepare the same content kind, with independent ciphertext for each device and any sender subdevices.

Both routes use `/api/e2ee/pc/{message,group}/forward`. Direct requests use `chat_e2e` with the standard per-device `listParams`, destination type 3 and thread/client IDs. Groups use `group_e2e` with one sender-key record, group ID and `visibility`, defaulting to 0. Each record carries a serialized `msgInfo`, TTL, version 0/compatibility version 0, and the installed untracked-source fallback `zsource:-1`. Contact forwarding retains its separate version 1 selector.

## Content forms

Each ciphertext property below is a complete prepared Zalo frame. Empty optional fields follow the shipped empty-string form. The type numbers are fixed internally.

| Kind | `msgType` | Protected fields | Additional provider-visible metadata |
| --- | --- | --- | --- |
| `file` | 1 | Capsule keys, `fileName`, `parameters` → `prmE2EE` | `fileSize` → `size`, extension and optional MD5 checksum |
| `photo` | 2 | Capsule keys, optional title, `parameters` → `prmE2EE` | Original message ID → `photoId`, optional dimensions and original JSON properties |
| `voice` | 3 | Capsule key and JSON parameters | Optional ordinary alternate m4a locator |
| `gif` | 4 | Complete original/thumbnail/HD URLs, caption and JSON parameters | Optional dimensions and fixed `recommend.gif` action |
| `video` | 5 | Capsule keys, optional title and JSON parameters | Duration, optional dimensions, file size and rotation |
| `location` | 7 | Optional title/description and JSON parameters | Coordinates, optional place ID and the installed empty app ID |
| `text` | 8 | Text, optional style JSON and optional parameter JSON | Rich-text action/placement markers |
| `sticker` | 9 | Sticker ID, category ID, type and optional extension JSON | Extension wrapper structure |
| `link` | 10 | Complete URL, title, thumbnail, description, caption and parameter JSON | Link type, default 0 |

The clear metadata above is visible to the provider after it opens the account transport envelope. In particular, location forwarding preserves the source's clear latitude/longitude alongside the encrypted location parameters. Each helper validates those clear values separately from the prepared content frames.

Plain text uses `message: frame`. Rich text uses `message:{title:frame,styles:frame}`. By default, the wire message is `{action:'rtf',title,params:styles}`. Set `stylePlacement:'rtfProps'` inside that object for the other observed form, which places the text frame in `message` and its style frame in `rtfProps`. Optional text `parameters` encrypts the original `paramsExt` JSON and becomes `prmE2EE`.

File `parameters` encrypts JSON with the original `checksum`, `fileExt`, `fileSize`, and optional `checksumSha`, `fdata` and `fType`. Normalize the original filename with JavaScript `normalize()` before encrypting `fileName`, matching the shipped filename formatter. Photo parameters describe dimensions and optional image metadata such as `hd`; the ordinary photo helper additionally requires independent original and thumbnail capsule frames. Voice parameters encrypt JSON containing an optional `m4a` URL. Video parameters use the source keys `video_width`, `video_height`, `duration`, `fileSize`, and `video_rotation`. GIF parameters contain width and height. Location parameters contain `latitude`, `longitude`, `placeId`, `isUserLocation:0`, and `srcId:0`. The caller prepares these original metadata values before encryption.

Sticker fields use the four-byte little-endian encoding from `encodeE2eeStickerNumber`. Forwarded stickers use wire names `emoId,catId,type`. A supplied encrypted extension appears in both `prmE2EE` and serialized `extInfo:{params:frame}`. A link's parameter frame likewise appears in both `extData` and `prmE2EE`. These aliases reuse the same authenticated bytes rather than consuming the frame again during receive processing.

This helper covers ordinary standalone uploaded photos and media. Photo/AI sticker variants, album skeleton/layout reconstruction, folder-specific records and automatic clone/re-upload paths have additional contracts.

## Media capsules

Files, uploaded photos, voices and videos use a provider locator plus a protected key capsule. For each variant, supply `{url,key}`. `url` is its HTTPS locator with the original `e2esession` capsule removed; `key` is an independently encrypted copy of the original capsule material. Existing public query bytes are preserved. A locator containing an existing capsule, credentials or a fragment is rejected.

```ts
const photoContent = {
  kind: 'photo' as const,
  originalMessageId,
  original: { url: originalLocator, key: conversation.encrypt(originalCapsuleMaterial) },
  thumbnail: { url: thumbnailLocator, key: conversation.encrypt(thumbnailCapsuleMaterial) },
  parameters: conversation.encrypt(JSON.stringify(originalPhotoParameters)),
};
```

Prepare the thumbnail key independently even when it uses the same locator and key material as the original. The helper does not substitute one ratchet frame for another media variant. Raw Base64 `+` and `/` in the resulting ciphertext are preserved in the `e2esession` query value.

The installed capsule extractor takes the suffix beginning after `e2esession=` through the end of the query. For original capsules with a trailing version marker, retain that marker inside the plaintext capsule material before encrypting it. The forwarding helper treats these bytes as opaque and leaves their interpretation to the original media format. Catalog GIFs and links use encrypted complete URLs instead of this capsule form.

## Forwarding reference

A supplied `forwardRefLog` is one independently encrypted JSON field. The installed sender appends that JSON to its encryption input, removes the temporary encrypted `forwardRefLog` property from the rebuilt content, then stores a serialized reference string inside `msgInfo`.

```ts
msgInfo.reference = JSON.stringify({ type: 3, data: encryptedForwardRefLog });
```

The new helpers accept only a prepared frame for `forwardRefLog`. The original provenance JSON remains inside that frame. An omitted log produces no invented reference. The helper leaves plaintext decoration telemetry and automatic provenance construction to the application.

The shipped GIF rebuild assigns the encrypted caption to the original source object while returning an earlier object copy. That can retain the original caption or a previous recipient's caption ciphertext in the returned record. This implementation assigns `msg` directly from each recipient's supplied caption frame. A two-device fixture verifies distinct caption ciphertext reaches the intended peer.

## Evidence and verification

The source is the installed 26.11.10 [SHARED member](desktop-evidence.md), SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. Zero-based UTF-8 byte offsets are plaintext extraction 10,613,152, encrypted rebuild 10,616,898, per-kind version selection 10,619,269, encrypted forwarding dispatch 10,620,527, common transformation 12,458,543, media capsule extraction/replacement 15,120,408–15,120,741, and reference envelope construction 16,788,599. Forward type constants are at 1,531,172; reference type 3 is defined in `Ubns` near 9,130,934.

Five focused fixtures exercise all eighteen direct/group combinations, open each protected field with a separate peer session or group receiver, and assert exact routing/type/version records. They also cover both rich-text forms, independently prepared GIF captions, nested encrypted references, raw-key/plaintext rejection and unavailable encrypted services. Existing content, text and media tests verify the shared selector changes preserve those routes. No live forwarding request has been made; provider acceptance remains unmeasured.
