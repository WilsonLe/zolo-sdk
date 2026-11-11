# Explicit Desktop password create/change

`changeDesktopPassword(connection, input)` submits one authenticated password operation on a live branded Desktop connection. Supply all three password strings explicitly. An empty `currentPassword` selects the installed creation form for an account without a password; it does not bypass an existing password.

```ts
import { changeDesktopPassword } from 'zalo-personal-sdk';

const result = await changeDesktopPassword(connection, {
  currentPassword: applicationCurrentPassword, // '' only for the no-current-password form
  newPassword: applicationNewPassword,
  repeatedPassword: applicationRepeatedPassword,
  signal,
});
// result: { submitted: true, acknowledged: true }
```

The result means that the provider returned numeric outer `error_code:0`. The installed UI treats that acknowledgement as success. It does not independently prove password effectiveness, continued session validity, effects on other sessions, or durable credential state. No live password mutation or session-side-effect measurement was performed.

## Input and lifecycle

New password and confirmation must be nonempty, identical strings. Passwords are sent without trimming or Unicode normalization. Each string has an SDK resource bound of 1,024 UTF-8 bytes; malformed UTF-16 surrogate sequences are rejected to preserve the installed UTF-8 cipher semantics. The helper does not invent provider complexity, minimum-length or reuse rules. The shipped UI loads those rules from server configuration separately; the provider can reject a locally valid input.

The connection's private account-operation lock is shared with renewal and sign-out. A concurrent operation fails with `busy` before submission. The lock releases when the request settles; it is not remote-state reconciliation or permission to automatically repeat an uncertain mutation. The helper has no retry, reset-password, security-question, SMS/OTP or confirmation flow.

The existing owned account transport enforces the configured HTTPS auth origin, cookie scope, redirect rejection, request deadline, response-body budget and cancellation. It omits ambient credentials and uses the matching cookie jar. Normal in-memory provider `Set-Cookie` handling is preserved. The helper does not call application `SessionStore.save`/`clear`, manually rotate tokens, clear account keys or retire the connection after acknowledgement, refusal or uncertainty. A snapshot can reflect normal provider response-cookie updates. A still-open local connection does not prove its credentials remain accepted remotely.

## Exact request and acknowledgement

The target is the connection's owned auth origin, not an arbitrary service URL:

```text
GET /api/update/password
type, client_version, imei, computer_name,
curpassw, newpassw, re_newpassw, language, signkey
```

It is a raw signed query, without `params`, `zpw_ver`, `zpw_type` or the pre-auth ParamCipher. Each nonempty password field is individually encrypted under the account AES key with CBC, zero IV and PKCS7 padding, then encoded as Base64. Empty current password remains `curpassw=`. Signing occurs after encryption: lowercase MD5 of `zsecurepassword` plus field values in sorted field-name order, excluding `signkey` itself. Query values are percent-encoded. Identity, client type/version and language come from the branded connection.

Only an HTTP 200 JSON object with a safe-integer numeric outer `error_code` is a confirmed response. Zero acknowledges; a nonzero numeric code is an explicit refusal. Inner `data` is unused and is not decrypted. String `"0"`, missing/malformed status, body/HTTP failure, cancellation after handoff and unreadable replies are uncertain rather than success or a known refusal. A valid acknowledgement is retained even if cancellation arrives after it has been read and decoded.

## Safe error states

`DesktopPasswordError` has fixed messages and exposes only `code`, `submitted`, optional numeric `providerCode`, and optional HTTP `status`. It carries no passwords, query, response body, token copies, causes or recovery credentials.

| Code | Meaning |
| --- | --- |
| `invalid-input` | Invalid/over-budget password strings, mismatched confirmation or invalid signal; no submission. |
| `invalid-connection` | Unbranded/unusable connection; no submission. |
| `closed` | Connection already closed before handoff; no submission. |
| `aborted` | Caller cancelled before handoff; no submission. |
| `busy` | Another credential operation owns the lock; no submission. |
| `rejected` | Submitted request received a valid nonzero numeric provider code. |
| `submission-unknown` | Request was handed to the account transport but no valid acknowledgement/refusal was established. |

`submitted:true` is deliberately conservative: it denotes handoff to the credentialed transport, not independently observed delivery. The provider may have applied the request even when a later cancellation, close, timeout or malformed reply leaves the outcome unknown. The application owns any explicit reconciliation and later action.

## Installed evidence and offline checks

Installed Desktop 26.11.10 build 26.11.10.3400 SHARED member SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. UTF-8 byte anchors: Change/Create Password form **13,527,800–13,529,950**; manager's per-field encryption and plain acknowledgement check **10,122,141–10,122,600**; auth GET builder/command 11335 **12,482,959–12,483,400**; sorted signature **12,410,299**; account AES-CBC primitive **16,721,946**; separately loaded password rules **16,789,501**. [Artifact identity](desktop-evidence.md)

The integrity-checked exact packed-byte fallback was used without helper setup retry or application execution. Synthetic fixtures independently encrypt/decrypt the fields with Node crypto and calculate the signature from the explicit source field order. Cases cover Unicode and empty-current creation, exact auth routing/cookies, strict outer status, malformed/HTTP/redirect/transport failure, body limits/deadlines, cancellation/closure, credential-lock contention with renewal/logout, and secret-safe errors. These are offline contracts, not live provider acceptance.
