# Prepared encrypted content

The content helpers submit links, stickers, contacts, text quotes, and group mentions using the installed Desktop's E2EE field layouts. Direct submissions contain separately prepared ciphertext for each recipient device. Group submissions use an established group sender key. Each separately prepared field consumes a ratchet message. The link title fallback can reuse its URL frame.

```ts
import { sendPreparedE2eeDirectLink } from 'zalo-personal-sdk/e2ee';

const recipient = {
  userId: recipientId,
  deviceId: 0 as const,
  registrationId: recipientRegistrationId,
  message: conversation.encrypt('Read this article'),
  url: conversation.encrypt(articleUrl),
  source: conversation.encrypt(articleUrl),
  title: conversation.encrypt(articleTitle),
  description: conversation.encrypt(articleDescription),
  thumbnail: conversation.encrypt(thumbnailUrl),
  parameters: conversation.encrypt(JSON.stringify({
    mediaTitle: articleTitle,
    src: articleUrl,
  })),
};
// Persist the advanced ratchet and the prepared submission before posting it.
await savePreparedSubmission(recipient);
const result = await sendPreparedE2eeDirectLink(api, {
  threadId: recipientId,
  clientId: nextClientId(),
  senderRegistrationId,
  recipients: [recipient],
});
```

`conversation` is a previously authenticated direct conversation. Supply the intended recipient devices and any sender subdevices. `savePreparedSubmission` and `nextClientId` stand for application-owned persistence and action-ID allocation. The existing [E2EE guide](e2ee.md) describes identity verification, registration, ratchet persistence, and device selection.

All helpers validate the prepared Zalo frames and target kind. The caller supplies authenticated sessions, correct plaintext encodings, and the intended encrypted content. Provider acceptance and full account interoperability remain unmeasured for these additions.

## Operations and routes

| Helpers | Encrypted route suffix | Message version | Additional wire details |
| --- | --- | --- | --- |
| `sendPreparedE2eeDirectLink`, `sendPreparedE2eeGroupLink` | `link` | 0 | `msg,href,src,title,desc,thumb,prmE2EE` hold separate frames. `type` is the clear `linkType`, default 0. |
| `sendPreparedE2eeDirectSticker`, `sendPreparedE2eeGroupSticker` | `sticker` | 0 | `stickerId,cateId,type` hold separate numeric frames. Optional extension is `extInfo:{params:frame}` serialized as JSON. |
| `forwardPreparedE2eeDirectContact`, `forwardPreparedE2eeGroupContact` | `forward` | 1 | Top-level `msgType:6`. Serialized `msgInfo` contains separately protected `title,thumb,desc,href` and fixed action `recommened.user`. |
| `sendPreparedE2eeDirectOaContact`, `sendPreparedE2eeGroupOaContact` | `contact` | 1 | Separately protected `title,thumb,desc,href`, with fixed action `recommened.vip`. |
| `sendPreparedE2eeDirectQuote`, `sendPreparedE2eeGroupQuote` | `quote` | 0 | Confirmed text originals use clear `qmsgType:1`. Reply text, quote text, sender name, and sender global identifier are independently protected. |
| `sendPreparedE2eeGroupMention` | `mention` | 0 | Separate message, optional styles, and a frame for every mentioned global identifier. |

Direct requests use the `chat_e2e` service and `/api/e2ee/pc/message/` prefix. Their encrypted account envelope contains `listParams`, `destType:3`, `threadId`, and `clientId`. Each recipient record has `toId`, `platform`, TTL, and E2EE version/registration metadata. Group requests use `group_e2e` and `/api/e2ee/pc/group/`, with one sender-key record and the group ID. Compatibility version is 0 for all operations above.

Group sticker, contact forwarding, quote, and mention submissions accept `visibility`, defaulting to 0. The shipped group link and OA contact builders omit that field. Both sticker modes also include `clientId` inside the record. The shared delivery layer retains the existing acknowledgment handling and lossless message-ID parsing. These helpers submit once and disable HTTP redirects.

## Plaintext encodings before preparation

Link `parameters` encrypts the original link parameter JSON, including `mediaTitle`, `src`, and any known media metadata. The other populated link fields each use their own frame. Empty optional fields can be omitted or passed as an empty string. The installed builder substitutes the encrypted URL when the separate title is empty.

Sticker numbers use four-byte signed little-endian encoding. `encodeE2eeStickerNumber` produces the plaintext bytes for one field, accepting the signed 32-bit range.

```ts
import { encodeE2eeStickerNumber, sendPreparedE2eeGroupSticker } from 'zalo-personal-sdk/e2ee';

await sendPreparedE2eeGroupSticker(api, {
  groupId,
  clientId: nextClientId(),
  stickerId: sender.encrypt(encodeE2eeStickerNumber(stickerId)),
  categoryId: sender.encrypt(encodeE2eeStickerNumber(categoryId)),
  stickerType: sender.encrypt(encodeE2eeStickerNumber(stickerType)),
  extension: sender.encrypt(JSON.stringify(stickerExtension)),
});
```

A user-contact `description` encrypts JSON with `gUid` and optional `phone` and `qrCodeUrl`. An OA contact description encrypts JSON with `gUid`, optional `qrCodeUrl`, and optional `oaShortLink`. `gUid` is the provider's global identifier for that contact. Obtain it from verified provider metadata or an established mapping. Prepare `title`, `thumbnail`, and `url` separately. The ordinary-contact helpers construct the fixed forwarding record and version metadata internally.

Mention records supply `position` and `length` in JavaScript UTF-16 code units after applying the intended display names. The length includes the at-sign. `kind:'user'` maps to wire type 0 and `kind:'all'` maps to type 1. The `globalId` property contains a separately encrypted global identifier, including the string `-1` for an all-mention. These ranges and type remain clear; the global identifier is protected. The API preserves mention order and rejects missing, invalid, or wrong-target identifier frames. Group link and quote operations can carry the same mention records.

Text quotes keep the original provider message ID, original client message ID, timestamp, and auto-delete duration in `quote`. IDs support decimal strings to retain exact large values. `message`, `quotedMessage`, `ownerGlobalId`, optional `ownerName`, and optional `textProperties` each contain a prepared frame. Group quotes additionally require `attachment`, encrypting the source attachment JSON, including `{}` for a plain empty attachment. Group requests preserve both observed timestamp spellings, `qmsgTS` and `qmsgTs`. `quote.ttl` becomes `qmsgTTL`; the outer TTL describes the new reply. This helper covers confirmed text originals. Media quotes and partial selection quotes have additional contracts.

## Evidence and verification

The source is the installed Zalo 26.11.10 [SHARED member](desktop-evidence.md), SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. The zero-based UTF-8 byte offsets are mention send 10,593,922, quote send 10,599,074, link send 10,601,613, sticker send 10,606,516, user-contact extraction 10,613,152 and rebuild 10,616,898, OA contact send 10,621,806, common E2EE submission 12,450,580, and quote transformation 12,453,928. The numeric field encoder is at 3,592,902. Version constants are at 3,278,218.

The fixtures decrypt the account envelope, assert the separate operation records, and open each protected field with a separate direct peer or group receiver. They cover every helper, fixed little-endian numeric vectors, contact version 1, group-only fields, mention offsets, large quote identifiers, malformed/plaintext inputs, unavailable encrypted services, and provider rejection. Existing prepared text and media fixtures verify the shared delivery selector preserves those operations.
