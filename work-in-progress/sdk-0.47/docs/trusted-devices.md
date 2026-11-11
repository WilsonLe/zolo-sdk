# Trusted device lists

`getRawTrustedDeviceList(api, { signal })` retrieves the signed linked-device payload from the account's authenticated service. `parseRawTrustedDeviceList(value)` qualifies an existing decrypted payload or its JSON string. The outer `devices` value contains one primary record with a `companions` array. The SDK retains decimal `linkId` strings, including values above JavaScript's safe integer range. The raw helpers validate the wire shape and leave signature verification to the caller.

```ts
import { getRawTrustedDeviceList, verifyTrustedDeviceList } from 'zalo-personal-sdk';

const raw = await getRawTrustedDeviceList(api, { signal });
const result = verifyTrustedDeviceList(raw, {
  primaryIdentityKey: knownPrimaryIdentity,
  companionIdentityKey: knownLocalCompanionIdentity,
});

if (result.isTrusted) {
  await updateDeviceDisplay(result.list.devices.companions);
}
```

Supply the primary identity independently of the response, typically from a previously authenticated pairing. Identity pins use 33-byte Zalo Curve25519 wire keys. The offline verifier checks the primary identity, the signature over the list, and the list's 21-day lifetime. With a companion pin, it also requires a matching row, verifies that row's device signature, and rejects a stale companion past its expiration. The companion signature and expiry checks apply only to the pinned companion. The list signature covers the account-signature bytes.

Omit `companionIdentityKey` to verify the primary-signed list alone. For deterministic verification or a trusted synchronized clock, pass `nowMs` in Unix milliseconds. The result distinguishes identity mismatch, invalid signatures, and expiry. Malformed payloads raise `ZaloProtocolError`. The verifier rejects duplicate companion IDs to avoid ambiguity in the returned records. The observed WASM list format supports Web and desktop companion platforms and stale and active statuses.

## Installed Desktop evidence

These findings use installed Zalo Desktop **26.11.10**. Offsets are zero-based archive member bytes unless identified as WAT lines. [Desktop evidence](desktop-evidence.md)

| Stage | Evidence |
| --- | --- |
| Retrieval | SHARED bytes 12,537,998 and 14,299,597 use `GET /api/devices/linked` on the `aext` service with encrypted JSON `{imei}`. The consumer decodes the account AES envelope and selects successful inner data. |
| Qualification | `pc-dist/lazy/default-login-startup-main-startup.11118829a9fb1767bf46.js` at 57,120 reads `devices.{masterId,encIdentity,lastUpdateTs,encSignature,companions}`. Each companion has `id,linkId,encIdentity,platform,status,expireTs,encAccSign,encDeviceSign`. `pc-dist/lazy/main-startup.89bb530b91927fd5dd28.js` at 2,003,293 accepts an object or JSON string and at 2,024,625 passes the qualified list, local primary and companion identities, and verification time to the trust protocol. |
| WASM bridge | `pc-dist/trust-worker.cfeba43a9a8e4e40dda3.js` invokes `zprotoTrustVerifyDeviceListFromStruct` at 101,877 and its cached-byte counterpart at 101,187. The worker SHA-256 is `f647cc926a90750b61158ef26fec4a846ea97e9d5fe641785c50e0910b048acc`. The binary is `pc-dist/libs/trusted_device_protocol_bg.97af2bf51fb002cefc5a888e932bcab2.wasm` with SHA-256 `716f0a0637e5b64168010899f4ad380be7d0c6a67778137c88ecb2ff9d9e49da`. |
| List signature | Legacy Curve25519 verifies `L3` followed by UTF-8 master ID, the primary wire key, the update timestamp as LE64, and serialized `CompanionDataProto`. Its repeated field 1 contains rows sorted by numeric companion ID. Row fields 1 through 8 are the ID, identity, link ID, platform, status, account signature, device signature, and expiry. The signed enum values for Web and desktop are 0 and 1. WAT lines 82,837–83,344 trace the signature input. |
| Companion signature | Legacy Curve25519 verifies `D2` followed by `LinkingMetadataProto`, the companion wire key, and the primary wire key. Metadata fields 1 through 6 are master ID, primary identity, companion identity, companion ID, link ID, and platform. WAT lines 63,255–63,885 trace the signature input. |
| Time and presence checks | The struct verifier checks the primary key and list signature, then checks a supplied companion pin and its stale expiry before checking the 21-day list lifetime. A deadline remains valid at equality. WAT lines 14,390–14,584, 124,948, and 126,018. |

The tests use signatures produced with synthetic keys and verified against the stock shipped WASM, including an active desktop companion, a stale Web companion, an empty list, a signed list with an invalid companion signature, and reordered companion IDs. The WASM import harness used only synthetic memory and fixture data. SDK tests run with Node crypto alone. Live interoperability with paired account keys remains unverified.

## Passive updates and parser boundary

[`extractTrustedDeviceListEvents`](trusted-device-events.md) qualifies the installed ordinary `user_devices/update_user_devices` controls without starting a listener or authenticating a device. Its optional readonly list can be passed directly to `verifyTrustedDeviceList` with independently trusted pins. Raw event wrappers retain provider extensions and the unsigned control timestamp; signed `devices.lastUpdateTs` remains distinct. Applications own replacement, recovery and expiry policy. A missing or invalid list does not trigger revocation, logout, enrollment or an HTTP request.

The shared raw parser captures selected own data fields and dense companion indices without invoking getters, inherited values, `toJSON` or custom array iterators. Unknown fields are omitted from its known-field copy. Missing/null companions still produce an empty list; required fields, uint64 decimal values and companion order retain their existing rules. Each list admits at most 256 companions. JSON input is bounded to 1,048,576 UTF-8 bytes, with a cheap code-unit precheck; custom object input has bounded selected field/array work rather than recursive unknown-object sizing. Malformed selected fields and descriptor/proxy exceptions produce the fixed `ZaloProtocolError('invalid-response')`. The standalone raw parser still returns an owned mutable known-field copy; the passive extractor freezes its own result separately.
