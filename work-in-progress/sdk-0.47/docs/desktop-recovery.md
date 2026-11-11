# Caller-controlled Desktop password recovery

`recoverDesktopPassword(options)` runs the current installed recovery flow: confirm the selected phone, request entry into the OTP stage, validate a user-entered OTP, answer an optional security question, submit a new password, bootstrap the returned Desktop session, and optionally persist it. It does not discover account files or borrow an existing account key.

```ts
import { recoverDesktopPassword } from 'zalo-personal-sdk';

const result = await recoverDesktopPassword({
  authOrigin: 'https://wpa.zaloapp.com',
  imei: applicationDeviceId,
  computerName: applicationDeviceName,
  userAgent: applicationUserAgent,
  phoneNumber: userSelectedNationalPhoneNumber,
  isoCountryCode: userSelectedCountryIsoCode,
  timeZone: userSelectedTimeZoneOffset, // e.g. '+05:45'; no host-locale guess
  async onChallenge(challenge, { signal }) {
    const privateDetails = challenge.details();
    switch (challenge.kind) {
      case 'confirm-phone':
        return await applicationConfirmPotentialCodeDispatch(privateDetails, signal)
          ? { action: 'confirm-send-code' } : { action: 'cancel' };
      case 'otp':
        return { action: 'submit-otp', otp: await applicationAskForOtp(privateDetails, signal) };
      case 'security-question':
        return { action: 'answer-question', selectedValues: await applicationAskQuestion(privateDetails, signal) };
      case 'new-password': {
        const { newPassword, repeatedPassword } = await applicationAskNewPassword(privateDetails, signal);
        return { action: 'set-password', newPassword, repeatedPassword };
      }
      case 'protocol-retry':
        // This may repeat a code request, OTP validation, question submission or reset.
        return await applicationConfirmPlainProtocolRetry(privateDetails, signal)
          ? { action: 'confirm-protocol-retry' } : { action: 'cancel' };
    }
  },
  async persist({ session }, { signal }) {
    signal.throwIfAborted();
    await applicationSaveDesktopCredentialsAtomically(session);
  },
});

if (result.kind === 'connected') {
  // Existing normal SDK operations use result.connection.api.
  // Application owns the connection and eventually calls result.connection.close().
} else {
  applicationShowRecoveryRequirement(result.requirement, result.resetAcknowledged);
}
```

The example's phone selection, confirmation, OTP/password entry, rendering, validation and storage belong to the application. A configuration read occurs before the phone confirmation callback; a potentially code-sending operation does not. Every code/reset submission requires the matching explicit callback action. The SDK does not automatically request another code, send an SMS/voice/Zalo-code request, switch delivery channels, answer a question, or start QR sign-in.

## States and outcomes

The high-level result is either `{kind:'connected',connection,trust:'not-enrolled'}` or `{kind:'requires-other-method',requirement,providerCode?,resetAcknowledged}`. Requirements include `captcha`, `otp-or-mobile-confirmation`, `otp`, `qr`, `app-upgrade`, `security-question-quota`, `restart-recovery`, `certificate-only`, `unsupported-security-question`, and `protocol`. These are stopping points, not guessed continuations.

`resetAcknowledged` is present on every requirement result. True means the final reset envelope had a successful provider status before the flow became unavailable; it is not an independent readback proving the password's effect. A certificate-only successful reply sets it true and completes neither login nor enrollment. Such a result must not be interpreted as “nothing happened” or permission to replay the reset. Successful final envelopes with unusable credentials likewise produce an error rather than an invented account/session. An uncertain submitted reset never retries automatically.

| Stage | Caller interaction and source-supported behavior |
| --- | --- |
| Confirm phone | `confirm-phone` details contain the bound phone, country, explicit timezone and `mayDispatchCode:true`. Only `confirm-send-code` calls the phone route. |
| Enter OTP | `otp` details always say `deliveryConfirmed:false`. Ordinary phone success and phone code `18073` both advance here; neither proves receipt or successful delivery. The special code is retained as private challenge metadata. |
| Validate OTP | Only a caller-entered decimal string is submitted. Wrong OTP produces a new callback at this same stage with the safe numeric provider code. It requests no new code. |
| Security question | When OTP success has numeric `requireSEQ:1`, display provider choices and require the exact number of distinct selected values. Submission uses literal empty password fields and the privately retained token. |
| Set password | Require identical raw new/repeated strings, then trim and independently encrypt each under the OTP-issued key. The callback receives bounded password-rule metadata. |
| Complete login | Only a final session-token response proceeds to explicit credential validation, normal Desktop bootstrap and optional save. No QR pairing occurs. |

Known provider refusals can return to the same caller-controlled interaction. This also applies after a confirmed protocol retry: the original phone/OTP/question/password interaction is restored, and the consumed protocol handle is not offered again. Each further submission requires a fresh matching callback action and consumes the operation budget. Question quotas, expired/missing/invalid reset-token codes, captcha/phone-confirmation/QR requirements and other supported-method boundaries terminate as explicit requirements. Unknown provider codes do not invent a delivery or verification method. `requireSEQ` values other than omitted/null/numeric zero or numeric one stop as `unsupported-security-question`.

Current LOGIN has no active recovery resend/channel-selection consumer. There is no resend API in this coordinator. Returning to a phone submission after a known refusal still requires explicit confirmation; after advancement to OTP, the transport cannot dispatch another phone request. Starting another attempt is a separate application decision.

Recovery uses the installed password/no-trust completion path. `trust:'not-enrolled'` means this flow did not enroll or authenticate a companion identity; it is not a statement about the account's other devices. Returned device data is not treated as pairing evidence. Native local preference writes and trust-identity dormancy changes are not reproduced.

## Private attempt material and exact crypto

The OTP response must provide both a nonempty `token` and a valid Base64 `enk`. Only this freshly issued key is accepted for final password encryption. Standard 16-, 24- and 32-byte AES keys are supported; absent, malformed or unsupported material terminates the attempt with `invalid-response`. A ParamCipher key, a previously signed-in account key, a device key, or a token from another attempt is never substituted.

The security-question request sends **literal empty** `passwd` and `re_passwd`; it does not encrypt empty strings. It sends `question_type`, `answer_type` and comma-joined selected `answers`, with no `quest_cert` or `cptch_cert`. The source ignores a rotated token/key in the intermediate question response; this implementation retains the original OTP material and the acknowledged selected answers for the final reset.

Final password input follows the current recovery form's distinct policy:

1. New and repeated strings must match exactly before trimming. Matching only after trimming is insufficient.
2. Both must be well-formed Unicode, nonempty after JavaScript `trim()`, and within 4096 UTF-8 bytes. Lone UTF-16 surrogates reject rather than changing a password through replacement. No NFC or case normalization is applied.
3. Individually AES-CBC-encrypt each trimmed password with the attempt's OTP `enk`, a zero IV and PKCS7 padding, returning Base64.
4. Place those ciphertexts in the final reset fields, then apply the selected ParamCipher mode to the entire request.

This does not use ordinary password-login PasswordCipher or the authenticated password-change input policy. Even in plain ParamCipher mode, final password fields remain individually encrypted under the OTP-issued AES key.

Server `passw_rules` are exposed as bounded opaque metadata in the new-password challenge. Known strings `regex`, `msg` and `msg_en` and provider extensions remain available. The SDK does not execute arbitrary provider regexes in its process, fetch rule assets, invent a strength policy, or claim that callback input passed provider rules. Applications can present or independently validate the policy; the provider enforces acceptance. The installed form evaluates rules on raw input before its final trim/encryption, which an application seeking the same UI behavior should account for.

## Protocol renegotiation requires confirmation

Every route uses the original outer status to distinguish protocol negotiation from an inner provider refusal. An original outer `19000` on an encrypted mutation returns a private `protocol-retry` handle; it does not change modes or dispatch again. The callback must explicitly choose `confirm-protocol-retry` before the same operation is sent once in plain ParamCipher mode. The same HTTPS origin, phone, identity, action fields and OTP-issued key remain bound. Plain mode then persists for this attempt.

This can repeat a potentially code-sending request, consume an OTP again, resubmit a question, or repeat a reset request. The private handle identifies exactly that attempt/stage and can be used only once. Copied, foreign, replaced or consumed handles reject. A second outer19000 in plain mode stops as a protocol requirement. A decrypted inner19000 never offers a downgrade; it stops without replay. Network failure, HTTP failure, malformed/oversize response, cancellation and timeout never create protocol-retry handles.

The native implementation automatically retries outer19000. Requiring a caller decision is a deliberate application-facing boundary for recovery mutations. This flow never infers that a protocol response proves code delivery or password effect.

## Errors, deadlines and storage ownership

`DesktopRecoveryError` has fixed messages and safe public fields: `code`, `stage`, `submitted`, `outcomeUnknown`, optional numeric `providerCode`, `resetAcknowledged`, and optional fixed bootstrap `reason`. `providerDetails()` explicitly returns a defensive copy of private provider data when available; it is absent from ordinary string/JSON/inspection output. No original cause, request URL, code, token, password, phone number or OTP-issued key is attached to public error fields. Applications must validate and protect private getter results.

All four recovery action routes are GETs. Submission tracking uses operation intent, not HTTP method. `submitted:true` means that failing stage was handed to the adapter, not proof that the provider received it. `outcomeUnknown:true` means that submitted stage ended before a definite provider outcome could be decoded. Phone dispatch, OTP consumption/key issuance, question-only submission and final reset all have this uncertainty boundary. Unknown outcomes terminate the attempt and are never replayed to discover what happened. A valid status-zero OTP response missing its required continuation material is a known accepted-but-unusable result: `submitted:true`, `outcomeUnknown:false`, and no final reset.

The total lifetime includes UI callbacks, every network call, bootstrap and persistence. Callback context carries a combined abort signal; the application must recheck it after its own awaited work before side effects. Callback replies are captured inside the callback error boundary, including action/value/password getters and bounded dense selected-value index reads. Throwing getters become fixed `callback-failed` errors; sparse arrays cannot supply guessed empty answers. Request deadlines cover both headers and bounded body reads, including adapters that ignore signals. A confirmed protocol retry reports its original mutation stage on timeout or unknown outcome. Late replies are cancelled and cannot repopulate a cleared jar. Cookie counts, response URLs, redirects and Location headers are checked; redirects and credential forwarding through the browser are disabled.

Identity, auth origin, phone/country/timezone, callbacks, bootstrap adapter and key bytes are captured before the flow awaits application code. Exact service-origin overrides are validated and normalized before transport creation, callbacks or network work; invalid input cannot be discovered only after a reset. A callback cannot redirect bootstrap by changing the original options object. A final provider acknowledgment is copied to local state before a queued cancellation check, so approved and certificate-only completion cannot lose that reconciliation flag. The transport serializes operations and privately owns the recovery key, token, question answers, cookie jar and pending protocol handle. Closure/expiry cancels pending calls and clears owned mutable key material, token/answer references and cookies. JavaScript strings and caller-retained copies cannot be reliably zeroed.

Optional `persist` is awaited before returning the connection. An application can instead retain the in-memory connection and explicitly save its snapshot later. There is no mandatory storage gate. Persistence or event-callback failure closes an owned new connection, while `resetAcknowledged:true` records the preceding accepted reset. It cannot undo a password change, revoke the remotely issued session, or roll back an already committed caller write. Do not repeat recovery to repair a local save failure. Neither the high-level result nor a private getter returns a verified companion.

Defaults are ten minutes total lifetime, 60 seconds per request, 2 MiB per response, and 24 explicit mutations including confirmed protocol retries. Maximum configured limits are one hour total lifetime, ten minutes per request, 8 MiB per response, and 100 mutations. SDK input bounds are 6–32 decimal phone digits, uppercase two-letter ISO country code, explicit `±HH:MM` offsets through 14:00, and 1–64 decimal OTP digits. Leading zeros and fractional offsets are preserved. No `+07:00` default, host timezone, phone-prefix conversion or provider code-length policy is guessed.

Question bounds are 1000 choices, 16 KiB display strings, 4096 UTF-8 bytes per value and nonnegative integer question fields through 65535. Choice values must be nonempty/distinct and contain no comma; safe numeric values normalize to strings and large numeric JSON values retain exact decimal strings. These are SDK usability/budget bounds, not measured server limits. Missing/null display fields and numeric question fields use the installed empty/zero defaults. No thumbnails are fetched. Password-rule metadata is capped at 100 entries with 16 KiB per known string. None of these local guards proves provider eligibility.

For applications owning the state machine directly, `createDesktopRecoveryTransport(options)` exposes `getServerInfo`, `requestCode({confirmed:true})`, `submitOtp`, `answerQuestion`, `resetPassword`, `retryProtocol(issuedHandle,{confirmed:true})`, and `close`. It performs no request on construction. Its approved raw result contains secret session material and cookies for explicit credential/bootstrap handling; the high-level coordinator returns only the owned connection. Methods are available only in their correct stage; the key/token from one transport are never imported by another.

## Exact requests and source evidence

All routes target the exact caller-approved HTTPS auth origin. The four action routes use the pre-auth ParamCipher envelope and sorted MD5 signing; none uses account `zpw_*` common queries or the `kCOK` account-response wrapper.

| Operation | GET path | Plain fields before optional ParamCipher |
| --- | --- | --- |
| Verify phone | `/api/register/verifyPhone` | `{imei,phone_num,iso_code,active_type:1,computer_name,language,context:2,cptch_token:null,cptch_answer:''}` |
| Validate OTP | `/api/register/validateActiveCode` | `{imei,computer_name,phone_num,iso_code,otp_code,time_zone,reset_passw:1,active_type:3,language}` |
| Answer question | `/api/login/loginByResetPwd` | `{phone_num,iso_code,passwd:'',re_passwd:'',imei,time_zone,language,computer_name,resetpwd_token,question_type,answer_type,answers}` |
| Final reset | `/api/login/loginByResetPwd` | The same base fields with individually encrypted `passwd/re_passwd`, plus acknowledged question fields when applicable. |

Encrypted requests preserve the actual JSON null for `cptch_token`. Native `_get` and `_constructUrlParams` encode every own value, so a plain GET renders that field as the literal string `null`, and the sorted signature includes `String(null)`. It is not omitted or changed to an empty string. The shared auth helper's field type was widened only to admit null; its runtime crypto/signature behavior is unchanged.

Operations `verifyphone`, `validateactivecode` and `loginbyresetpwd` use lowercase MD5 of `zsecure` + operation + values sorted by field name. ParamCipher wraps JSON with `zcid`, `zcid_ext`, `enc_ver:'v2'` and `params`; outer `type`, `client_version` and `signkey` are added after wrapping. Replies use that request's ParamCipher key before the form-style provider status is interpreted. Configuration supports both `setttings` and `settings` and optional absent flags when an explicit mode is selected; unusable auto configuration fails before code dispatch.

Evidence is installed Desktop 26.11.10 build 26.11.10.3400. The current ASAR header parser read only the two selected members, checking their integrity metadata and full expected SHA-256 values. Existing exact packed-byte fallback was reused; no REA setup retry, native process, app account file, recovery request or private credential was used.

| Member | Bytes | SHA-256 |
| --- | ---: | --- |
| LOGIN `pc-dist/lazy/login-startup.65eb8d358ddd85ba3f21.js` | 452703 | `0929a20e9181fbed984ed70aaa51c9aa55b3936eeffe10a30623f34e08080b1e` |
| SHARED `pc-dist/lazy/default-login-main-startup-shared-worker-znotification.4bb5e1e2c2e9bab4f7b3.js` | 17605735 | `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` |

Anchors are zero-based UTF-8 byte offsets:

| Source | Evidence |
| --- | --- |
| LOGIN `422788`–`426328` | Current phone step, explicit active_type1/context2, null token/empty captcha answer, phone18073 advancing without a delivery assertion. |
| LOGIN `413397`–`415950`, `416600`–`417957` | Current OTP validation, reset_passw1/active_type3, OTP-issued token/enk and optional question progression/answer retention. |
| LOGIN `373080`–`377750` | Question normalization, exact selected-value count, comma join and literal-empty-password reset call. |
| LOGIN `417957`–`422788`, `426328`–`428200` | Raw confirmation equality, trim/per-field AES, final zpw_sek success versus certificate-only gap, and recovery state chain. |
| LOGIN `50415`–`51350` | Password/no-trust completion path and raw refresh-token staging. |
| SHARED `12479689`–`12480218` | Verify-phone request builder, command11330. |
| SHARED `12482004`–`12482480`, `12483257`–`12483765` | Validate-OTP and reset builders, commands11333/12021. |
| SHARED `12404700`–`12406945` | ParamCipher configuration/wrapping, reply decryption and original-outer19000 native retry. |
| SHARED `12408289`, `12408778` | GET construction and literal null query serialization. |
| SHARED `16720523`, `16721939`, `16789501` | Temporary AES key installation, Base64/AES-CBC/zero-IV/PKCS7 primitive, and password-rule retrieval. |
| SHARED `13738005`–`13739080` | Auth/provider error constants. |

Fixtures independently verify/decrypt signed wire requests and the two encryption layers with synthetic keys. They cover normal/plain flow, stage-specific constants, phone18073, token/key provenance, literal-empty question requests, ignored intermediate rotations, exact raw/trim password behavior, explicit wrong-answer retries, unsupported/certificate-only stops, outer versus inner19000, stage-bound one-use protocol handles, all-stage retry/refusal behavior, per-stage timeout/abort uncertainty, callback lifetime, sparse/index-getter and callback-reply privacy boundaries, preflight origins, acknowledgment-before-cancellation, and save cleanup. The retained first runtime capture had 34 cases: 17 passed and 17 exposed the staged retry, sparse selection, acknowledgment, callback-getter and origin-preflight gaps before their corrections. An additional selected-value index-getter regression covers that same callback snapshot boundary. No real phone, OTP, question answer, password reset, SMS/voice dispatch, session approval or recovery account operation was submitted. Live availability, code delivery, challenge variants, server policy, reset/session side effects and certificate-only continuation remain unverified. Registration and alternative code-delivery builders have no established current LOGIN consumer and are not implemented here.
