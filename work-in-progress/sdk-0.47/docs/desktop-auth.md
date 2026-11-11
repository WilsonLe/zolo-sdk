# Desktop QR authentication transport

`createDesktopAuthTransport()` implements the installed Desktop pre-auth requests: server configuration, signed QR challenge requests, scan polling, and approval polling. It owns a fresh in-memory cookie jar. It does not read the installed app's account files or reuse its session. Creating the transport makes no request; each method performs one explicit request, except that an automatic challenge may first fetch configuration and an encrypted challenge's original outer code `19000` causes one plain retry. Code `19000` inside a successfully decrypted outer-zero response is a provider refusal and causes no retry.

A Desktop approval returns provider session fields and serialized cookies, plus a pairing helper can return the verified companion identity. `createDesktopSessionCredentials()` and `connectDesktopSession()` install the session and negotiate `getLoginInfo` service endpoints before returning the SDK API. A fresh ordinary-QR phone approval, saved Desktop record and authenticated HTTP profile read were verified on 6 November 2026. Trusted-device pairing and socket authentication remain separate verification boundaries. [Desktop session bootstrap](desktop-session.md)

```ts
import {
  createDesktopAuthTransport, createTrustedDevicePairing,
} from 'zalo-personal-sdk';

const auth = createDesktopAuthTransport({
  authOrigin: 'https://wpa.zaloapp.com',
  imei: applicationDeviceId,
  computerName: 'My client',
  language: 'en',
  // Observed Desktop polling origin; validate it for the target deployment.
  allowedPollOrigins: ['https://qr-id.zaloapp.com'],
  signal: applicationCancellation,
});
let pairing;
try {
  let challenge = await auth.requestChallenge();
  // This example shows one scan/approval cycle. Replacement QRs and retryable
  // provider errors return control to the application; do not ignore either.
  switch (challenge.qr.kind) {
    case 'trusted-device':
      pairing = createTrustedDevicePairing();
      await displayQrText(pairing.createQr(challenge.qr.token));
      break;
    case 'text':
      await displayQrText(challenge.qr.text);
      break;
    case 'png':
      await displayQrImage(`data:image/png;base64,${challenge.qr.base64}`);
      break;
  }
  const scan = await auth.pollScan(challenge);
  if (scan.kind === 'replacement') {
    // Close the previous pairing and render scan.challenge with fresh pairing
    // material if its qr.kind is trusted-device. Then resume from scan polling.
    await applicationHandlesReplacement(scan.challenge);
  } else {
    const confirmation = scan.linkData && pairing
      ? pairing.prepareConfirmation(scan.linkData) : undefined;
    const approval = await auth.pollApproval(challenge, confirmation);
    if (approval.kind === 'approved') {
      const companion = pairing?.verifyApproval(approval.data);
      await applicationInstallsDesktopSession(approval.data, approval.cookies, companion);
    } else {
      await applicationHandlesReplacement(approval.challenge);
    }
  }
} finally {
  pairing?.close();
  auth.close();
}
```

Application names in the example are placeholders. QR text/images, scan payloads, confirmation fields, approval data and cookies carry authentication material; do not log them. `approval.data` stays a raw object because the source carries Desktop-specific fields including `uid`, `dkey`, `zpw_sek`, `zpw_kt`, `devices` and profile information. Exact integers are parsed without losing large identifiers. The transport never stores or prints a provider error message or access-bearing URL in its errors. `DesktopAuthError` exposes a fixed `code`, stage and optional numeric provider code.

## QR modes and state

The challenge's `qr` discriminator is authoritative. With `self_g=0`, Desktop renders `base64_qr` as a PNG. With `self_g=1,qr_form=0`, it renders `qr_cnt` as ordinary QR text. With both flags set, it passes `token_id` to the trusted-device QR helper. Configuration defaults to the provider flags; absent QR flags default to Desktop's false/false fallback. `selfGeneratedQr` and `trustedDeviceQr` can be overridden explicitly for caller-provided configuration. `token` is an optional convenience alias for text/token modes; it is absent in image mode.

Provider code `-20` carries a second challenge. The installed consumer chooses ordinary `qr_cnt` text when `qr_cnt` is present and `ntk` is absent; otherwise it prefers `base64_qr`; otherwise it generates a trusted QR from `ntk || qr_cnt`. The SDK applies that same order. It invalidates the old challenge handle and returns `{kind:'replacement',challenge}` without making another request. The installed app may reuse a matching stored relink identity using `uid`, `master_id` and `regen_qr`; this transport supports a fresh pairing instead and does not read or reuse relink records.

Challenge objects are frozen, private transport handles. Copies, stale handles, handles from another transport and scan/approval calls out of order are rejected. A successful trusted scan must contain both `link_data.enc_link_data` and `enc_link_hmac`; a malformed supplied `link_data` is rejected even for ordinary QR mode. A trusted scan cannot advance to approval without confirmation fields. Use `createTrustedDevicePairing().prepareConfirmation()` to authenticate that scan before submitting those fields. Approval remains unverified until the pairing helper checks the signed list. Ordinary QR mode has no companion identity result.

`pollScan` and `pollApproval` each perform one provider long-poll. `qr_timeout` becomes the per-poll maximum and `qr_retry` is returned as `retryLimit`; the application controls retry policy and presentation. A provider error leaves that polling state available for an application retry. There is no unbounded background retry loop.

## Configuration, limits and credentials

`encryption:'auto'` is the default. The transport reads `data.setttings.authen.encryption.enable` from `getServerInfo`; boolean and numeric zero/one values select plain or `v2`. If that setting is absent, automatic challenge generation fails with `unsupported-config`, allowing the caller to choose an explicit mode in a new transport. Explicit modes skip automatic config lookup; call `getServerInfo` first or supply the desired QR flags. `parameterCipherKey` optionally supplies a copied 32-byte protocol key; the default is the established packaged Desktop parameter cipher constant, which is not an account credential. Compiled defaults are client type `30` and version `695`; both can be supplied by the caller for a verified target.

Only the exact configured HTTPS auth origin and `allowedPollOrigins` may receive provider polling requests. Poll URLs with credentials, fragments, whitespace, backslashes or another origin are rejected before fetching. Existing signed query bytes are preserved and extra fields use Desktop's `encodeURIComponent` encoding. HTTP redirects are disabled and redirected responses rejected. The internal jar supplies only its domain/path-matching cookies; ambient browser/process credentials are omitted. Cookies are returned only on approval, and `close()` clears the private jar and copied parameter key. The application controls persistence of the returned cookie copy.

Defaults are a 60-second request deadline, a ten-minute total transport lifetime and a 2 MiB response limit. Configurable ceilings are ten minutes per request, one hour total and 8 MiB per response. Total lifetime, caller cancellation and explicit `close()` cancel in-flight work, including fetch adapters that ignore the signal. Final response reading and operation return recheck cancellation before returning credentials. There is one active request at a time. `close()` also invalidates every handle. No caller-supplied cookie jar or account-cookie import is accepted.

## Installed evidence and offline verification

The evidence is Zalo Desktop **26.11.10**, build **26.11.10.3400**, from `/Applications/Zalo.app/Contents/Resources/app.asar`, SHA-256 `9217d0e419c4f2b89033cf23e89073de0052d7417e6e16270afc2d68e31896d2`. All offsets below are zero-based UTF-8 byte offsets in the exact packed member. The static investigation used shipped source without account files or local private keys.

| Label | Packed member | SHA-256 |
| --- | --- | --- |
| SHARED | `pc-dist/lazy/default-login-main-startup-shared-worker-znotification.4bb5e1e2c2e9bab4f7b3.js` | `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` |
| LOGIN | `pc-dist/lazy/login-startup.65eb8d358ddd85ba3f21.js` | `0929a20e9181fbed984ed70aaa51c9aa55b3936eeffe10a30623f34e08080b1e` |
| MAIN | `main-dist/main.js` | `328f2d2c12101b965a738559f6e7c3e48d2e1fd0e956bef4e44fde84e2019c43` |

| Contract | Evidence |
| --- | --- |
| Defaults and clock | SHARED 6,983,977 contains version 695/type 30 or embedded 31. SHARED 3,968,095 rounds milliseconds/1000 for `client_time`. |
| Config request | SHARED 12,412,679: `GET /api/login/getServerInfo` with `imei,type,client_version,computer_name,sp_mtn:-1,bkt:-1` plus `signkey`. Optional Desktop UI/theme/ref fields are not needed for this slice. SHARED 6,825,128 installs `setttings.authen.encryption.enable` and the trusted-device flags. |
| Signature | SHARED 12,410,299 sorts field names and MD5-hashes `zsecure + operation + concatenated field values`. Operations are lowercase `getserverinfo` and `reqqr`; signature is lowercase hex. |
| QR request | SHARED 12,409,895 builds `language,client_time,imei,computer_name,logged_uids,self_g,qr_form`. SHARED 12,405,508 appends `type,client_version,signkey` after optional encryption. |
| Parameter cipher | SHARED 12,398,747–12,401,208 contains the isolated `ParamCipher` class. `zcid` is uppercase AES-256-CBC hex of `type,imei,firstLaunchTime`; the derived 32 ASCII-byte key combines even MD5(`zcid_ext`) characters and even/reversed-odd `zcid` characters. `params` is AES-CBC Base64, `enc_ver` is `v2`. MAIN 423,676 identifies the fixed parameter cipher key. `main-dist/preload-render.js` 75,360 supplies an all-zero 16-byte default IV. |
| Encrypted response and retry | SHARED 12,405,801–12,406,945 decrypts URI-decoded Base64 data into the inner envelope. Only original outer code 19000 disables encryption and retries plain once; inner code 19000 returns through the decoded-response consumer without retry. SHARED 12,404,655 creates a fresh parameter cipher per encrypted request. |
| Scan and approval | SHARED 12,469,483 fetches the exact challenge URL with the provider QR timeout. LOGIN 32,950 appends the four percent-encoded confirmation fields. LOGIN 48,221 maps challenge fields. LOGIN 54,333–54,812 chooses the first QR source and scan language. |
| QR generation | LOGIN 33,397 selects first image/text/trusted QR. LOGIN 34,644 chooses second QR as described above; LOGIN 52,064 invokes it on code -20. |

REA's JavaScript analyzer was attempted against a directory containing the exact selected member. The provider failed while compiling its macOS ownership helper because the default SDK 27 and compiler disagreed. Retained failed-tool evidence ID: `ev_c6688b1e013e836495762c86632d0c5b31922e8ab872177763d83034a8234c62`. The conclusions above use exact source bytes and offsets as the fallback; they do not claim successful REA semantic analysis.

`test/fixtures/desktop-auth.mjs` was generated offline by evaluating only the shipped `ParamCipher` class and `getSignKey` method with zero-IV Node crypto bindings. It records a synthetic fixed ciphertext/key/signature vector, source hash and offset. The transport tests independently inspect decrypted requests and return encrypted provider envelopes, then complete the existing stock-WASM-verified synthetic scan and approval fixture. They also cover config-selected QR modes, second QR priority, original outer code 19000 fallback versus inner code 19000 refusal with exactly one request, stale handles, missing/partial scan proofs, cookie domains, forbidden URLs/redirects, redacted errors, response budgets and cancellation during final body reading. These fixture tests make no live requests.

A separate root-agent probe on **5 November 2026** read live `getServerInfo` at `https://wpa.zaloapp.com` and observed encryption enabled with both QR flags false. A challenge request using a synthetic device identifier successfully negotiated the encrypted envelope and returned a PNG with a valid PNG signature. Both returned polling URLs had the exact origin `https://qr-id.zaloapp.com`; only those origins were inspected for the allowlist, and access-bearing paths, queries and QR contents were not printed or retained. The transport was immediately closed. That probe performed no scan, approval poll, login or account-session bootstrap.

On **6 November 2026**, the user completed a fresh ordinary-QR approval and the CLI saved a Desktop record. The root agent ran `npm run zalo -- desktop-verify`; it exited zero and reported that the Desktop session was accepted and the profile read succeeded. A separate authenticated read pass accepted the 45-service configuration and friends, groups, profile rank, group contexts, direct board and profile-verification reads. The record has no companion identity. These results establish the ordinary-QR and authenticated HTTP paths exercised, without establishing trusted-device enrollment, all operation behavior or socket authentication. The subsequent authorized socket check is recorded below.

A subsequent user-authorized `npm run zalo -- desktop-verify --realtime` completed with exit code zero: saved-session bootstrap/profile read succeeded and the Desktop socket delivered its initial key frame. The CLI stopped the feed and awaited closure. No chat message was submitted. This verifies the initial socket handshake; trusted companion pairing, message delivery and other realtime events remain separate validation.
