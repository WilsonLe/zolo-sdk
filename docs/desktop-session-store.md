# Desktop credential storage and CLI

`FileDesktopSessionStore` saves credentials and optional historically verified companion state in an **owner-only plaintext** JSON file. It includes session cookies, renewal token, companion private key and, only when explicitly retained, the original linking secret. macOS/Linux files use mode 0600; new parent directories use 0700. This is not an encrypted vault. The application chooses the path and controls every copy.

```ts
import { FileDesktopSessionStore, loginDesktopWithQR } from 'zalo-personal-sdk';

const store = new FileDesktopSessionStore('/private/app/desktop-session.json');
const result = await loginDesktopWithQR({
  ...applicationDesktopIdentity,
  authOrigin: 'https://wpa.zaloapp.com',
  allowedPollOrigins: ['https://qr-id.zaloapp.com'],
  onEvent: applicationRendersSignIn,
  persist: ({ session, companion }) => store.save({ credentials: session, companion }),
});
// The application owns result.connection and eventually calls close().
```

Each save validates the record, writes a private exclusive temporary file, syncs its contents, and atomically replaces the destination. A rejected record preserves the previous file. Loads reject symlinks, nonregular files, and broad POSIX permissions. Web and Desktop stores retain their own tagged formats. Applications use one credential writer when saving snapshots or rotating tokens. Atomic replacement alone does not serialize independent processes.

Companion keys are serialized as PKCS8 X25519 private keys. Loading checks the private/public match and signed list at issuance, including stored master/id/link/platform. That is historical evidence, not current remote trust. Explicit relink authenticates the current scan and approved list, then matches the full approval UID and bootstrap UID to the selected account. Its current authenticated primary/master metadata may change; UID is not masterId. The account AES key and service/profile context remain excluded. [Retained verification](desktop-relink.md#state-and-verification)

## Secret-bearing format and restart

Secret-absent records keep the existing version 1 format. Explicitly retained secret-bearing records use version 2, with canonical Base64 secret bytes and a verified companion. The loader accepts both; version 1 with a secret extension, version 2 without a valid 32-byte secret/companion, malformed keys/history and unknown versions reject. Old SDK versions reject version 2 instead of silently stripping its secret during a rewrite. Invalid saves preserve the old file; there is no implicit migration or secret reconstruction.

A version 1 record without the original secret cannot be relinked automatically. Saved-cookie bootstrap remains separate. Use `retainLinkingSecret:true` for an explicitly requested fresh retained enrollment, or supply one selected `relink` state. Save new credentials and accepted history together. When updating credentials through verification or renewal, preserve the entire companion and optional secret, for example `store.save({...savedRecord, credentials: nextCredentials})`. CLI verify already preserves that record; CLI login stays fresh with no new retention/relink command.

A successful save syncs file contents and atomically replaces the destination; it is not a provider/local transaction or multiprocess lock. Keep one application credential writer. An uncertain or pending callback can write after login rejects: retain the accepted recovery candidate and let that write settle before reconciling/replacing the record. The unavoidable approval-before-commit crash window is not repaired by the file format. [Complete SDK/store/recovery example](desktop-relink.md)

Store/restart/downgrade and atomic-preservation cases are included in the 45 controlled SDK 0.43 groups passing locally; actual native/phone acceptance remains unverified.

## Commands

```sh
npm run zalo -- desktop-login
npm run zalo -- desktop-verify
npm run zalo -- desktop-verify --realtime
npm run zalo -- desktop-probe
npm run zalo -- desktop-forget
```

`desktop-login` writes each QR to a temporary private PNG, prints its local path, waits for phone approval, bootstraps the account, and saves the Desktop record. A replacement deletes the old image. The temporary directory is removed when sign-in ends. `desktop-verify` loads the record, bootstraps fresh account keys and endpoints, reads the profile, saves updated cookies, and closes the connection. The optional realtime check opens a Desktop listener and may displace another Desktop connection.

`desktop-probe` validates QR issuance and rendering, then cancels locally before scanning or saving a session. `desktop-forget` removes the local Desktop record. Provider device revocation is a separate account operation.

| Environment variable | Purpose and default |
| --- | --- |
| `ZALO_DESKTOP_SESSION_PATH` | Desktop file path, default `~/.config/zalo-personal-sdk/desktop-session.json`. |
| `ZALO_DESKTOP_AUTH_ORIGIN` | Exact HTTPS auth origin, default `https://wpa.zaloapp.com`. |
| `ZALO_DESKTOP_POLL_ORIGINS` | Comma-separated exact HTTPS polling origins, default `https://qr-id.zaloapp.com`. The SDK still validates every supplied polling URL. |
| `ZALO_DESKTOP_USER_AGENT` | Application HTTP user agent. Default follows the pinned transport's Firefox user agent. |

The CLI generates a fresh device identifier for each sign-in and uses computer name `Zalo SDK` and language `en`. Resume uses the identity saved in the record. QR contents, tokens, profile fields and companion keys are kept out of normal CLI output.

Errors include allowlisted stage/SDK reason tags and safe numeric provider codes when available. For example, an approved challenge rejected by configuration validation reports `bootstrap-failed; stage:bootstrap; reason:unsupported-config`. Raw provider messages, URLs, tokens and underlying causes remain omitted. A bootstrap failure does not save the approved session, so another phone approval is required after fixing it. See the [named retry-profile bootstrap correction](desktop-session.md) for the 6 November compatibility finding.

Text QR modes render exact UTF-8 bytes as black square modules on an opaque white field, with medium error correction, a four-module quiet zone and scale 8. PNG mode preserves the provider's image bytes. The Node renderer uses `qrcode` 1.5.4. Independent ZXing-C++ 2.3.0 checks decoded the exact byte payload for the stock trusted-device fixture and a Unicode/whitespace fixture. This verifies those generated assets. Live phone approval is a separate interoperability check. [Renderer API](https://github.com/soldair/node-qrcode#server-api)

Synthetic CLI subprocess fixtures exercise login, private persistence, profile verification, image cleanup, local forgetting, probe cancellation and preservation of the Web session file. File fixtures cover signed companion key restoration, malformed/tampered input, atomic replacement, symlinks, permission checks and redacted errors. [Desktop sign-in](desktop-login.md) · [Desktop bootstrap](desktop-session.md) · [Explicit renewal](desktop-session-renewal.md)
