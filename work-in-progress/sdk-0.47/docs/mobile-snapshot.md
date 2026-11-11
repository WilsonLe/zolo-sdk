# Mobile sync snapshot decoding

## Retrieve a tracker batch

`createMobileSyncSnapshotReader(control, keys, options)` opens files from one `attachMobileSyncControl` instance. Supply the original batch objects received by its `onEvent` callback. The reader checks the successful request reply and the matching phone status `4` or `5` before download. Keep early batches and retry after approval. Each read also checks that the receiver keys match the public keys used in that request.

```ts
import { createMobileSyncSnapshotReader } from 'zalo-personal-sdk';

const reader = createMobileSyncSnapshotReader(sync, {
  receiverIdentityKey,
  receiverEphemeralKey,
  senderIdentity: expectedPhoneIdentity,
}, { allowedOrigins: configuredSnapshotOrigins, signal });

try {
  for await (const { chunk } of reader.read(metadataEvent)) {
    await importChunk(chunk);
  }
  for (const event of contentEvents) {
    for await (const { chunk } of reader.read(event)) {
      await importChunk(chunk);
    }
  }
} finally {
  reader.close();
}
```

Drain a successful metadata iterator before opening content batches. The reader retains its authenticated session record only after the metadata iterator completes. It yields chunks individually so the application can decide how to persist them. If iteration fails partway through, the application can handle any chunks it already received. Read one batch at a time. Closing the reader cancels local work and clears its record. It leaves the tracker and phone transfer lifecycle to the application. Closing or cancelling the tracker also cancels pending reads.

`downloadMobileSyncSnapshotBatch(event, options)` uses the same approval, event provenance and network checks and returns the encrypted file bytes. It can be used with the offline APIs below. Both entry points require exact, separately configured HTTPS origins. The event URL, including its query, is access-bearing data. The SDK passes it unchanged to a credential-free GET, disallows redirects, and excludes the URL and transport error details from its errors. It checks the full response and caps download size at 32 MiB and duration at 60 seconds by default. Configure these with `maxDownloadBytes` and `timeoutMs` when needed. A custom `fetch` adapter is trusted to honor the same network policy.

## Open supplied bytes

Use `splitMobileSyncBatchFile(bytes)` on a separately obtained phone sync batch. The sync event identifies whether the batch is metadata-embedded or contains content. For a metadata-embedded block, pass the two receiver private keys corresponding to the identity and ephemeral public keys from the request to `decryptMobileSyncSnapshotMetadata`. Choose a sender identity policy for that block. The function verifies the signature, opens the content, and returns the sender identity and transfer's session record. For content blocks in the same transfer, pass that record to `decryptMobileSyncSnapshotBlock`. Pass the authenticated plaintext to `decodeMobileSyncSnapshotBlock` with the schema for the batch scope. [Mobile sync control](mobile-sync.md)

```ts
import {
  decodeMobileSyncSnapshotBlock,
  decryptMobileSyncSnapshotBlock,
  decryptMobileSyncSnapshotMetadata,
  splitMobileSyncBatchFile,
} from 'zalo-personal-sdk';

const { sessionRecord, plaintext: metadataPlaintext } =
  decryptMobileSyncSnapshotMetadata(metadataCiphertext, {
    receiverIdentityKey,
    receiverEphemeralKey,
    senderIdentity: expectedPhoneIdentity,
  });
const firstChunk = decodeMobileSyncSnapshotBlock(metadataPlaintext, { kind: 'message' });
await importPartitions(firstChunk.partitionsList);

for (const ciphertext of splitMobileSyncBatchFile(messageBatch)) {
  const { plaintext } = decryptMobileSyncSnapshotBlock(ciphertext, sessionRecord);
  const { partitionsList } = decodeMobileSyncSnapshotBlock(plaintext, { kind: 'message' });
  await importPartitions(partitionsList);
}
```

`kind: 'conversation'` returns `conversationsList` for the conversation schema. Both decoders accept supplied byte arrays and do no I/O. The message decoder preserves content and metadata, including quotes, mentions, and attachments. The SDK returns all protobuf 64-bit integers as decimal strings to preserve their exact values. Use `encoding: 'protobuf'` if you already decompressed the block. A Zstandard frame requires Node.js 22.15 or later on the Node 22 line. The output limit defaults to 32 MiB and can be set to at most 64 MiB. The decoder rejects incomplete frames, trailing data, and malformed protobuf. [Node.js Zstandard documentation](https://nodejs.org/docs/latest-v22.x/api/zlib.html#class-zlibzstddecompress) · [Zstandard format](https://www.rfc-editor.org/rfc/rfc8878.html)

The metadata API expects X25519 private `KeyObject`s. The matching public keys are the 33-byte Curve25519 wire keys sent as `ik` and `ek`. Desktop generates a receiver identity key locally and keeps it in memory. Callers can generate the receiver pairs with `generateE2eeX25519KeyPair`. [Mobile sync control](mobile-sync.md)

Use `senderIdentity` with an independently verified 33-byte sender wire key, including prefix `0x05`. If the file came through protected delivery for a matched, authenticated, phone-approved sync event, you can explicitly use `trustSenderIdentityFromMetadata: true` to follow Desktop's delivery trust. This mode checks the signature against the block's sender key and authenticates the payload to the request's receiver keys. Independent device identification requires the pinned key. Select one policy per call.

The session record is a secret binary value specific to a transfer. If you already have it, start with the content block API. If you already have plaintext, start with the decoder. The offline functions operate on supplied byte arrays. Verification used synthetic transfers generated and opened by the installed WASM, without accessing account content.

## Shipped wire evidence

The source is installed Zalo Desktop **26.11.10**. Worker offsets refer to zero-based bytes in `pc-dist/shared-worker.cfeba43a9a8e4e40dda3.js` (SHA-256 `6304c3fece19686a4a65d46044eca49a6df5fc1f8b4b65064ca5e728ef1aaf53`). The cryptographic implementation is `pc-dist/libs/libzproto_wasm_bg.5ea0fb2c9af4a45bc7882b71307b6f83.wasm` (SHA-256 `398a2016ede72d1e604a6ac13bc7c62f2c44a43f0c1d7b996e968427380fc739`). [Desktop evidence](desktop-evidence.md)

| Stage | Evidence |
| --- | --- |
| Retrieve file | The worker copies the matched event's `msgUrl` into the loader input at 287,158 and 300,981. Its storage wrapper passes that URL to `download({url})` at 315,450. The downloader calls `fetch(url, {signal, keepalive:true})` at 383,175 and reads the successful response as a blob at 383,434. The observed call supplies no custom authentication headers or URL rewrite. The file origin is supplied by the event. |
| Establish record | Worker `decryptChunk` at 283,172 calls the metadata decoder for `MetadataEmbedded`, resolves the record with `sessionRecord`, and returns `plaintext`. Worker 247,765 supplies the receiver identity and ephemeral private keys, omitting the optional context. The libzproto wrapper invokes `zprotoSync2DecryptMetadata` at 398,887. The Desktop `IdentityKeyManager` at bytes 4,265,230–4,266,080 in `pc-dist/compact-app-pc.cfeba43a9a8e4e40dda3.js` generates and caches the local receiver identity key pair. |
| Authenticate metadata | The libzproto protobuf fields are 1 session ID, 2 wrapped session secret, 3 signature, 4 sender identity, 5 encrypted metadata, 6 version, and 7 uint64 AAD seed. For version 1, the signature covers `0x06 0x03`, the seed in eight little-endian bytes, and the wrapped secret. The key schedule hashes three X25519 shared secrets in order, receiver ephemeral × sender identity, receiver identity × sender identity, and receiver ephemeral × sender ephemeral. HKDF-SHA256 uses an empty salt and info containing byte `0x01`, the four raw public keys in sender identity, receiver identity, receiver ephemeral, sender ephemeral order, and the first eight bytes of a seed-derived ChaCha20 stream. Rust's PCG32 expansion supplies the ChaCha20 stream key. A second HKDF uses the opened secret, the wrapped secret's first 32 bytes as salt, and `ZaloSyncKey` as info. ChaCha20-Poly1305 authenticates both payloads, with `0x01` followed by `ZaloTrustedSync` as AAD for the wrapped secret and the session ID, the second eight derived bytes, and `0x01` as AAD for the metadata content. |
| Authenticate content | Worker `decryptChunk` passes other blocks and the resolved record to the content decoder. The WASM wrapper invokes `zprotoSync2DecryptMessage` at 399,546. The exported function uses protobuf bytes field 1 for the 32-byte session ID, bytes field 2 for the 32-byte session key, and uint64 field 3 for the session AAD integer. It derives a 32-byte key with HKDF-SHA256 using the first 32 ciphertext bytes as salt and UTF-8 `ZaloSyncMsgSecure` as info. ChaCha20-Poly1305 uses the next 12 bytes as nonce and the final 16 bytes as tag. Associated data is the session ID, the AAD integer as eight little-endian bytes, byte `0x01`, and the salt. |
| Decompress | The worker calls the Zstandard stream decoder at 248,910 and performs decrypt → decompress → deserialize in the batch loader at 305,560–308,630. |
| Message protobuf | Generated readers begin at 9,246 for `Sync2.Message.SyncChunk`, 11,416 for partitions, 13,744 for messages, and 17,619–38,878 for metadata types. The loader dispatches to the message decoder in the batch pipeline. |
| Conversation protobuf | Generated readers begin at 385,629 for `Sync2.Conversation.SyncChunk` and 388,067 for individual conversations. The conversation loader uses that decoder at 316,571. |

WABT 1.0.39 disassembly placed the metadata and content decryptors at WAT lines 26,466 and 54,502. An instrumented temporary copy of the WASM exposed intermediate cryptographic values for synthetic keys. The offline fixtures were generated and verified by the original WASM. They cover session establishment and a subsequent authenticated content block, Zstandard and protobuf decoding, malformed input, and tampered signatures, keys, ciphertext and authentication tags.

The retrieval tests use loopback HTTP through a fixture adapter. They exercise matched tracker events, approval ordering, signed query preservation, cancellation, size limits, and authenticated decoding of the WASM-generated files. A live provider origin and a complete phone-approved transfer remain unverified.
