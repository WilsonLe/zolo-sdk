# Offline PCloud resource decryption

`createPCloudResourceDecoder` imports a caller-supplied RSA private key and opens explicitly supplied encrypted files or metadata. It performs no I/O. The application supplies the key, ciphertext, capsule and algorithm version after selecting the appropriate cloud record and checking its ownership.

```ts
import { createPCloudResourceDecoder } from 'zalo-personal-sdk';

const decoder = createPCloudResourceDecoder(privatePkcs8Der, { publicSpkiDer });
try {
  const opened = decoder.openResource(ciphertext, encryptedCapsuleBase64, algorithmVersion);
  // Version '2' has no authentication tag; the application must check provenance separately.
  await resourceStore.save(opened.plaintext);

  // Metadata has its own independently wrapped capsule, not the file capsule.
  const metadataText = decoder.openMetadata(encryptedInfoBase64, encryptedMetadataCapsuleBase64);
  // Parse and validate any application schema separately.
} finally {
  decoder.dispose();
}
```

The private key is unencrypted canonical PKCS8 DER; an optional public key is canonical SPKI DER and must match it. These are byte arrays, not PEM, Base64 text, PKCS1, certificates or a phone-transfer payload. Exact canonical re-export equality is an SDK input restriction that rejects trailing bytes and unsupported attributes/encodings. Accepted keys are ordinary RSA with a modulus from 1,024 through 8,192 bits. This range describes import compatibility, not a recommendation for creating keys. Private DER is at most 16 KiB and public DER at most 2 KiB. Inputs are copied through intrinsic byte-array access; shared-memory views are rejected. No private-key export or key-generation operation is exposed.

RSA capsules are standard Base64, either canonically padded or canonically unpadded. Whitespace, URL-safe alphabet, unused-pad-bit aliases and other malformed encodings fail. RSA ciphertext must be exactly the modulus width. Unwrapping uses RSA-OAEP with SHA-256 and an empty label. Its plaintext is the raw AES capsule bytes, not the UTF-8 spelling of Base64.

| Explicit version | Raw capsule | File operation | Result |
| --- | --- | --- | --- |
| `'1'` | Key32 + IV12 + tag16 = 60 bytes | AES-256-GCM; input ciphertext excludes the detached tag; no AAD | `algorithmVersion:'1'`, `gcmAuthenticated:true`, owned `plaintext` Buffer |
| `'2'` | Key32 + IV16 = 48 bytes | AES-256-CTR, restarted with the same key and IV for each complete 4,096-byte block; the final short tail is unchanged | `algorithmVersion:'2'`, `gcmAuthenticated:false`, owned `plaintext` Buffer |

Unknown versions fail. The decoder never substitutes a continuous CTR stream, increments the IV per block, changes an imported IV or falls back to plaintext after failure. Version 2 can return modified bytes after tampering because that format has no authentication tag. Even a short or empty version-2 file still requires a valid RSA capsule. Version 1 withholds plaintext until authentication succeeds. Empty GCM data must have a valid tag. Each file is bounded to 16 MiB; these buffer APIs do not provide large-file streaming or cache integration.

`openMetadata` accepts Base64 ciphertext of at most 2 MiB and a separate RSA-wrapped 60-byte GCM capsule. The tag belongs to that capsule and is not appended to the metadata ciphertext. It returns strict UTF-8 text, preserving text content without parsing JSON, selecting fields or trying a plaintext fallback. Empty metadata text is valid only with successful authentication.

GCM authentication establishes consistency with the supplied capsule. It does not establish a sender, account, original message, key version, retention right or authorization to fetch a URL. Anyone with the RSA public key can wrap a new capsule. Cloud HTTP ENK, viewer headers, account AES and Signal keys cannot replace this RSA private key. An optional matching public key does not prove enrollment or provider ownership.

`dispose` disables the owner and drops private key references. Owned DER, AES capsule and failed provisional plaintext buffers are wiped where held by this implementation. Node KeyObjects, immutable strings and runtime temporaries cannot be promised physical or synchronous erasure. Successful output buffers belong to the caller and remain usable after disposal. The application owns protected key storage and lifecycle.

`PCloudResourceError` returns a fresh fixed message, `code` and `stage` (`key`, `resource`, `metadata` or `state`) without raw crypto errors or a cause. Codes distinguish invalid input/key/capsule, key mismatch, bounds, RSA unwrap, GCM authentication, UTF-8, receiver and disposal failures. Unsupported inputs do not trigger retries or another key source. Methods require the exact original receiver; extracted, copied, proxied and borrowed receivers fail. Options accept only an optional own data field `publicSpkiDer`, without invoking accessors.

## Evidence and remaining integration

The implementation follows integrity-checked installed Desktop 26.11.10/build 26.11.10.3400. SHARED SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` contains P8xG RSA at 7,376,585–7,378,937, Ivja metadata at 5,706,450 onward and vPsb capsules at 15,951,262–15,954,965. ZD SHA-256 `8177c5a9a9dd7a179984316ebd429398b5262527c8f5bed662744373f24d9b06` contains the block transforms at 137,500 onward and their buffering adapter at 7,998,660 onward. MAINPROC SHA-256 `328f2d2c12101b965a738559f6e7c3e48d2e1fd0e956bef4e44fde84e2019c43` independently defines resource decryption in PGkK at 1,853,179 onward. Offsets are zero-based UTF-8 bytes. [Artifact identity](desktop-evidence.md)

Caller-owned standard keys and synthetic inputs can validate these local operations. The separate [phone/PCloud coordinator](pcloud-phone-key.md) handles explicit Signal key acquisition and durable state under its own trust contract; native phone/resource interoperability and key rotation remain unverified or incomplete. The separate [cloud ciphertext fetch](cloud-media.md#explicit-resource-ciphertext-fetch) makes one explicit viewer-protected GET for a caller-selected capsule-free transport URL and independently configured HTTPS origins, then returns an owned Buffer for `openResource`. It neither chooses the matching capsule/algorithm/key nor decrypts the bytes. Its connection-limited network budget defaults to 2 MiB and currently cannot exceed 8 MiB, while this offline decoder still accepts caller-supplied files up to 16 MiB. SDK 0.40 passed synthetic fetch/decoder composition and local HTTPS checks; native/provider resource compatibility remains unverified. This owner performs no I/O and reads no installed profile or key store. Nonunique cloud-message association, resource entitlement/retention and large-file/cache integration remain separate; full expired-message voice recovery is unfinished.
