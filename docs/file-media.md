# Forward an existing ordinary file

`forwardFile(api,input)` sends one ordinary existing-file record from metadata selected by the application. It uses the authenticated account API and does not discover an original message or access its file bytes.

```ts
import { forwardFile, FileForwardError } from 'zalo-personal-sdk';

try {
  const result = await forwardFile(api, {
    threadType: 'user', threadId: selectedUserId, clientId: stableClientId,
    source: {
      url: selectedSourceUrl, fileName: 'report.pdf', extension: 'pdf',
      size: '9007199254740993',
    },
    ttl: 0,
    signal,
  });
  // result.msgId is an exact provider acknowledgment ID, not delivery proof.
} catch (error) {
  if (error instanceof FileForwardError && error.outcomeUnknown) {
    // Reconcile this client action before deciding on a separate explicit attempt.
  }
}
```

Supply a stable fresh positive safe numeric client action ID for each new submission. The helper never generates an ID or replays a request after an uncertain outcome. A process-local lease prevents concurrent reuse of the same API/client ID within this helper and is released on every terminal path; it does not coordinate other helpers, processes or the official client.

## Exact source and request

The source contains required `url` and optional `fileName`, `extension`, `checksum`, `size`. Own undefined means omission; explicit null is retained. No rich `fType`, folder `fdata`, thumbnail or `isClone` defaults are added. Filename strings alone are normalized to NFC, including preserving empty text. Path-like metadata is not stripped or read as a filesystem path. Extension is already caller-selected metadata: no fallback is derived, case is preserved, and filename normalization does not change it.

One file-service POST uses `/api/message/forward` (11199) for direct `toId` plus IMEI, or `/api/group/forward` (11818) for `grid` plus `visibility` without IMEI. Group routing removes one optional lowercase `g` prefix. The common query and account-AES form `params` contain numeric `clientId`, `ttl`, `zsource:-1`, numeric `msgType:1`, and JSON-text `msgInfo` with only the supplied five source members and optional reference. This numeric1=file domain differs from batch text `mforward`'s string type `'1'`.

`referenceLog` becomes the nested JSON string `reference:JSON.stringify({type:3,data:log})`; empty text is preserved. `decorLogJson` is validated as one JSON-object text and sent unchanged as outer `decorLog`. The operation requires HTTP200 and rejects redirects/Location, redirected responses or a changed response URL before body use, using the shared restricted transport. Bodies rejected by redirect admission are cancelled when available; the strict HTTP200 decoder gate adds no separate cancellation guarantee.

The helper performs no HEAD, source fetch, renewal, clone selection, upload/reupload, E2EE downgrade/selection, key lookup, local echo or multi-target operation. [Explicit renewal](attachment-renewal.md), initial file upload/send through the account API, [prepared encrypted forwarding](e2ee-forwarding.md) and the official client's clone/expired-file workflow remain separate operations.

## Declared input policy

Input/source are ordinary own-data records with exactly the declared keys; Proxy/array/class/accessor/unknown fields reject with fixed TypeError before dispatch. Null-prototype records are supported. Optional own undefined means omission, including direct `visibility:undefined`; defined direct visibility is invalid.

- All active strings must preserve valid UTF8. Source URL and filename are bounded to64KiB; filename is checked before and after NFC. Extension is bounded to256UTF-8bytes, including empty. These are SDK limits, not provider claims.
- URL is nonempty HTTP(S), without credentials, whitespace, controls or backslashes. Its original spelling/query/fragment is preserved. Explicit E2EE/PCloud session query names, decoded/case variants, legacy names and literal protected-session markers are rejected without stripping or reinterpreting them.
- Checksum is omitted/null/empty or exactly32 case-preserved hexadecimal characters. It is supplied metadata, not a computed MD5, verified resource identity or ownership proof.
- Size is omitted/null, a nonnegative safe integer number, or1–40 decimal digits. Large/leading-zero strings stay exact and never pass through Number. No upload/provider size limit or native clone threshold is inferred.
- Destination is positive decimal text up to40digits, preserving leading zeros when nonzero. TTL and group visibility are nonnegative safe integers with explicit SDK defaults0. No official-client settings/cache is consulted.
- Reference/decor text is bounded to64KiB. A genuine caller AbortSignal is bridged privately without forwarding caller accessors, methods or reason. There is no generic response-byte/default deadline guarantee; the application supplies cancellation policy.

## Acknowledgment and uncertainty

`FileForwardResult` contains exact string `msgId`, optional qualified `url`, and an owned shallow frozen raw acknowledgment. A usable ID is a positive safe numeric value converted to text or positive decimal text up to40digits with original leading zeros retained. Optional URL projects if null or valid UTF8 text up to64KiB; other values remain raw without discarding a usable ID. Unknown nested extras remain shared and unfrozen. No URL liveness, receipt, recipient rendering or native database commit is inferred.

`FileForwardError(code,submitted=false,outcomeUnknown=false,providerCode?,status?)` provides fresh fixed errors. Codes are `busy`, `aborted`, `unsupported-service`, `request-failed`, `submission-unknown`. Pre-abort/busy/missing-service are not submissions. After handoff, only a safe nonzero refusal decoded from this current provider envelope is a known failure (`request-failed,true,false`). Other transport/HTTP/body/schema failures yield `submission-unknown,true,true`; cancellation is `aborted` with false/false before handoff or true/true afterward. A caller-created/reused error or zero provider code cannot establish current refusal. Source/destination/body/URL/cause material is not copied into outward errors. Verify uncertain outcomes before retrying explicitly.

Static evidence is installed Desktop26.11.10 SHARED12091835–12092336 (five-field projection),12458543–12460737 (transform/request),16769553–16769665 (filename NFC),16788599 (reference) and4375402–4375637 (file completion). The separate rich producer3138095 onward and async clone/renew/share layers are not silently merged into this API. Local fixtures/types verify SDK behavior; live source acceptance, asset lifetime and delivery remain unverified. Photo/album and rich multi-target forwarding remain open.
