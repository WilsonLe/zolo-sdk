# Receiving encrypted structured content

`extractE2eeContentEvents(frame)` reads incoming photos, files, GIFs, links, contacts, stickers, locations, voice, video, and doodles. Use it with the same realtime feed or supplied offline message frames as `extractE2eeTextEvents`. It returns provider routing fields, a content kind, and protected nonempty fields in the installed receiver's decryption order.

```ts
import { extractE2eeContentEvents } from 'zalo-personal-sdk/e2ee';

feed.subscribe((frame) => {
  for (const event of extractE2eeContentEvents(frame)) {
    applicationQueuesEncryptedContent(event);
  }
});
```

The application resolves an authenticated direct session or group sender key using the event's routing metadata. Authenticate each field's `ciphertext` before using its plaintext. Fields marked `utf8` hold text or JSON. Sticker IDs, category IDs and types use four-byte signed little-endian integers, marked `int32-le`. Uploaded-media capsules use `media-key`, whose plaintext supplies the key for the encrypted file format. Blank fields are omitted from `fields` and remain in `raw`.

Zalo can reuse a ciphertext across fields, such as a link's URL and fallback title. `duplicateOf` names the earlier field in this record with identical frame bytes. After authenticating that earlier field, reuse its bytes for the duplicate. Each unique frame is decrypted once. Keep this cache within one record so later replayed messages still fail the ratchet's replay checks.

A `media-key` field also includes `mediaUrl`, the provider locator with `e2esession` removed. Raw Base64 `+`, `/`, and `=` characters in capsules are preserved. The locator and other clear routing fields remain unauthenticated metadata. The application applies its origin policy before downloading and authenticates downloaded bytes using the recovered key. The extractor performs no network I/O or ratchet updates. Record cryptographic progress and plaintext through the application's existing outbox/inbox and session persistence policy.

## Provider receive fields

| Kind | Provider message type | Receiver order |
| --- | --- | --- |
| Photo | `chat.photo` or 2 | `content.href`, `params`, `thumb`, `title`, `description`, mention `gUid` fields, reference. `href` and `thumb` can be direct ciphertext or uploaded-media capsules. |
| File | `share.file` or 19 | `content.href` capsule, `params`, URI-encoded `title`, `thumb` capsule, `description`, `type`, reference. |
| GIF | `chat.gif` or 7 | URI-encoded `content.href`, `params`, `title`, `thumb`, `description`, `type`, reference. |
| Link | `chat.recommended` or 6 with `recommened.link` | URI-encoded `content.href`, `params`, `title`, `thumb`, `description`, `type`, mention `gUid` fields, reference. A preview thumbnail may carry a media-key capsule. |
| User contact | `chat.recommended` or 6 with `recommened.user` | `content.title`, `thumb`, `description`, `href`, reference. |
| OA or sticker-set contact | `chat.recommended` or 6 with `recommened.vip` or `recommened.stickerset` | `content.title`, `thumb`, `href`, `description`, reference. |
| Sticker | `chat.sticker` or 4 | Binary `content.id`, `catId`, `type`, then optional `content.extInfo.params` and reference. `extInfo` can be provider JSON. |
| Location | `chat.location.new` or 17 | `content.description`, `params`, `title`, reference. |
| Voice | `chat.voice` or 3 | `content.href` capsule, `params`, reference. |
| Video | `chat.video.msg` or 18 | `content.href` capsule, `params`, `thumb` capsule, optional `title`, reference. |
| Doodle | `chat.doodle` or 5 | `content.href` capsule, `params`, reference. |

The SDK checks frame structure and direct/group kind. This establishes a candidate encrypted event. Authentication belongs to the established ratchet. Invalid primary frames, malformed nonempty protected fields, ambiguous capsules, and mixed direct/group frames cause the record to be omitted. Existing text extraction keeps its public contract and shares the same routing parser.

The installed Zalo 26.11.10 SHARED member contains `extractTextContentFromServer` at byte 5,299,028, reconstruction near 5,314,500, message constants at 1,529,782, type normalization at 862,387, and capsule parsing/stringification at 15,120,408–15,121,700. Online/offline message batches enter the decryptor near 12,595,984. Synthetic direct and group fixtures authenticate the extracted fields using independent peer receivers. Provider receive interoperability remains unverified. [Desktop artifact identity](desktop-evidence.md)
