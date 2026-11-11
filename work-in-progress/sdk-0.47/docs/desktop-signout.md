# Explicit Desktop sign-out

`signOutDesktopSession(connection,{clear,...})` submits one logout for a branded live `DesktopSessionConnection`. It uses that connection's original auth origin and current account transport. Acknowledgment closes its listener, HTTP work, cookie jar and retained keys, then awaits the application's credential-clear callback. It never discovers or changes the installed Zalo app's credentials.

```ts
import { signOutDesktopSession, DesktopSignOutError } from 'zalo-personal-sdk';

try {
  const result = await signOutDesktopSession(connection, {
    // Supply the current verified companion ID if your stored pairing has one.
    companionId: savedCompanion?.companionId,
    signal,
    async clear(expected) {
      // expected is a secret-bearing copy of this session before the request.
      // Clear only its matching application record, preserving unrelated logins.
      await applicationAtomicallyClearsMatchingDesktopRecord(expected);
    },
  });
  // result.acknowledged means outer error_code:0 was received.
} catch (error) {
  if (error instanceof DesktopSignOutError) {
    const before = error.recoveryCredentials();
    // On clear-failed, retry local clear rather than logout. On uncertainty,
    // reconcile deliberately; the credentials may already be invalid remotely.
    await applicationHandlesSignOutOutcome(error.code, before);
  }
  throw error;
}
```

The clear/reconciliation functions belong to the application. `clear` is required and receives an independent Desktop credential snapshot to support matching-record deletion. It runs only after an acknowledged provider response. Its completion is the application's confirmation that the saved record was cleared; the SDK does not independently inspect storage. If the application record also contains a companion private key, the application chooses whether to remove it as part of the same local operation. The helper does not delete message archives, contacts, device identities in the installed app, or other sessions.

The result is `{submitted:true,acknowledged:true,credentialsCleared:true,variant}`. It confirms receipt of the installed endpoint's outer success code and completion of the caller's clear callback. It does not independently prove server-side cookie invalidation, refresh-token revocation, companion unlinking, or another device's resulting state.

## Request variants

`variant:'auto'` is the default. It follows `settings.authen.enable_logout_v2` from bootstrap, accepting boolean or numeric zero/one. If omitted, the installed compiled fallback is v2 enabled. An unsupported flag fails before submission. Explicit `'v2'` or `'legacy'` selects that verified builder directly; a rejection never triggers a fallback or retry.

| Variant | Exact wire contract |
| --- | --- |
| `v2` | `POST <owned-auth-origin>/api/v2/login/logOut?zpw_ver=<version>&zpw_type=<type>`. The URL-encoded form's `params` is account-AES-CBC encrypted JSON `{time,imei,computer_name,language,compId?}`. There is no pre-auth `signkey`, `zcid`, or plaintext auth token field. |
| `legacy` | `GET <owned-auth-origin>/api/login/logOut` with plain query `{zpw_ver,zpw_type,time,client_version,type,imei,computer_name}`. There is no encrypted `params` or `signkey`. |

`time` is the connection clock's milliseconds divided by 1000 and rounded, matching Desktop. `companionId`, when supplied, is a current verified ID from zero through 255 and becomes v2's `compId`. The installed controller obtains this field from its current trusted-device identity. The SDK does not infer an ID from an arbitrary linked-device row. Supplying it with a selected legacy route is rejected before submission. This is a current-session logout helper; the field is not exposed as an independently established revoke-other-device operation.

Both paths check only the **outer** HTTP JSON `error_code`, exactly as the installed logout consumer does. Numeric zero acknowledges the request, with or without `data`; the helper does not decrypt a v2 inner response or assume another envelope. A nonzero numeric outer code is an explicit rejection. Malformed bodies, non-200 HTTP responses and redirected responses leave submission uncertain. Requests use the connection's cookie jar, destination validation, response deadline and response-byte budget. Redirects and ambient credentials are disabled.

## Local state and uncertain outcomes

A shared per-connection lock serializes logout with `renewDesktopSession()`. A second credential mutation is rejected before another request is submitted. The lock remains held through the clear/save phase; after a known mutation closes the connection, subsequent calls report `closed` instead of starting work. Normal Web sessions and reconstructed objects fail the runtime Desktop brand check.

| Error | Local behavior |
| --- | --- |
| `invalid-connection`, `closed`, `busy`, `unsupported-config` | No logout is submitted. |
| `aborted` | Cancellation was observed before submission. The live connection and saved record remain available. |
| `rejected` | A nonzero numeric outer provider code was received; `providerCode` and HTTP `status` are retained. The connection and saved record remain available. |
| `submission-unknown` | HTTP, transport, response validation, response limit/deadline or cancellation after the operation began prevents confirmation. The connection closes; `clear` is not called. Existing durable credentials remain the application's responsibility. A private before-request snapshot is available through `recoveryCredentials()`. |
| `clear-failed` | The provider acknowledged logout and the connection closed, but `clear` threw. `acknowledged:true` and `credentialsCleared:false` describe that boundary. Recovery returns the before-request copy for retrying local cleanup, not replaying logout or assuming a valid session. |

Once acknowledgment is known, local retirement and the clear callback complete even if cancellation arrives later. An application crash or an already-running storage write can still leave storage inconsistent with remote state; the SDK cannot make logout and local deletion one transaction. Clear failures omit the application exception/cause. Recovery credentials live in a private field, do not appear in JSON or normal error inspection, and are copied on access. Protect them as credentials and do not automatically reconnect or replay an uncertain logout.

No logout request includes the raw approval `zpw_kt` / stored `refreshToken`. The inspected cleanup path removes native cookies and closes local data stores, but does not establish a separate remote refresh-token invalidation contract. The SDK therefore clears the application's matching credential record only after acknowledgment and makes no remote revocation claim. Existing [renewal](desktop-session-renewal.md) and [Web sign-out](web-protocol.md) remain separate operations.

## Installed evidence and fixtures

Offsets below are zero-based UTF-8 bytes in Desktop 26.11.10's integrity-checked SHARED member, SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`, unless stated otherwise. [Artifact identity](desktop-evidence.md)

| Contract | Evidence |
| --- | --- |
| Compiled v2 fallback | SHARED 6,980,836 has `authentication.enable_logout_v2:1`. |
| Common parameters | SHARED 12,402,415 initializes `{zpw_ver:apiVersion,zpw_type:apiType}`. |
| Legacy builder | SHARED 12,414,601: plain GET `/api/login/logOut`, command 11135, common plus time/type/version/device/computer fields. |
| V2 builder | SHARED 12,414,871: account-AES form POST `/api/v2/login/logOut`, command 12743, optional integer companion ID. |
| Controller choice | SHARED 10,108,090–10,109,000 selects the configured variant and obtains the current trusted companion ID. |
| Logout receipt and cleanup | SHARED 10,109,697 checks `response.data.error_code===0`, then clears native cookies and reloads in its finally path. The SDK deliberately preserves its live session on explicit refusal and retains durable state on uncertainty. |
| Current companion ID | Desktop main-startup 2,029,415 reads `getTrustedDeviceInfo().companionId`; member SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. |
| Clock | SHARED 3,968,095 rounds the current millisecond clock divided by 1000. |

The existing REA ownership-helper compilation failure remains the tool boundary. This slice uses exact shipped source bytes as the documented fallback and accessed no private profile, cookie file or account key. No live logout, revocation, password or 2FA mutation was performed.

`test/desktop-signout.test.mjs` injects synthetic credentials and provider responses. Fixtures verify both exact builders, account encryption and round-to-second timestamp, outer-only acknowledgment, optional companion field, config/override selection, late-abort clear completion, private recovery/redaction and pre-submission guards. They prove mutual exclusion in both directions with renewal, preserve a live API after explicit refusal, and close local resources while retaining durable state on uncertain HTTP/body/timeout outcomes. Live provider acceptance and token invalidation remain unmeasured.
