# Trusted-device pairing

`createTrustedDevicePairing()` prepares one caller-managed trusted-device QR attempt. Its default creates a fresh companion and a 32-byte linking secret. Explicit `relink` reuses a caller-retained companion, original secret and verified historical evidence. The caller supplies the challenge, renders QR text, polls scan/approval and stores accepted state. No installed account record or key is imported. [Complete retained login and recovery](desktop-relink.md)

```ts
import { createTrustedDevicePairing } from 'zalo-personal-sdk';

const pairing = createTrustedDevicePairing();
try {
  const qrText = pairing.createQr(desktopChallenge.token_id);
  const scan = await renderAndPollDesktopScan(qrText, desktopChallenge);
  const confirmation = pairing.prepareConfirmation(scan.link_data);
  const approved = await pollDesktopApproval(desktopChallenge, confirmation);
  const linked = pairing.verifyApproval(approved);
  await saveCompanionIdentity(linked);
} finally {
  pairing.close();
}
```

The transport and storage functions in this example belong to the application. In this fresh example, the SDK authenticates the scan with the linking secret carried in the QR and verifies the primary account signature before generating confirmation fields. It then verifies the approved device list against the primary identity established by the scan and the newly generated companion identity. The approved row must match the scan's master ID, companion ID, link ID, and chosen platform. A successful result includes a Node X25519 private `KeyObject` for the verified companion and the signed device list. [Linked-device verification](trusted-devices.md)

Fresh QR text contains the linking secret. Generate a fresh 32-byte value for each fresh attempt if you supply `linkingSecret`. By default the result omits that secret; `retainLinkingSecret:true` returns an owned copy only after verified approval. Explicit relink always returns its retained secret with the newly accepted history. Returned secret bytes are credentials owned by the application. Closing or completing the attempt wipes its working secret/signing references; it does not erase caller-owned copies or Node key objects. `platform` defaults to `'desktop'`; `'web'` selects the Web companion platform in this protocol.

## Explicit retained companion

Supply `relink: {uid, companion}` using `TrustedDeviceRelinkState`; its companion must include the original `linkingSecret`. The codec validates the X25519 private/public match, 32-byte secret, previous uint64 linking timestamp and matching historical signed list/row at issuance. Historical evidence does not establish current remote trust. UID is an exact decimal account identifier, separate from `masterId`; the secret/UID/history association remains caller-retained provenance.

Relink rejects simultaneous fresh `identitySigningKey`/`linkingSecret` overrides and `retainLinkingSecret:false`. Its selected platform must match the historical companion. It emits the same retained companion identity, omits fresh secret field 3 and includes the derived relink ID in field 6. The old accepted timestamp used for that ID, new QR timestamp and newly accepted scan timestamp are distinct. No missing secret is reconstructed and no failed relink becomes fresh enrollment.

Pass the full current approval data, including `uid` and `devices`, to `verifyApproval()` in relink mode. The UID must match before the result is released. Scan HMAC and A1 establish the current primary; the approved list is checked under that primary and the retained companion. Authenticated current primary/master metadata may differ from historical metadata; this is not a general key-rotation guarantee. [State, timestamps and verification](desktop-relink.md#state-and-verification)

## Desktop transport

| Stage | Shipped behavior |
| --- | --- |
| Challenge | The pre-auth Desktop `GET /api/login/reqqr` builder supplies `self_g:1` and `qr_form:1` for trusted self-generated QR, plus client identity, time, language, and computer name. It conditionally encrypts the request according to auth configuration and uses the signed pre-auth envelope. SHARED 12,405,515 and 12,409,895. |
| Scan | The challenge provides `token_id`, `chk_wait_scan`, `chk_wait_cfirm`, `qr_timeout`, and `qr_retry`. Desktop polls the supplied scan URL via GET, adds language, and handles a server-issued second challenge. A successful scan provides `link_data.enc_link_data` and `link_data.enc_link_hmac`. LOGIN 47,550–48,750 and 54,100–57,600. |
| Approval | Desktop percent-encodes `encLinkingMetaData`, `encAccountSign`, `encDeviceSign`, and `encPK` in the supplied confirm-poll GET URL. The approved response includes the signed `devices` object. The installer verifies the list with the proof's primary identity and the local companion key before storing the pairing. LOGIN 33,008–33,280, 36,100–37,350, and 51,190–51,950. SHARED 12,469,483. |

The SDK composes fresh or explicitly retained companion verification with the existing Desktop transports. `createDesktopAuthTransport()` supplies pre-auth negotiation, replacements and bounded polls; `loginDesktopWithQR()` adds bootstrap and optional persistence. The existing Web QR flow stays separate. Native phone acceptance of retained relinking remains unverified. [Desktop login](desktop-login.md) · [Retained login](desktop-relink.md) · [Desktop and Web evidence](desktop-evidence.md)

## WASM evidence

The source is installed Zalo Desktop **26.11.10** and the trust worker/WASM identified in the linked-device evidence. The earlier fresh-fixture disassembly used WABT 1.0.39; subsequent task-local CLI static inspection with WABT 1.0.42 confirmed the focused retained MAC/QR/proof dataflow of the same pinned WASM. Decoded WAT is not original Rust or target execution. [Linked-device WASM identity](trusted-devices.md#installed-desktop-evidence) · [Retained evidence and limits](desktop-relink.md#evidence-and-limits)

| Stage | Format |
| --- | --- |
| QR text | `zprotoTrustGenerateLinkingQr` at WAT line 41,878 emits `Z1@` and Base91. Fields are token 1, companion identity 2, optional fresh secret 3, uint64 QR time 4, normalized platform 5 and optional relink bytes 6. Web 0 omits platform; desktop 1 emits it. Relink carries field 6 and omits field 3. |
| Scan authentication | `zprotoTrustCreateCompanionLinkingProof` starts at WAT line 27,814. `LinkingDataProto` carries metadata bytes in field 1, account signature bytes in 2, and fixed64 linking time in 3. HMAC-SHA256 uses the selected original linking secret and the original scan bytes followed by the primary wire identity. The primary legacy Curve25519 signature covers `A1`, canonical metadata with platform omitted, and the companion wire identity. The signature call is at WAT line 32,053. |
| Companion confirmation | The companion signs `D2`, canonical metadata including its chosen platform, the companion wire identity, and the primary wire identity. Metadata fields 1 through 6 are master ID, primary identity, companion identity, companion ID, link ID, and platform. Field values are encoded with protobuf defaults omitted. The four confirmation fields are standard Base64. |

Existing fresh fixtures match original-WASM desktop/Web QR text, authenticate a synthetic scan and verify both native and SDK signatures over the same D2 body. Native proof signing uses randomness; retained confirmation uses the existing deterministic raw-scalar adapter and self-verifies each signature. Signature bytes need not match native output. Focused static proof70 tracing closes the normal HMAC/A1/D2 and raw-scalar roles, with malformed-parser and curve/scalar arithmetic limits. All 45 controlled SDK 0.43 retained-state, signature, lifecycle, recovery/store and key-capture groups pass locally. Live pairing/relinking remains unverified.