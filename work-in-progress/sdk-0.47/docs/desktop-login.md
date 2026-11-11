# One-call Desktop QR sign-in

`loginDesktopWithQR()` composes Desktop auth, trusted-device pairing when selected, account bootstrap and optional application persistence. Default trusted QR attempts create fresh companions and return no linking secret. `retainLinkingSecret:true` explicitly retains a fresh accepted companion's secret; `relink` explicitly selects an existing secret-bearing companion. It returns `{connection,companion?}`. [Complete retained-login/store example](desktop-relink.md)

```ts
import { loginDesktopWithQR } from 'zalo-personal-sdk';

const result = await loginDesktopWithQR({
  authOrigin: 'https://wpa.zaloapp.com',
  allowedPollOrigins: ['https://qr-id.zaloapp.com'],
  imei: applicationDeviceId,
  computerName: 'My client',
  userAgent: applicationUserAgent,
  language: 'en',
  signal: applicationCancellation,
  async onEvent(event, { signal }) {
    if (event.type === 'qr') {
      if (event.qr.kind === 'png') await displayQrPng(event.qr.png, signal);
      else await displayQrText(event.qr.text, signal);
    }
    if (event.type === 'scanned') await showWaitingForPhoneApproval();
  },
  async persist({ session, companion }, { signal }) {
    // The application chooses a private store and handles its own transactions.
    signal.throwIfAborted();
    await saveDesktopSessionAndOptionalCompanion(session, companion);
  },
});
try {
  const profile = await result.connection.api.fetchAccountInfo();
  await applicationUsesAccount(profile, result.connection.api);
} finally {
  result.connection.close();
}
```

The display/storage functions belong to the application. This helper does not open Zalo, discover a profile, read another client's keys, approve on the phone, render an image automatically or start a socket. Calling it explicitly starts a new QR sign-in. No sign-in starts on module import. The poll origins stay an exact caller allowlist; a provider response does not authorize another origin. Additional verified API/socket origins may be supplied through `allowedServiceOrigins`. That option must be an actual dense array of exact HTTPS/WSS origin strings; an optional trailing slash is normalized in a private copy. HTTP URLs, URLs with paths, strings in place of arrays, sparse arrays, null and other malformed values reject with a fixed `DesktopSessionError('invalid-endpoint')` before configuration requests, QR issuance, callbacks or pairing. Omitting the option or supplying an empty array retains the normal origin policy. [Auth transport](desktop-auth.md) · [Desktop account bootstrap](desktop-session.md)

## Events, pairing and storage

`onEvent` is required and awaited in order. Both callbacks receive a second `DesktopLoginCallbackContext` argument containing `signal`, which includes caller cancellation and the helper's internal lifetime. One-argument callbacks remain compatible. Rendering callbacks should check that signal after asynchronous QR preparation and before writing/displaying credential material; this also prevents late side effects after the helper itself has expired.

| Event | Meaning |
| --- | --- |
| `qr` | Render `qr.kind:'text'` with its text or `qr.kind:'png'` with its PNG `Buffer`. `trustedDevice`, `replacement`, zero-based `generation`, per-poll `timeoutMs`, and the effective total `retryLimit` are included. An ordinary QR can be text or a provider image. |
| `retry` | A fulfilled nonterminal provider failure consumed an attempt. `stage`, consumed `attempt`, total `limit` and numeric `providerCode` are supplied before the next poll. |
| `scanned` | The phone scan arrived; a trusted scan's HMAC, primary signature and companion binding have verified before this event. |
| `approved` | Approval arrived. Trusted proof/list verification has completed. Retained relink has also matched the full approval UID to the selected account; retention/relink credentials and accepted history are captured before this event. Bootstrap and persistence are still pending. |
| `connected` | The approved account completed fresh bootstrap. Its exact `uid` and trusted-device flag are available. The final persistence callback has not run yet. |

Default trusted QR attempts create fresh keys/secret and replace them on each provider replacement. Fresh `retainLinkingSecret:true` keeps that replacement behavior and returns only the final accepted secret. Explicit `relink` preserves the selected identity, original secret and old accepted history across replacements, using each new challenge/token and QR timestamp. No stored relink identity is selected automatically.

Explicit retention/relink requests require a self-generated trusted QR: omitted `selfGeneratedQr` and `trustedDeviceQr` become true, while explicit false rejects before I/O. An ordinary challenge or replacement ends as `trusted-device-unavailable`, without an ordinary/fresh fallback. Relink state is captured and historically validated before the first request. An ordinary default flow still returns no companion; unexpected linking data without a matching pairing is rejected.

`companion`, when present, contains the private X25519 `KeyObject`, public identities and signed list. Its optional `linkingSecret` is present only for fresh explicit retention or relink. Persist/result/recovery copies do not alias mutable secret/public/list data; the immutable private key handle is shared. Account UID remains separate from masterId, and current authenticated primary/master metadata may differ from historical metadata. These values and QR material are credentials. [Pairing](trusted-device-pairing.md) · [Retained state and verification](desktop-relink.md#state-and-verification)

`persist`, when supplied, runs after every event and before success. Save the session, companion, original secret and newly accepted history together in one application record. It receives an independent copy; no event follows it. On failure the SDK closes local auth/pairing/connection work, but cannot revoke phone approval or undo application writes. Retention/relink failures after a qualified trusted approval expose a private accepted candidate through `DesktopLoginError.recoveryState()`. [Recovery and late writes](desktop-relink.md#accepted-state-and-persistence-recovery)

## Attempts, replacements and lifetime

The installed Desktop `qr_retry` value is a **total number of poll attempts**, independently applied to scan and approval, not a number of retries after the first request. The SDK applies it separately to each phase. Zero means zero polls and `retry-exhausted`. `maxPollAttempts` may lower that total; its maximum and default ceiling are 100. A new provider challenge uses its own budget.

For a fulfilled provider failure:

- `18010` stops immediately as `declined`.
- `-21` stops immediately as `relink-failed`.
- `-20` with a qualified replacement challenge returns new QR material and restarts scan with a fresh pairing if needed.
- Other numeric provider failures consume an attempt. If one remains, the SDK emits `retry` and repeats that phase. On the final attempt, provider `408` maps to `expired`; another code maps to `retry-exhausted`.

Rejected transport requests, malformed replies and failed cryptographic verification are terminal and are not replayed. There is no extra QR challenge issuance after exhaustion, no switch to Web auth and no hidden retry of account bootstrap or persistence. The lower auth transport retains its established single encrypted-code-19000-to-plain negotiation retry.

The inspected Desktop scan UI restarts on a replacement QR. Its approval UI terminates on a yielded replacement error. This SDK deliberately also supports an approval-stage replacement by rendering the lower transport's qualified challenge and restarting scan with fresh pairing material in fresh mode or the same captured retained material in explicit relink mode. This extension is bounded by `maxReplacements` (default four, maximum sixteen), the provider budgets and total lifetime. Explicit relink uses only the selected SDK state; it does not import, delete or update the installed client's records.

`maxLifetimeMs` defaults to ten minutes and has a one-hour ceiling. It covers auth, rendering/events, phone polling, pairing, API bootstrap and persistence, including callbacks that never settle. `requestTimeoutMs` and `maxResponseBytes` retain the lower transports' defaults and ceilings. The lifetime timer remains active while awaiting application code. A cancelled caller signal or expired lifetime stops further requests and closes an API that arrives late. A successful return clears that timer and detaches the sign-in cancellation signal; the caller then owns `result.connection.close()`.

## Errors and verification limits

`DesktopLoginError` carries a fixed `code`, stage, optional numeric provider code and optional fixed SDK `reason`. Codes include `aborted`, `expired`, `declined`, `relink-failed`, `retry-exhausted`, `replacement-limit`, `event-handler-failed`, `persistence-failed`, `auth-failed`, `pairing-failed`, `bootstrap-failed` and `trusted-device-unavailable`. Pairing reasons include `invalid-relink-state` and `account-mismatch`. Provider error messages, URLs, QR contents, callback messages and underlying causes are omitted. Rendering, persistence and cancellation failures do not authorize an automatic remote rollback or another enrollment attempt.

For retained flows, a qualified accepted `{session,companion}` is captured after current proof/list, matching retained UID when relinking, and credential validation, before `approved` and bootstrap. Later errors, including abort/expiry, preserve an independent secret-bearing recovery copy. `persistenceState` is `not-started` before callback invocation, `unknown` after invocation without observed fulfillment (including rejection or a pending late write), and `saved` after observed fulfillment. A late abort does not downgrade a completed save; later fulfillment does not revise an already returned `unknown` observation. No recovery candidate means no qualified accepted state, never permission to replay old history. Preserve one writer and quiesce/reconcile pending writes before recovery save. A crash between remote approval and durable local commit remains possible. [Complete contract](desktop-relink.md)

The retry/phase evidence is the integrity-checked Desktop 26.11.10 LOGIN member, SHA-256 `0929a20e9181fbed984ed70aaa51c9aa55b3936eeffe10a30623f34e08080b1e`, identified in [auth evidence](desktop-auth.md#installed-evidence-and-offline-verification). Zero-based UTF-8 byte offsets:

| Source | Established behavior |
| --- | --- |
| LOGIN 51,515–53,759 | `ar(url,timeout,qr_retry)` loops `u=qr_retry;u>0;u--`. Success, replacement `-20`, relink `-21` and decline `18010` are yielded to the phase consumer. Other fulfilled failures yield null only while another attempt remains. Rejected promises leave the generator. Final error 408 receives the QR-timeout classification. |
| LOGIN 56,200–57,600 | Scan consumer skips null yields, authenticates successful scan data, and restarts scan on code -20 using the new challenge fields. |
| LOGIN 57,787–60,450 | Approval consumer skips null yields, installs a successful approval and completes pairing. It treats yielded errors as terminal in this UI. |
| LOGIN 33,397–36,100 | First/second QR generation selects server PNG, ordinary text or trusted QR and may use local relink records. The default SDK chooses fresh pairing; explicit relink uses selected retained SDK state. |

An earlier REA macOS ownership-helper compilation failure affected analysis. Subsequent task-local CLI recovery completed static inspection of the pinned trust WASM; global MCP/configuration settings were unchanged and the target WASM was not evaluated. Those static results do not establish phone acceptance. Existing ordinary-QR live results below remain separate from trusted pairing and retained login.

`test/fixtures/desktop-login.mjs` simulates the phone using synthetic primary keys. It decodes each actual freshly generated QR, signs the matching scan and approved device list, and verifies the companion confirmation signature. This exercises real random pairing material without exposing deterministic test-key injection in the public sign-in API. Focused fixtures complete trusted/ordinary sign-ins, perform a normal account read, prove fresh identities/secrets across both replacement phases, check exact attempt counts and terminal errors, reject tampered cryptography, and verify cleanup after event/persistence/cancellation/lifetime failures. A precise bootstrap microtask regression first reproduced a created connection escaping cleanup when cancellation landed between its observer and await continuation. The observer now takes ownership before testing cancellation; that same regression verifies the key is cleared, snapshot is closed and connection transport is aborted. All network calls use an injected synthetic provider. A subsequent fresh ordinary Desktop QR approval saved a session, and a separate live `desktop-verify` accepted bootstrap and read the profile on 6 November 2026. The record has no companion evidence. These HTTP checks do not verify the Desktop socket, trusted pairing or all account operations.

All 45 controlled SDK 0.43 groups pass locally for explicit retention/relink, three timestamp roles, accepted-state recovery, persistence observations, v1/v2 restart and key capture. All 91 selected existing affected checks pass too. Live retained-login success remains unverified.

A subsequent user-authorized `npm run zalo -- desktop-verify --realtime` completed with exit code zero: saved-session bootstrap/profile read succeeded and the Desktop socket delivered its initial key frame. The CLI stopped the feed and awaited closure. No chat message was submitted. This verifies the initial socket handshake; trusted companion pairing, message delivery and other realtime events remain separate validation.
