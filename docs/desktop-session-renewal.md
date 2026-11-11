# Explicit Desktop session renewal

`renewDesktopSession(connection, {save, signal?})` rotates the session and refresh tokens of a live `DesktopSessionConnection` created by this SDK. It uses the connection's account AES key and the raw approval `zpw_kt` retained as `refreshToken`. Cookie-only Web sessions, reconstructed connection objects, closed connections, and missing refresh tokens are rejected before submission.

```ts
import {
  connectDesktopSession, DesktopSessionRenewalError, renewDesktopSession,
} from 'zalo-personal-sdk';

// store and savedRecord belong to the application's single credential writer.
// Preserve savedRecord.companion, including any retained linkingSecret.
try {
  const credentials = await renewDesktopSession(connection, {
    save: next => store.save({ ...savedRecord, credentials: next }),
    signal,
  });
  // The old connection has closed. Bootstrap fresh account keys and endpoints.
  connection = await connectDesktopSession(credentials, desktopConnectionOptions);
} catch (error) {
  if (error instanceof DesktopSessionRenewalError) {
    const recovered = error.recoveryCredentials();
    if (recovered) {
      // Saving failed after the provider supplied a known new state.
      // Keep this secret-bearing copy and save it; do not repeat renewal.
      await store.save({ ...savedRecord, credentials: recovered });
    }
  }
  throw error;
}
```

The application's `save` must atomically replace tokens and cookies while preserving the whole loaded companion, including any retained linking secret. For `FileDesktopSessionStore`, keep the selected record and use `store.save({...savedRecord, credentials: nextCredentials})`; apply the same complete-record preservation when saving `recoveryCredentials()`. Reconstructing only `{credentials}` would discard trusted history/secret. Secret-bearing records stay version 2 and owner-only plaintext. Renewal does not write a file, touch the installed app or reconnect automatically. [Retained login/store/recovery](desktop-relink.md)

## Rotation and persistence

The helper snapshots the old credentials before submitting one request. A successful reply must contain a nonempty cookie-safe `zpw_sek` and nonempty `token`. The latter replaces `refreshToken`. An optional returned `uid` must match the connection account. The next snapshot preserves the device identity and key, removes every old `zpw_sek` cookie, and installs the new session token at the three native scopes: `zaloapp.com`, `zalo.me`, and `chat.zalo.me`. These cookies are Secure, HttpOnly, and SameSite=None.

After validating the new pair, the helper closes the old connection before calling `save`. This retires its listener, outstanding requests, account AES key, and stale cookie snapshots. Cancellation is honored while renewal is in flight. Once a confirmed pair is available, saving completes despite a later abort. The save callback receives an independent credential copy, and the returned credentials are another independent copy. No account AES key is persisted in either.

If saving throws, the helper raises `DesktopSessionRenewalError` with `code:'save-failed'`. `recoveryCredentials()` returns an independent copy of the known rotated pair. Its private backing field is omitted from JSON serialization and normal error inspection. The error has a fixed message and retains no application error cause. The accessor is deliberately secret-bearing; protect its result as credentials.

A successful `save` callback is the application's confirmation that the pair was durably committed. An application crash after provider rotation and before durable save can still lose the new pair. The SDK cannot make provider rotation and local storage one transaction. Use one process as the credential writer and preserve recovery data before reconnecting.

## Rejection, expiry, and uncertainty

| Error code | Result |
| --- | --- |
| `invalid-connection`, `closed`, `missing-refresh-token` | No renewal request was submitted. |
| `busy` | This live connection already has a pending credential mutation (renewal or sign-out). After confirmed rotation closes it, another call reports `closed` while saving continues. |
| `aborted` | The supplied signal was already cancelled before submission. |
| `unsupported-service` | The connection does not advertise the required service. No fallback endpoint is selected. |
| `rejected` | A provider envelope explicitly refused renewal. `providerCode` retains the numeric code. The SDK keeps the old connection and credentials. |
| `expired` | Provider code 266 explicitly identifies an expired refresh token. The SDK clears that token internally and calls `save` with a cleared snapshot. `credentialsSaved` reports whether the save succeeded. Failed persistence retains the cleared snapshot through `recoveryCredentials()`. The existing account session stays open. |
| `submission-unknown` | A transport, HTTP, cancellation, or response-validation failure leaves token rotation uncertain. The old connection is closed and no save or retry occurs. |
| `save-failed` | A validated new pair is available through the recovery accessor; the old connection is closed. |

The installed client treats error 160 separately in failure telemetry. The inspected source does not establish that it means token expiry or revocation. Other refusal codes remain numeric provider rejections. Clear an expired refresh token from the application's durable record before resuming from it; the old cookie session can remain valid until its own expiry.

Renewal and Desktop sign-out share one per-connection mutation lock. There are no automatic retries, redirected requests, or background renewal timers. The installed caller checks a configured `authentication.end_ts` against its synchronized clock and suppresses renewal within 24 hours of the last success. Those are local scheduling rules, separate from the endpoint contract. This explicit SDK operation does not infer a schedule or persist scheduling metadata. The application chooses when to call it and handles fresh approval if renewal is unavailable.

## Installed contract

Renewal is separate from `getLoginInfo`. The latter still bootstraps through its signed Desktop auth request and optional v2 parameter encryption. Renewal POSTs to the account-advertised `aext` service at `/api/exta/rnw`, with common `zpw_ver` and `zpw_type` query fields. Its form has account-AES-encrypted `params` containing `{token,imei,computer_name}`. It adds no auth `signkey` or `zcid`. The response is the ordinary outer envelope and account-AES-encrypted inner envelope; inner `data` contains the new `{zpw_sek,token}` pair. The SDK reuses the bounded-lifetime Desktop connection transport and disables redirects.

Offsets below refer to integrity-checked shipped JavaScript; no profile database or private credential file was read. [Artifact identity](desktop-evidence.md)

| Evidence | Location |
| --- | --- |
| Approval `zpw_kt` stages raw `{encK:'',refreshToken:...}` | LOGIN near byte 51,216, SHA-256 `0929a20e9181fbed984ed70aaa51c9aa55b3936eeffe10a30623f34e08080b1e`. |
| Authenticated startup copies staged renewal token into the account's refresh-token store | Desktop main-startup near 2,034,297; shared staging helper near 14,819,529. |
| Renewal request, command 15301, account AES encoding and decoding | SHARED 12,538,195–12,538,647. |
| New session cookie and new token installation | SHARED 11,920,868–11,921,600. |
| Expired code 266 clears the stored refresh token; code 160 has separate telemetry | SHARED 11,919,411–11,922,900. |
| Local end-time and 24-hour scheduling checks | SHARED 11,919,411–11,920,211. |
| `aext` domain selection | SHARED near 14,706,998. |

The SHARED SHA-256 is `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. Synthetic fixtures decrypt the exact request, validate cookie and token replacement, reconnect from the returned pair, and exercise persistence failure, secret-safe error inspection, expiry, refusal, uncertain submission, cancellation, serialization, and stale-connection retirement. No live renewal or logout was performed. Provider acceptance and actual token invalidation behavior remain unmeasured.
