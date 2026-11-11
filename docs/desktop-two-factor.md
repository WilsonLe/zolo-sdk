# Explicit Desktop two-factor settings

`updateDesktopTwoFactor(connection, input)` submits one caller-directed account setting operation on a live branded Desktop connection. A `request` without an OTP may immediately apply the requested setting or trigger an SMS/OTP challenge. It is an account mutation, not a status read. The helper never polls, automatically retries, requests another code, or submits an OTP on the caller's behalf.

```ts
import { DesktopTwoFactorError, updateDesktopTwoFactor } from 'zalo-personal-sdk';

try {
  // Perform only after the application's explicit enable/disable confirmation.
  const receipt = await updateDesktopTwoFactor(connection, {
    action: 'request', enabled: callerRequestedEnabled, signal,
  });
  // receipt is {submitted:true, acknowledged:true}; read settings separately if needed.
} catch (error) {
  if (error instanceof DesktopTwoFactorError && error.code === 'rejected') {
    const privateDetails = error.challengeData();
    // Choose the next user interaction from validated providerCode and available
    // details. Unknown codes/shapes do not establish an OTP flow. Do not log them.
  } else throw error;
}

// A separate explicit interaction supplies the caller's OTP, preserving leading zeros.
await updateDesktopTwoFactor(connection, {
  action: 'submit', enabled: callerRequestedEnabled, otp: callerSuppliedOtp, signal,
});
```

The connection must be the actual object returned by this SDK's Desktop connection/login helpers; a copied object or ordinary Web API is rejected. Requests use its owned `authOrigin`, existing cookies, account AES key and client identity. This helper shares the connection's account mutation lock with Desktop password changes, renewal and sign-out. It releases the lock after acknowledgment, known refusal or an unknown outcome. It changes no stored credentials, settings cache, local 2FA flag or connection lifecycle.

## Explicit input and receipt

`DesktopTwoFactorInput` is one of:

- `{action:'request', enabled:boolean, signal?}`: sends `submitOTP:0` without any OTP. Supplying an `otp` member is rejected, even if its value is undefined.
- `{action:'submit', enabled:boolean, otp:string, signal?}`: sends `submitOTP:1` and the supplied nonempty OTP. The SDK accepts one to 64 ASCII decimal digits, a local input bound rather than a claimed provider code length. It does not trim or convert numeric values.

`enabled:true` requests `updateType:1`; `false` requests `updateType:2`. The helper returns only `{submitted:true,acknowledged:true}` after a valid accepted account response. It does not infer that privacy settings, every device or the current account policy now reflect the desired value. Eligibility, provider flags, mobile-only disable policy, real code delivery, and live acceptance remain unverified.

The installed controller has local confirmation screens, feature flags, phone-based caches and countdown timers. Those are application behavior, not provider challenge codes or SDK scheduling rules. This API requires explicit intent and delegates each next interaction to the caller.

## Errors and private challenge details

`DesktopTwoFactorError` has fixed messages and safe public metadata:

| Member | Contract |
| --- | --- |
| `code` | `invalid-connection`, `closed`, `busy`, `aborted`, `request-failed`, `rejected`, or `submission-unknown`. Invalid input instead throws a fixed-message `TypeError` before I/O. |
| `submitted` | False before handing the operation to the account transport; true once attempted. A true value does not prove the server received the request. |
| `acknowledged` | Always false on errors. An accepted acknowledgment returns the receipt instead. |
| `providerCode?`, `status?` | Validated provider integer/status when available. Any safe integer selected provider code is preserved, including unknown future values, without assigning a next screen or inventing a flow. Decimal-string codes are checked without accepting unsafe integer rounding. A malformed/unsafe selected code is omitted even though the response is known to be rejected. |
| `reason?` | For an unconfirmed outcome, `aborted`, `closed`, `timed-out`, `response-limit`, `invalid-response`, or `request-failed`. |
| `challengeData()` | Explicitly returns a defensive copy of bounded known private fields, or undefined. No raw response or original exception is attached. |

After submission, cancellation, timeout, an unreadable/oversize/malformed response, or a transport error produces `submission-unknown`. The remote setting change or SMS dispatch may already have happened. The connection is not automatically closed, and the operation is not repeated. Reconcile through an appropriate explicit application flow before deciding on another request.

The dedicated decoder preserves both native failure paths: an outer nonzero account envelope, and a nonzero inner envelope after the outer account-AES decryption. On HTTP 200 it separately attempts account-AES/JSON decoding of that error's `data`, matching the installed adapter; an already-decoded object is also recognized. Its private data selection uses a truthy decoded `data` member when present. The error mapper/adapter gives a non-nullish `code` on the rejected envelope priority over the decoded nested `error_code` or original refusal code. Without that preferred member, a truthy nested `error_code` is selected, otherwise the original refusal code is selected. This matches the installed `code ?? errorCode` priority and nested truthiness rule.

Only a safe integer numeric value or complete decimal-string integer is exposed as the selected `providerCode`. A present but malformed/unsafe preferred `code` keeps `code:'rejected'` while leaving `providerCode` undefined; it does not fall back to a different OTP-flow code. Null/undefined instead permits the normal nested/original fallback. A selected zero remains a rejected response with `providerCode:0`, never a success acknowledgment. Unknown/private-body failures do not erase an otherwise validated selected refusal code. An HTTP non-200 JSON refusal preserves its plain `error_code` without applying the body `code` preference or establishing decrypted challenge details. No failure data becomes a success receipt.

The optional private fields are:

```ts
interface DesktopTwoFactorChallengeData {
  phonenum?: string;
  count_down?: number;
  time_left?: number;
  introduction?: { formatted?: string };
}
```

They preserve the installed names. `count_down` and `time_left` are milliseconds; no local clock or resend schedule is created. Local bounds are 128 UTF-8 bytes for `phonenum`, 16 KiB for `introduction.formatted`, and nonnegative safe integer countdowns no larger than 2,147,483,647. Unknown fields are excluded. A malformed known field makes the whole private detail result unavailable while retaining the refusal. An entirely unknown object likewise returns undefined. These bounds are SDK guards, not measured server limits.

`introduction.formatted` is an opaque string and may contain markup. The installed UI applies its own sanitizer before rendering it. The SDK performs no HTML rendering or sanitization and promises no safe display policy. Phone and introduction data are private; they are absent from enumerable error fields, ordinary string/JSON error output, stack messages and causes. The OTP is not stored in the result/error. Only calling `challengeData()` retrieves those private details; the application must decide how to use them and protect any copies.

Observed provider constants are invalid OTP `18015`, OTP retry limit `18021`, SMS quota `18033`, rejected OTP `18073`, and require OTP `18076`. These are source observations, not proof that any account receives every challenge. Local `-1/-2/-3` screen codes are not synthesized as remote responses. Successful acknowledgments can carry unused decoded data or have absent/falsy outer `data`, matching the installed account decoder.

## Exact wire and evidence

The operation is an unsigned GET, distinct from signed password and login requests:

```text
GET {ownedAuthOrigin}/api/update/setting/2FA?zpw_ver=…&zpw_type=…&params=…
params = account-AES-CBC(JSON.stringify({
  updateType: 1|2, submitOTP: 0|1, otp?: callerOtp, language, imei
}))
```

There is no `signkey`, separate phone/password member, ParamCipher, POST form or automatic fallback. It uses the account AES-CBC key, zero IV and PKCS7 padding. Redirects are refused. The Desktop connection's existing configured response size limit and request deadline cover fetching and response-body consumption.

Evidence uses installed Desktop 26.11.10 build 26.11.10.3400 SHARED member `default-login-main-startup-shared-worker-znotification.4bb5e1e2c2e9bab4f7b3.js`, SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`, rehashed independently before implementation. All anchors are zero-based UTF-8 bytes. [Artifact identity](desktop-evidence.md)

| Source bytes | Evidence |
| --- | --- |
| `12413461`–`12413750`, `12404366` | Auth-origin GET builder, command 12066, common parameters, account-AES encoding and IMEI injection. |
| `5710913`–`5713000` | Controller's on/off update types and OTP/non-OTP payloads. |
| `16124600`–`16125550` | Real API adapter adds language, checks standard account response and separately decrypts rejected `error.data`. |
| `14770134`–`14770630` | `ptcT` maps nested decoded code/data into controller errors. |
| `13736118`–`13737300` | Standard nested account response decoder: outer and inner failures, accepted falsy outer data. |
| `5714100`–`5714800`, `7124770`–`7125360` | Private phone, countdown, introduction object/formatted string, and retry-time consumers. |
| `7125863`–`7126534`, `7131188` | Explicit confirmation, entered-OTP submission, resend action and settings switch. |
| `7120000`–`7120830`, `7122300` | Numeric OTP input and UI-owned sanitized introduction rendering. |
| `15870137`, `12726909` | Provider/local error constants and API/adapter wiring. |
| `16721946` | Account AES-CBC/zero-IV/PKCS7 implementation. |

`test/desktop-two-factor.test.mjs` uses synthetic account keys, cookies, OTPs and provider responses. It independently decrypts exact request fields and covers both encrypted error levels, nested mapper selection, private getter copying/leak prevention, unusable/unknown challenges, acknowledgment and uncertainty, invalid input, branding, closed/busy/cancelled connections, response bounds and body deadlines. No real OTP, SMS, captcha, enrollment, setting change or account request was performed.
