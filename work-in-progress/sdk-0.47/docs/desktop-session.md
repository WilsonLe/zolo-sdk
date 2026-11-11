# Desktop account bootstrap

`createDesktopSessionCredentials()` converts a caller-supplied Desktop approval and its matching device identity into explicitly tagged Desktop credentials. `connectDesktopSession()` installs those credentials in a fresh in-memory cookie jar, fetches server configuration and login information, then creates the existing SDK `API`. It makes no Web QR request and does not use the installed app's profile or private account files.

```ts
import {
  createDesktopSessionCredentials, connectDesktopSession,
} from 'zalo-personal-sdk';

// approved comes from auth.pollApproval(challenge, confirmation).
// For trusted-device QR, first run pairing.verifyApproval(approved.data)
// and retain the verified companion identity using your application storage.
const credentials = createDesktopSessionCredentials(approved, {
  imei: applicationDeviceId,       // Same identity used for the QR challenge.
  computerName: 'My client',
  userAgent: applicationUserAgent,
  language: 'en',
});
const connection = await connectDesktopSession(credentials, {
  authOrigin: 'https://wpa.zaloapp.com',
  signal: bootstrapCancellation,
});
try {
  const profile = await connection.api.fetchAccountInfo();
  await applicationUsesAccount(profile, connection.api);
  // A secret-bearing Desktop snapshot; application storage is explicit.
  await applicationSavesDesktopCredentials(connection.snapshot());
} finally {
  connection.close();
}
```

The identity and approval in the example belong to the application. The credentials helper accepts only `{kind:'approved',data,cookies}`; replacements and Web sessions are rejected at runtime. It requires an exact decimal account ID and a nonempty cookie-safe session token. It does not verify the trusted-device list itself: trusted QR applications must use the [pairing verifier](trusted-device-pairing.md) before bootstrapping. Ordinary image/text QR approvals have no verified companion identity.

A connection's `api` exposes the same normal operations, custom wrappers and explicit listener APIs as the Web client. Bootstrap does not start a socket, send a message, load contacts or automatically persist anything. The default client type is `30` and version is `695`; credential identity can supply other verified values. `api` options accept the existing `selfListen`, HTTP agent and image metadata callback. Logging and update checks stay disabled.

## Credentials and account context

| Provider field | SDK handling |
| --- | --- |
| Approval `uid` | Stored as an exact decimal string and required to match `getLoginInfo.uid` before an API is constructed. |
| Approval `zpw_sek` | Stored as `sessionToken`; installed as Secure, HttpOnly, SameSite=None cookies for `zaloapp.com`, `zalo.me` and `chat.zalo.me`, matching the native cookie scopes. They remain session cookies in the SDK rather than reproducing native expiry arithmetic. Domain scopes can result in duplicate same-name/same-value cookies on `chat.zalo.me`. |
| Approval `dkey` | Stored as optional `deviceKey`. Desktop uses it for local device storage/UIN initialization. It is not the account AES key. A supplied `getLoginInfo.dkey` replaces the retained value for the new bootstrap. |
| Approval `zpw_kt` | Stored as optional `refreshToken`. It is renewal material, never sent by this bootstrap. Renewal remains an explicit separate protocol. |
| `getLoginInfo.zpw_enk` | Validated as a Base64 AES key of 16, 24 or 32 bytes and placed in the API's in-memory `secretKey`. It is omitted from `snapshot()`. |
| `zpw_service_map_v3` | Server-info entries are merged with login-info entries taking precedence per service. The resulting map supplies the pinned API and SDK wrappers. |
| `zpw_ws` | Login-info endpoints, or server-info endpoints if omitted, supply the existing listener. No socket opens until the application starts it. |
| `setttings` / `settings`, `extra_ver` | Server settings and optional login settings provide account features and socket/upload configuration; feature objects from login settings take precedence. Server `extra_ver` is carried into the API context. |

A `DesktopSessionCredentials` snapshot has `kind:'desktop'`, identity, account ID, session token, current cookies and optional device/refresh tokens. It excludes the account AES key, service map, profile and other login-info fields. Reconnect a saved Desktop snapshot with `connectDesktopSession()` to fetch fresh configuration, keys and service endpoints. It is deliberately incompatible with `PersonalSession` and `FileSessionStore`; those continue to represent the existing Web cookie session. The application chooses a separate secure store for Desktop snapshots and any companion private key.

`close()` stops this connection's listener, aborts in-flight HTTP work, clears its cookie jar and retained credential references, removes account key values from the context and clears upload callback timers. It also prevents further HTTP requests and snapshots. Per-instance listener guards suppress retry/rotation decisions and make already queued starts a terminal no-op after close; natural listener close events remain attached. Callback replacement and expiry use the pinned API's five-minute TTL semantics, with timers owned by the connection. The application retains responsibility for copies returned by `snapshot()`, `getContext()` or other operations. Closing a connection does not revoke the remote companion or log the account out.

## Requests and validation

Both bootstrap calls go to the explicit HTTPS `authOrigin`. `getServerInfo` is a signed plain GET with `imei,type,client_version,computer_name,sp_mtn:-1,bkt:-1`. Its `setttings.authen.encryption.enable` selects encrypted `v2` or plain `getLoginInfo` automatically; booleans and numeric zero/one are accepted. Missing configuration requires explicit `encryption:'v2'` or `'plain'`. `getLoginInfo` uses `{imei,computer_name,language,ts}` with the same Desktop parameter cipher and sorted-field MD5 signature already verified by the [auth transport oracle](desktop-auth.md). It appends type/version and signs with operation `getlogininfo`. Only original outer code `19000` on an encrypted request causes one plain retry. An outer-zero response that decrypts to inner code `19000` is a provider refusal after one request, without plaintext resubmission. This distinction follows SHARED 12,405,801–12,406,945. It does not add Web's `nretry`, `computer_name:'Web'` or Web login URL rewrite.

All service URLs must be HTTPS, have no userinfo, fragment or query, and belong to the shipped `zalo.me`/`zaloapp.com` domain families on the default port, or to an explicitly permitted exact origin. Socket URLs must be WSS with no userinfo or fragment and satisfy the same host/origin policy; their supplied query bytes may carry authentication and are preserved. `allowedOrigins` can approve exact HTTPS or WSS origins for a verified deployment. Neither a service map nor a redirect automatically expands that set. The eighteen services eagerly required by `zca-js@2.2.0`, upload settings and a bounded socket retry configuration are validated before constructing an API. Incomplete maps fail with `unsupported-config` instead of failing halfway through API initialization.

The optional override must be a dense array of exact origin strings. An optional trailing slash is normalized in a fresh copy; omission or an empty array adds no origins. Null, strings in place of an array, sparse/nonstring members and origins with paths, query, fragments or userinfo fail with fixed `invalid-endpoint` before bootstrap. The higher-level QR, password-login and recovery flows apply the same preflight before authentication requests or application callbacks.

Socket retry maps accept numeric close-code keys and bounded named profile identifiers, including the shipped `internal`, `swap_endpoint`, `system_resume`, `manual`, `cannot_reach_server`, `no_network` and `interval_check`. Scalar/array delays and absent/null `max` values remain intact. Numeric-code, entry-count, delay and nonnegative maximum bounds still apply; malformed keys or values fail before API creation. Named profiles are not converted into close codes. This preserves valid configuration without claiming that the pinned Web listener reproduces Desktop's full retry engine: its absent/null maximum becomes zero and its reconnect lookup consumes numeric close-code entries.

The SDK validates every API HTTP destination under the same origin policy and disables redirects and ambient credentials. The pinned adapter supplies the cookie jar's matching Cookie header and its existing Origin/Referer/User-Agent headers. Provider response `Location` headers and redirected responses are rejected. Explicit extra origins can receive the credentials applicable to their cookie scope; approve them only for a known deployment.

Bootstrap defaults to a 60-second deadline per request and a 2 MiB response budget. Configurable ceilings are ten minutes and 8 MiB. The deadline covers body reading, including adapters that ignore cancellation. Body budgets and HTTP/provider errors produce fixed-message `DesktopSessionError` values without provider messages, URLs, cookies or underlying causes. Normal API responses pass through a binary-preserving stream wrapper, retaining the deadline and connection/per-request cancellation until completion, early consumer cancellation or error. They are not buffered as UTF-8; their response decoding/budgets follow the existing operation implementations. The pinned normal API may replace a body-read error with its generic `Failed to parse response data` error, while direct transport consumers retain the typed cancellation/deadline error. The caller's `signal` governs bootstrap only and is detached after a successful connection. Use `close()` to end the running connection.

## Installed evidence and verification

The installed artifact is Desktop **26.11.10**, build **26.11.10.3400**, with packed member hashes recorded in [Desktop auth evidence](desktop-auth.md#installed-evidence-and-offline-verification). Offsets below are zero-based UTF-8 bytes of those exact members.

| Contract | Packed source |
| --- | --- |
| Approval installation | LOGIN 58,272 initializes local UID/dkey storage; LOGIN 58,930 calls native `setAppCookie(zpw_sek)` after approval. MAIN 390,023 defines the three native Secure/HttpOnly cookie scopes. |
| Trusted completion and renewal material | LOGIN 50,800–51,400 completes trusted-device approval and separately stores `zpw_kt` as renewal material. The bootstrap does not send that token. |
| Login-info request | SHARED 12,413,918 builds Desktop `GET /api/login/getLoginInfo` with identity, language and millisecond timestamp, then applies operation `getlogininfo`. Optional network/screen/system identity fields are not required for this slice. |
| Response account key and UIN | SHARED 10,114,629 fetches login info and returns `UIN:data.dkey`, `decryptKey:data.zpw_enk`, and complete config. |
| Account initialization | SHARED near 12,077,646 sets endpoints, UIN, decrypt key and account user ID from that result, then merges its service map. |
| Service-map choice | SHARED 14,707,194 merges v3 service lists, with optional preferred old-map endpoint. This SDK uses the v3 order expected by the pinned API. |
| AES | SHARED 16,720,530 stores the decrypt key; SHARED 16,722,256 returns it for standard zero-IV CBC operations. |

The existing REA helper compilation failure remains the tool boundary; source inspection uses the integrity-checked packed JavaScript bytes as the documented fallback. Implementation and fixture work did not access account files, live approval, enrollment, session tokens, profile data or authenticated endpoints. The later user-approved live checks are recorded separately below.

`test/desktop-session.test.mjs` uses synthetic credentials and an injected provider fixture. It validates exact signed/encrypted bootstrap requests, the native cookie domains, fresh service-map precedence and normal account-read/text-send/preview operations using the established account AES encoding. It exercises plain/fallback modes, original outer code 19000 fallback versus inner code 19000 refusal with exactly one request, large IDs, snapshot/resume, identity mismatch and hostile/incomplete endpoints, socket settings, callback lifetime, response limits, redacted errors and cancellation. These fixture tests make no live requests. The prior 5 November auth config/QR issuance probe did not reach approval; the subsequent ordinary-QR bootstrap and HTTP check is recorded below.

On 6 November 2026, the user completed a phone approval but the CLI returned `bootstrap-failed` without saving a Desktop session. A separate credential-free server-info read exposed 22 retry entries, including the named profiles above. The old numeric-only validator deterministically rejected that valid schema as `unsupported-config`; a retained live-shaped fixture failed before the correction and passes afterward. The installed defaults/consumer confirm named keys at SHARED 6,950,327, 7,610,256 and 1,211,640. A preflight using that public server configuration and an injected synthetic login constructed the API with all 44 services and 22 retry profiles. That preflight was not an authenticated account test. The user's original CLI output hid the inner reason, so this independently proven blocker is not asserted to be the only cause of that attempt.

Later on **6 November 2026**, a fresh ordinary-QR phone approval saved a Desktop record. The root agent's `npm run zalo -- desktop-verify` exited zero with “Desktop session accepted and profile read succeeded”. A separate authenticated read pass accepted the 45-service configuration and friends, groups, profile rank, group contexts, direct board and profile-verification reads. The saved record has no companion identity. This verifies ordinary-QR bootstrap and the authenticated HTTP operations exercised; it does not establish all operations or trusted-device pairing. The subsequent authorized socket check is recorded below.

The normal-response lifecycle regression was reproduced through `api.fetchAccountInfo()` with a 10 ms request deadline and an independent 80 ms watchdog. Restoring the previous headers-only timer cleanup caused that same test to reach the watchdog instead of rejecting. The stream wrapper makes the normal API reject before that watchdog and cancels the stalled source. The shared lifecycle owner has these fixture checks:

| State / consumer | Expected and observed outcome |
| --- | --- |
| Pending headers | Per-request abort or connection close rejects a fetch adapter that ignores the signal; an eventual response body is cancelled. |
| Pending JSON body | Normal account read rejects on deadline and on connection close, with the pinned API's generic parse error. Source cancellation is observed. |
| Body not yet consumed | Deadline marks the returned body errored and cancels its source before a later read. |
| Pending body with per-request signal | Read rejects with `aborted`; source cancellation is observed. |
| Early consumer cancellation | Source is cancelled and the response deadline is released. |
| Completed JSON and binary | Existing normal operations still decode; binary bytes, status, status text, headers and response URL are preserved. |
| Queued socket retry / close during disconnected event | Closed instance returns false from the pinned retry check before rotation and an already queued start does nothing, without opening a socket. |

Bootstrap already used the bounded abort-raced body reader and is covered separately; it was not changed by the normal-response lifecycle correction. The cancelled-body checks use signal-ignoring synthetic adapters and do not establish live provider behavior.

A subsequent user-authorized `npm run zalo -- desktop-verify --realtime` completed with exit code zero: saved-session bootstrap/profile read succeeded and the Desktop socket delivered its initial key frame. The CLI stopped the feed and awaited closure. No chat message was submitted. This verifies the initial socket handshake; trusted companion pairing, message delivery and other realtime events remain separate validation.
