# Desktop password V2 sign-in

`loginDesktopWithPassword(options)` runs the installed Desktop password route through configuration, provider-issued captcha, caller-entered answers, optional security questions, approved-session bootstrap, and optional persistence. Successful bootstrap returns the normal `DesktopSessionConnection`; existing API operations use that connection. No local Zalo account files, saved passwords, certificates, or phone metadata are discovered.

```ts
import { loginDesktopWithPassword } from 'zalo-personal-sdk';

const result = await loginDesktopWithPassword({
  authOrigin: 'https://wpa.zaloapp.com',
  imei: applicationDeviceId,
  computerName: applicationDeviceName,
  userAgent: applicationUserAgent,
  phoneNumber: userEnteredNationalPhoneNumber,
  isoCountryCode: userSelectedCountryIsoCode,
  password: userEnteredPassword,
  async onChallenge(challenge, { signal }) {
    if (challenge.kind === 'captcha') {
      // Render challenge.png locally; get the answer from the user.
      const answer = await applicationAskForCaptcha(challenge.png, signal);
      return { action: 'answer-captcha', answer };
    }
    if (challenge.kind === 'security-question') {
      const selectedValues = await applicationAskSecurityQuestion(challenge, signal);
      return { action: 'answer-security-question', selectedValues };
    }
    // A refused or expired captcha needs an explicit refresh choice.
    return await applicationConfirmCaptchaRefresh(signal)
      ? { action: 'reload-captcha' } : { action: 'cancel' };
  },
  async persist({ session }, { signal }) {
    signal.throwIfAborted();
    await applicationSaveDesktopCredentials(session);
  },
});

if (result.kind === 'connected') {
  // Application owns the API and must close it when finished.
  const api = result.connection.api;
} else {
  // Present the requirement to the user. Start loginDesktopWithQR separately if chosen.
  applicationShowLoginRequirement(result.requirement, result.providerCode);
}
```

The example's input, rendering, user interaction, persistence, and eventual connection close belong to the application. It does not submit an OTP, send SMS, approve a phone prompt, or start QR login. Captcha PNG bytes are returned directly; no provider-supplied asset URL is followed. Security-question thumbnail strings are metadata for the application, not automatically fetched URLs.

## Supported states and explicit boundaries

| Provider state | SDK behavior |
| --- | --- |
| Captcha acquisition | Signed `/api/login/getCaptcha`; callback receives PNG bytes and `expirationSeconds`. The token stays private in the transport. |
| Caller captcha answer | One explicit V2 credential submission. A callback can request a fresh captcha instead of submitting. |
| Captcha refusal `18023`, `18027`, `18028`, `18029` | Callback receives `kind:'captcha-rejected'` and a safe numeric code. A new captcha is acquired only after `action:'reload-captcha'`. Rate-limit codes are not permission to retry immediately. The application may cancel or defer. |
| Captcha expired locally | Callback receives `kind:'captcha-rejected', expired:true`; it must explicitly choose refresh or cancel. Expiry does not submit the password. |
| Security question `18036` | Callback receives normalized `content`, `questionFormat`, `questionType`, `answerType`, and choices `{title,value,thumb}`. Only its explicitly selected values can be submitted. The selection must be a dense array containing exactly `answerType` distinct issued choices; holes and invalid values reject before another credential POST. The issued count and 1,000-choice SDK ceiling are checked before any array entry is read or copied. Accepted arrays are copied by indexed slots, without invoking a caller-supplied iterator. Caller order and the original array are preserved. |
| Question answer refused | The same question can be shown again with the safe numeric `providerCode`; another submission requires another explicit callback answer and consumes the SDK submission budget. No answer is guessed. |
| `18070` | Terminal `{kind:'requires-other-method',requirement:'otp-or-mobile-confirmation',providerCode}`. |
| `18071` | Terminal requirement `otp`. |
| `18077` | Terminal requirement `qr`. |
| `18072` | Terminal requirement `app-upgrade`. |
| `18045`, `18046` | Terminal requirement `security-question-quota`. |
| Other initial credential refusal, including `18017` | Fixed `DesktopPasswordLoginError` code `provider-rejected`, retaining only its numeric provider code. |
| Approved credentials | Validate explicit Desktop credentials, bootstrap with `connectDesktopSession`, await event/persistence callbacks, then return `{kind:'connected',connection,trust:'not-enrolled'}`. |

The active installed password form displays OTP/mobile-confirmation and other errors; no continuation request for those requirements was established from that form. The SDK therefore reports them without fabricating an OTP/mobile endpoint, automatically sending a code, polling for phone approval, or treating the password request as completed authentication. Existing QR sign-in is a separate caller-selected fallback.

Password sign-in follows the installed **login without trusted-device enrollment** path. The success result never supplies a verified companion or treats a returned device list as authenticated pairing evidence. `trust:'not-enrolled'` describes this sign-in path, not the account's other devices. Trusted companion creation still requires the separately verified QR pairing flow. No local trust-identity dormancy mutation from the native application is reproduced.

## Input, ownership, and limits

Supply a national phone number as 6–32 decimal digits and its uppercase two-letter ISO country code. The country calling code is not automatically prepended. Leading zeroes are retained. The SDK checks this input domain and bounds, not whether the provider considers the number registered or valid. Passwords are nonempty, at most 4096 UTF-8 bytes, and must round-trip through UTF-8 without replacement. No trimming, Unicode normalization, code-unit reversal, or fabricated password-strength rule is applied. Astral characters and combining sequences are supported; lone UTF-16 surrogates reject before I/O.

Optional `loggedUserIds` are application-owned decimal strings joined with commas. An optional `questCertificate` is supplied explicitly by the application. This slice does not import existing application certificates, `last_uid`, or `viewerkey`. The current installed password form passes null for the latter two fields. On a security-question answer, `quest_cert` is omitted and the response's optional `cptch_cert` is retained privately. Null/empty captcha certificates mean no certificate field is sent. Captcha answer/token fields become empty strings, matching the form's captcha reset before the question submission.

Security choices must have distinct nonempty values without commas so the source's comma-separated answer encoding is unambiguous. Safe numeric choice values normalize to exact strings; large JSON integer tokens retain their lexical decimal strings. The number of distinct selected values must equal `answerType`, and every selected value must come from the issued question. Selection order is retained. Omitted/null display fields and numeric question fields use the installed defaults of empty strings and zero. Future nonnegative integer question types/formats up to 65535 are retained. Other malformed or unusable questions reject rather than inventing answers. Choices are capped at 1000; display strings at 16 KiB and values at 4096 UTF-8 bytes. These are SDK usability/size bounds, not measured provider limits.

Defaults are ten minutes total lifetime, 60 seconds per request, 2 MiB per response, eight captcha acquisitions and twelve explicit submissions. Maximum configurable bounds are one hour total lifetime, ten minutes per request, 8 MiB per response, and 100 acquisitions/submissions. A captcha countdown must be a nonnegative integer of at most 3600 seconds; zero expires immediately. Each submitted operation may make one extra request only for the exact protocol fallback described below. The application can set smaller limits. The native UI's three initial failures before suggesting QR and periodic clearing of selected checkboxes are UI policies, not copied server quotas.

The total lifetime includes every application callback, request, bootstrap, and persistence callback. Callback context contains the combined lifetime `signal`; application code must check it after its own awaited work before side effects. Challenge-reply fields and selected array indices are copied inside the callback error boundary; a throwing accessor produces a fixed `callback-failed` error without its private exception text or cause. Cancelling cannot roll back a callback's already committed storage or undo a remote request. Callback failure closes any newly created connection. Persistence is awaited before returning; its failure closes the connection but does not claim to roll back application storage.

Identity, auth origin, bootstrap adapter, encryption key bytes, callbacks, and service-origin overrides are captured for the flow. Service-origin overrides are validated as an actual dense array of exact HTTPS/WSS origin strings, allowing an optional trailing slash, before configuration requests, callbacks or credential submission. Malformed lists/members fail with a fixed `DesktopSessionError('invalid-endpoint')`; they cannot consume a password attempt before bootstrap discovers the configuration error. An async callback cannot redirect bootstrap by changing the original options object. The lower transport binds issued captcha/question handles by private identity; copied, forged, replaced, expired, and cross-account handles cannot submit credentials. Captcha token and question certificate are not present in callback events. Normal events contain only fixed type/trust labels and, after connection, UID. No password, phone number, captcha answer, certificate, raw provider message, or approved token is put in events or error JSON.

JavaScript strings cannot be reliably zeroed. The helper avoids password persistence and logging, clears owned mutable buffers/references where practical, and drops the transport jar at completion/failure. The application still owns the original password string, its callback state, and persisted credentials. Treat a connection snapshot as secret data. A successful bootstrap does not start a realtime socket automatically.

## Exact transport and encryption

All authentication requests use the caller's exact HTTPS `authOrigin`, `credentials:'omit'`, a private cookie jar, `redirect:'error'`, no referrer, and no-store cache mode. Response redirect metadata, changed response URL, Location headers, oversized bodies, and excessive cookies reject. Response deadlines cover headers and body reads, including adapters that ignore abort signals. Late responses are cancelled rather than installing cookies after closure.

| Request | Signed fields |
| --- | --- |
| GET `/api/login/getServerInfo` | `imei,type,client_version,computer_name,sp_mtn:-1,bkt:-1,signkey`; operation `getserverinfo`. |
| GET `/api/login/getCaptcha` | Plaintext `{client_time:round(now/1000),imei,computer_name}` passed through ParamCipher when enabled; outer `type,client_version,signkey`; operation `getcaptcha`. |
| POST `/api/login/loginByPasswv2` | Form fields from plaintext `{phone_num,iso_country_code,password,cptch_token,cptch_answer,make_answer,language,logged_uids,computer_name,imei}`, optional certificate or explicit question fields, then ParamCipher when enabled; outer `type,client_version,signkey`; operation `loginbypasswv2`. |

Each signature is lowercase MD5 of `zsecure` + operation + values ordered by sorted field names. The default encryption mode reads `data.setttings.authen.encryption.enable` or the supported `data.settings` spelling, including numeric 0/1. Explicit `plain`/`v2` overrides remain available when these optional configuration members or a usable flag are absent. Without an explicit usable mode, this absence rejects `unsupported-config` before captcha or credential I/O. A fetched configuration is remembered so the transport does not implicitly repeat a configuration read just because it lacked the flag; the caller can still invoke `getServerInfo()` explicitly. Malformed non-object provider data/configuration rejects `invalid-response` rather than being treated as missing configuration.

V2 first applies the distinct PasswordCipher. It derives an AES-256 key from uppercase SHA-256 of `packagedPasswordKey-phone-imei-salt`: first sixteen even-position hexadecimal characters followed by first sixteen characters of the reversed odd-position sequence. The plaintext is `salt + reverse-by-Unicode-codepoint(password)`, encrypted with AES-CBC, zero IV and PKCS7 padding to Base64. The packaged eight-character input comes from native-main's `passwordCipherKey`; it is a shipped constant, not an account credential. The SDK generates a fresh cryptographic twelve-hex-character salt for every encrypted attempt, within the installed generator's 8–12-character range. Plain mode omits the salt and sends the unchanged password inside the signed form.

The existing Desktop ParamCipher then wraps the full request with `zcid,zcid_ext,enc_ver:'v2',params`; encrypted replies are decoded with that request's key before interpreting inner provider errors and challenge data. This is not account-key message encryption and does not authenticate a companion identity.

Only an explicitly fulfilled **original outer-envelope** provider `19000` response permits the shipped one-time retry in plaintext mode. A successful outer `0` envelope decrypted to an inner `19000` is an ordinary provider refusal: it never changes the mode or triggers a retry. This distinction applies to both captcha GET and credential POST. The permitted outer-19000 fallback **can resubmit the password** because the provider has explicitly rejected the encryption protocol. It is not a network retry. A second outer19000, any inner19000, a different provider error, HTTP failure, timeout, parser failure, aborted body, or unknown submission is not automatically replayed. The selected fallback mode is carried into session bootstrap. To require encrypted credential transport independent of this provider behavior, an application must not use this source-compatible fallback flow; HTTPS remains required in either mode.

`DesktopPasswordLoginError` exposes fixed `code`, `stage`, optional safe numeric `providerCode`, optional fixed bootstrap `reason`, and `submissionMayHaveSucceeded`. The boolean flags credential submissions that ended before a definite provider outcome was obtained; it does not provide recovery credentials or prove whether the provider created a session. Cancellation before submission leaves it false. Caller abort or total-lifetime expiry while a credential POST is pending retains it as true, even when the adapter ignores signals. Known provider refusals retain false. Unknown submission terminates the transport. No password is silently retried to discover the result. Requirements are terminal typed results and carry no private provider body.

For applications that own the entire state machine, `createDesktopPasswordLoginTransport(options)` exposes `getServerInfo`, `getCaptcha`, `submit`, and `close`. `submit` accepts a discriminated issued-captcha answer or issued-question selected-value input plus explicit credentials. It returns approved raw data/cookies/encryption mode, a security question, a captcha/question refusal, or a terminal requirement. **Its approved result contains secret material**, like the existing QR transport's approval, and is intended only for explicit credential/bootstrap handling. The high-level helper returns the connection rather than exposing this approval payload.

## Source and verification

The current LOGIN member was read alone from `/Applications/Zalo.app/Contents/Resources/app.asar` using the repository's bounded header/offset parser and checked against its ASAR integrity metadata and expected digest. This reused the known exact packed-byte fallback; no REA setup retry, native app execution, local-account inspection, or login request occurred.

| Source | SHA-256 |
| --- | --- |
| LOGIN `pc-dist/lazy/login-startup.65eb8d358ddd85ba3f21.js` | `0929a20e9181fbed984ed70aaa51c9aa55b3936eeffe10a30623f34e08080b1e` |
| SHARED `pc-dist/lazy/default-login-main-startup-shared-worker-znotification.4bb5e1e2c2e9bab4f7b3.js` | `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` |
| Native-main `main-dist/main.js` | `328f2d2c12101b965a738559f6e7c3e48d2e1fd0e956bef4e44fde84e2019c43` |

All offsets are zero-based UTF-8 bytes:

| Anchor | Evidence |
| --- | --- |
| LOGIN `369869`–`373080` | Captcha result fields, PNG rendering prefix, seconds countdown, explicit reload and captcha reset. |
| LOGIN `373080`–`377750` | Security-question normalization, exact selected-value count, comma join, submitted metadata, and provider-error handling. |
| LOGIN `392429`–`395450` | Active V2 password form, certificate inclusion conditions, current null last-UID/viewer values, success fields, question/quota/error handling. |
| LOGIN `50050`, `50415` | Plain provider error parser; password success explicitly uses login-without-trusted-device-enrollment path and stages optional refresh token. |
| SHARED `12398747`–`12402033` | Exact ParamCipher and PasswordCipher classes, random salt range and codepoint reversal. |
| SHARED `12404655`–`12407150` | ParamCipher request wrapping, reply decoding and exact provider19000 fallback. |
| SHARED `12410299`–`12411900` | Sorted-field signatures, captcha builder, current V2 POST builder and separate unused legacy password route. |
| SHARED `13738004` | Numeric auth error enum including captcha, security, OTP/mobile and QR requirements. |
| SHARED `4549175` | Logged-user IDs are joined with commas. |
| Native-main `423726` | Packaged PasswordCipher fixed input. |

Fixtures independently decode signed/encrypted requests, derive the PasswordCipher key from each wire salt, and return synthetic encrypted replies. Coverage includes plain/V2 paths, both configuration spellings, absent versus malformed configuration, explicit-mode fallback without redundant configuration reads, astral/combining Unicode, exact fields, private cookies, permitted outer19000 fallback versus non-retried inner19000 refusals on captcha and credentials, caller-entered captcha and explicit refresh, security choices and retries, sparse selections, wrong-size arrays rejected without entry reads, ignored custom iterators, throwing reply accessors, early service-origin validation, terminal requirements, normal API bootstrap, persistence/event failures, pre-submission versus pending-POST lifetime/abort metadata, stale-handle protections, options-mutation resistance, malformed responses, limits, and signal-ignoring adapters. The configuration, pending-POST cancellation, inner19000 provenance, sparse-selection, reply-accessor and delayed-origin-validation regressions were retained and reproduced against the original paths before their corrections. The six bounded/indexed-selection regressions were additionally retained and reproduced against the released 0.18 implementation before the 0.18.1 correction. Root independently compared the exact shipped cipher classes through an isolated Node-crypto bridge with a separate CryptoJS reference for fixed ASCII and Unicode vectors; that is adapter-level offline evidence, not native-runtime or live-provider verification. No real password, captcha answer, security answer, OTP/SMS, phone approval, or account authentication was submitted for these fixtures. Live acceptance and account-dependent challenge variations remain unverified.
