# Desktop password presence

`getDesktopPasswordStatus(connection, signal?)` reads whether the authenticated account has set a password. It requires a live `DesktopSessionConnection` created by this SDK and uses that connection's owned authentication origin, cookie jar, client type/version, response budget and HTTP deadline. It returns `{hasPassword, raw}` and never reads, sets, resets or returns a password.

```ts
import { getDesktopPasswordStatus } from 'zalo-personal-sdk';

const status = await getDesktopPasswordStatus(connection, signal);
// Display the presence flag only in the application's private account settings.
showPasswordPresence(status.hasPassword);
```

The exact request is GET `<owned-auth-origin>/api/update/checkHasPassword` with plain query `{type,client_version,signkey}`. It carries no encrypted `params`, IMEI, common `zpw_*` query fields, password or refresh token. The signature is lowercase MD5 of `zsecurecheckhaspassword` followed by the field values sorted by field name: client version, then client type. This is the installed public request signature, not a password hash or authentication credential.

Numeric `has_password:1` maps to true and numeric zero to false, while provider extensions stay in `raw`. The decoder follows the installed UI's successful and rejected-object flag paths in this order:

1. Require HTTP 200 and a valid safe-integer outer status (numeric or a complete decimal string). A nonzero outer envelope can itself supply an own numeric `has_password` flag, as the native UI's catch handler permits; `raw` is that complete outer record. Without that root flag it remains a provider error.
2. For outer status zero, account-AES-decrypt the normal `data` string. A decrypted flat record with no `error_code` member can supply its own numeric flag; `raw` is that flat record. This is an observed live response shape, even though the common native decoder sends it to the UI's catch path.
3. A decrypted envelope with status zero selects its `data` object. Its own root flag cannot override that successful nested data, and an envelope containing only a root flag without the successful `data` record is invalid.
4. A decrypted envelope with a valid nonzero status can supply its own numeric root flag through the same UI catch rule. Otherwise it remains a provider error. A flag found only inside rejected `data` is never unwrapped or treated as a successful read.

Missing, string, boolean and other numeric flags are rejected as `invalid-response` rather than presented as a confirmed no-password state. Missing/malformed outer status and explicitly malformed inner status are also rejected. Only the source-supported decrypted flat record may omit inner status. Unknown valid nonzero provider codes do not prevent the native root-flag fallback; they remain present in the caller-private `raw` record. These branches establish only the presence metadata consumed by the UI, not successful completion of any account mutation. Without a valid root fallback, a refusal remains an error with its safe numeric `ZaloProtocolError.providerCode`. No application cache fallback or write is performed.

Cancellation before submission makes no request. Invalid/reconstructed or closed Desktop connections are rejected through the existing connection brand/lifetime checks. The read is bounded through response consumption and does not acquire the credential-mutation lock or retire the connection; concurrent renewal/sign-out can close its underlying transport. It performs no retry, no cache write, no OTP request and no two-factor authentication change. Desktop transport, auth response-limit and ordinary protocol errors retain their existing fixed-message types without copying URLs, cookies, keys or raw provider messages.

## Evidence and verification

The exact builder is at UTF-8 byte 12,524,970 in installed Desktop 26.11.10 SHARED (`default-login-main-startup-shared-worker-znotification.4bb5e1e2c2e9bab4f7b3.js`, SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`). The command map records 12019 at 2,697,261. Standard decoded delegation is at 12,119,378. The common account decoder at 13,736,118 resolves successful inner `data`, rejects a failed outer/inner object, and rejects a flat inner object without a status. Both actual account-settings and change-password consumers inspect an own `has_password` member on that rejected object and compare strictly with numeric one; see complete then/catch paths at 7,105,970–7,106,410 and 13,528,100–13,528,400. The SDK narrows accepted flags to numeric zero/one and validates statuses instead of manufacturing false for arbitrary values. The generic account decoder is unchanged. [Artifact identity](desktop-evidence.md)

Eight offline fixture cases establish exact query/signature/cookie destination, both synthetic presence flags, standard nested and live-shaped flat records, outer/inner rejected-root fallbacks, branch precedence, preserved raw extensions, unwrapped-error-data rejection, malformed flag/status rejection, runtime brand/closure, cancellation, response limit and body-read deadline. The injected stalled stream deliberately has a test-owned event-loop handle while the transport uses its existing unref'ed timeout. The retained before-fix run had seven cases: four passed and all three newly supported response families failed through the old generic decoder.

On 6 November 2026, a separate read-only Desktop diagnostic observed HTTP 200, outer status zero and encrypted data whose decrypted root contained numeric `has_password` with no inner `error_code` or `data` field. Its actual flag value was not printed or recorded in this documentation. That observation exposed the decoder gap and was corroborated by the installed UI catch consumers. This is shape evidence; successful live verification of the corrected helper is recorded separately after rebuilding. No password change/reset, OTP request or two-factor setting operation was performed by this helper.

After the correction and rebuild, a normal saved-session bootstrap, profile read and `getDesktopPasswordStatus` call all succeeded with the default transport. The probe recorded only receipt/type flags and one raw-field count. It did not use the diagnostic redirect override, print the actual password-presence value, or write account settings.
