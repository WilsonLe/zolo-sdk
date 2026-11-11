# Forward a static location

`forwardLocation(api, input)` submits one caller-selected static point to one ordinary user or group destination through the existing authenticated API. It preserves selected label/place metadata and returns the current raw reply with independently qualified optional message IDs. All 31 synthetic location fixtures pass locally; live forwarding and recipient rendering remain unverified.

```ts
import { forwardLocation, OrdinaryMessageForwardError } from 'zalo-personal-sdk';

const result = await forwardLocation(api, {
  threadType: 'group',
  threadId: selectedGroupId,
  clientId: retainedActionId,
  visibility: selectedGroupVisibility,
  ttl: selectedConversationTtl,
  source: {
    latitude: selectedLatitude,
    longitude: selectedLongitude,
    title: selectedTitle,
    description: selectedDescription,
    placeId: selectedPlaceId,
  },
  signal,
});

await applicationStore.recordLocationForward(result);
```

The application selects the destination, point, metadata and action ID. This function submits a static point; it does not assert the device's current position. Native Desktop changes a local forwarded-card flag to zero, but that flag is absent from this HTTP projection. GPS capture, map display and recipient rendering are application workflows.

## Input and wire values

Input is an exact own-data plain/null-prototype record. User destinations use `threadType:'user'`; groups use `'group'`. `threadId` is positive decimal text of at most 40 digits, retaining leading zeroes. A group may have one lowercase `g` prefix, removed before submission. `clientId` is a required fresh positive safe integer retained by the application before submission. The SDK does not generate it from the clock.

Optional `ttl` is a nonnegative safe integer in milliseconds, default zero. Source UI hour/day/week choices establish units, without establishing a universal provider enum or maximum. For groups, optional nonnegative safe-integer `visibility` defaults zero; select it from application state. User requests reject a defined visibility value. Neither group visibility nor conversation TTL is read from the installed client's cache.

`source` has exactly these selected fields:

| Input | Projection and admission |
| --- | --- |
| Required numeric `latitude` / `longitude` | `lat` / `lon`; finite numbers in [-90,90] / [-180,180], including zero and fractions. These geographic and primitive-type checks are SDK policy. Native uses `parseFloat` without those guards; numeric strings and coercions are deliberately outside this normalized point contract. |
| Optional `title` | Always emits `title`. Omitted/undefined/null/false/zero/empty string becomes `''`, matching native truthiness. Other bounded JSON values remain their actual values. |
| Optional `description` | Emits `desc` when defined, preserving null, false, zero, empty string and other bounded JSON values. |
| Optional `placeId` | Emits `placeId` when defined, with the same JSON preservation. No provider-specific Place ID grammar is inferred. |

Metadata accepts `OrdinaryForwardJsonValue`: null, Boolean, finite number, well-formed UTF8 string, dense ordinary array or plain/null-prototype string-key object. Each defined field is captured independently under 2,000 nodes, depth 16 and 64 KiB of serialized JSON. Accessors, Proxies, custom serialization, functions, BigInt, nested undefined, holes, extra array keys/own iterators and cycles reject without executing them. Noncyclic aliases are copied independently. JSON-looking strings remain strings. These preserve the source's open metadata domain; source code does not establish universal remote acceptance of every value. The caller selects ordinary metadata; opaque JSON values are not a universal secret detector.

The body always includes `appId:''`. It does not include source map URLs, thumbnails, source IDs, source card type or current-location state, and those are not public input knobs. A received location card's enum is 17; the selected forward request's discriminator is numeric 7. Raw Desktop records are not accepted as normalized points.

Optional `referenceLog` is exact primitive UTF8 text up to 64 KiB, including empty, wrapped as nested JSON text `{type:3,data:referenceLog}` in `msgInfo.reference`. Optional `decorLogJson` is complete JSON text with a nonnull object or array root, kept byte-exact as outer `decorLog`. The complete prepared params, before SDK IMEI injection, must serialize within 512 KiB. Selected values and the signal are captured before callbacks or awaits.

## One request and owned observations

The FILE service handles one account-AES form POST with common version/type query fields, redirect errors and exact HTTP 200 qualification before normal nested account decoding:

- User `/api/message/forward`: `toId`, context IMEI, `clientId`, `ttl`, `zsource:-1`, numeric `msgType:7`, JSON-text `msgInfo`, optional decor log.
- Group `/api/group/forward`: `grid`, `visibility`, `clientId`, `ttl`, `zsource:-1`, numeric `msgType:7`, JSON-text `msgInfo`, optional decor log; no IMEI or user destination field.

`zsource:-1` selects the native untracked default. The function does not reconstruct local telemetry. It makes no additional map, source-resource, preview, renewal, clone, upload, membership or encrypted-session request. Multi-recipient location orchestration remains separate from this singular send and the [TEXT/RTF, STICKER and LINK batch](message-forwarding.md).

The frozen `LocationForwardResult` has:

- `target`: captured frozen `{threadType,threadId,clientId,ttl}` describing the selected request.
- `raw`: an owned deeply frozen JSON object retaining unknown provider fields and value types.
- Optional `msgId` and `minGlobalMsgId`: independently qualified positive safe integers converted to decimal text, or positive decimal strings of at most 40 digits retained verbatim, including leading zeroes. Invalid or absent fields remain raw without a qualified property.

An empty object is still a raw observation. No required ACK schema, fallback from `minGlobalMsgId` to `msgId`, coerced `'undefined'`, provider client-ID correlation or delivery verdict is manufactured. Captured target metadata describes the request; it is not a provider echo. Native UI consumes both message ID fields but does not prove their complete server domain or presence.

Raw limits reuse the ordinary owner: 20,000 nodes, depth 32 and a cumulative 1 MiB UTF8 budget for all keys and strings. These are post-decode structure bounds, not HTTP-byte, aggregate memory or deadline guarantees. Nonobject/non-JSON/overbound replies after handoff produce an uncertain outcome rather than a guessed acknowledgment.

## Shared ownership, cancellation and uncertainty

`forwardLocation` and `forwardOrdinaryMessage` reserve action IDs together for the same API instance. An active overlapping ID is `busy` before dispatch; disjoint IDs and other APIs may proceed. Their scope does not coordinate other forwarding/send owners or processes. Every local terminal outcome releases the lease, including uncertain abort. It is not a durable replay cache: retain IDs and reconcile uncertain actions before an explicit retry.

Both helpers use `OrdinaryMessageForwardError`, with `busy`, `aborted`, `unsupported-service`, `request-failed` and `submission-unknown`. Input/API shape defects produce a fixed TypeError before I/O. SDK errors are fresh fixed messages without source/body/coordinate/URL/cause data. A private current decoded nonzero account refusal alone supplies providerCode; public or previously obtained errors cannot supply that authority. SDK-emitted status remains undefined.

The submitted marker is conservative: it precedes asynchronous cookie lookup and adapter invocation, and does not prove a wire attempt or provider receipt. Current refusal after handoff is `request-failed,true,false`; other submitted faults are `submission-unknown,true,true`. Actual abort reports its corresponding submitted/uncertain facts. Private resistant signal handling ignores caller overrides and synthetic transport abort events. Local abort settles even when an adapter ignores it, while containing late results/rejections; that is not proof of remote rollback or stopped underlying transport. No new deadline is introduced. See the [shared ordinary forwarding error contract](message-forwarding.md#cancellation-concurrency-and-errors).

## Evidence and limits

All 31 independently authored location fixtures and 164 existing forwarding, recall and protocol tests pass locally using synthetic API/HTTP data. No live location submission, map lookup or provider/recipient rendering has been verified. The original all-operations/native-client goal remains open.

Installed Desktop 26.11.10/build 26.11.10.3400 is pinned in [Desktop evidence](desktop-evidence.md). SHARED SHA256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` has location source normalization 857767, ordinary projection 12095900+, singular transform/FILE adapter 12458400–12460744, TTL helpers 13501366+, untracked source default 3445668 and group-cache visibility 3029086. Renderer STARTUP SHA256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121` registers the location handler at 1042850+ and creates/submits its per-target records at 1040050–1041710. The UI clears a local current-location bit, sequentially forwards each target and consumes `msgId || minGlobalMsgId`; the SDK preserves optional IDs independently instead of reproducing UI coercions. These are source observations, not runtime or rendering evidence.
