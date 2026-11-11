# Desktop account settings

`getDesktopAccountSettings(connection, signal?)` reads the installed Desktop account-settings route through a live SDK-owned `DesktopSessionConnection`. `setDesktopAccountSetting(connection, change, signal?)` submits one explicitly selected setting. These operations use the connection's approved auth origin, normal account cookies/key and bounded HTTP transport. They do not use a guessed `auth` service-map entry or an arbitrary caller URL.

```ts
import { getDesktopAccountSettings, setDesktopAccountSetting } from 'zalo-personal-sdk';

const settings = await getDesktopAccountSettings(connection, signal);
// Values remain in provider form; no missing setting gets a synthesized default.
const current = settings.known.show_online_status;

await setDesktopAccountSetting(connection, { key: 'show_online_status', value: 0 }, signal);
```

The read is auth-origin GET `/api/setting/me` (**12113**) with exactly the common client type/version query and **no `params`**, IMEI or language. This differs from pinned upstream `getSettings()`, whose Web path encrypts `{}`. The write is auth-origin GET `/api/setting/update` (**12033**) with common query plus account-AES JSON in query `params`. Its GET verb still represents a mutation. Exactly one established field is serialized; no arbitrary input spread, signature, IMEI or language is added.

Both paths require HTTP **200**, check the standard outer/inner encrypted account envelopes, and keep the configured connection body limit, deadline, approved origin, cancellation and redirect protections. Normal `utils.request` response-cookie handling remains active. The helper does not manually rotate tokens, save/clear a `SessionStore`, retire the connection, start a listener, change an app cache or read settings back after a write.

## Read snapshot and explicit writes

`DesktopAccountSettingsSnapshot` contains complete `raw` settings and a conservative `known` projection. The wrapper, shallow raw own-data copy and known projection are frozen. Nested unknown provider objects are retained by reference and are not recursively cloned/frozen. Complete unknown keys and unsupported known-key values remain in `raw`; they are omitted only from the optional `known` projection. Empty `{}` is valid. A missing, null, array or other non-object read result is invalid, rather than an apparent empty settings response.

| Read key | Accepted `known` value | Selected write key / input values |
| --- | --- | --- |
| `show_online_status` | Boolean or numeric 0/1, unchanged | Same key; numeric 0/1 |
| `display_seen_status` | Boolean or numeric 0/1, unchanged | Same key; numeric 0/1 |
| `add_friend_via_phone` | Boolean or numeric 0/1, unchanged | Same key; numeric 0/1 |
| `add_friend_via_qr` | Boolean or numeric 0/1, unchanged | Same key; numeric 0/1 |
| `add_friend_via_group` | Boolean or numeric 0/1, unchanged | Same key; numeric 0/1 |
| `add_friend_via_contact` | Boolean or numeric 0/1, unchanged | Same key; numeric 0/1 |
| `display_on_recommend_friend` | Boolean or numeric 0/1, unchanged | Same key; numeric 0/1 |
| `archived_chat_status` | Boolean or numeric 0/1, unchanged | **`archivedChatStatus`**; numeric 0/1 |
| `quick_message_status` | Boolean or numeric 0/1, unchanged | **`quickMessageStatus`**; numeric 0/1 |
| `view_birthday` | Numeric 0/1/2 | Same key; 0 hide, 1 full date, 2 day/month |
| `receive_message` | Numeric 1/2 | Same key; 1 everyone, 2 friends |
| `accept_stranger_call` | Numeric 2/3/4 | Same key; 2 friends, 3 everyone, 4 friends and contacted strangers |
| `show_seen` | Boolean only | No write in this helper |
| `setting_show_stranger_msg_directly` | Safe raw integer, no derived enabled meaning | No write in this helper |
| `setting_2FA_status` | Safe raw integer, no derived enabled meaning | No write in this helper; security updates use the separate 2FA operation |

The 12 write-key forms and their literal value unions come from current UI/manager producers. Boolean write inputs, numeric strings and other keys are rejected before I/O. Read projection is an SDK interpretation, not a claim that the provider only returns these forms. In particular, the source's strict `show_online_status===false` consumers differ from UI truthiness; the helper preserves Boolean false versus numeric zero. `show_seen` is distinct from `display_seen_status`. No timestamps, revisions or missing defaults are inferred from values or registry IDs. Unsafe integer JSON tokens stay exact strings in raw data through the shared lossless parser.

A successful write returns frozen `{submitted:true,acknowledged:true}`. The source consumer ignores response-data layout, so a successful empty acknowledgement is accepted and no settings snapshot is fabricated. An acknowledgement is not independent proof of the resulting setting value, UI behavior or cross-device convergence.

## Passive updates

`extractDesktopAccountSettingsEvents(frame)` is a pure operation for caller-owned decoded realtime frames. It returns ordered events without subscribing, fetching, acknowledging, saving a cursor or updating an application store:

```ts
const events = extractDesktopAccountSettingsEvents(frame);
for (const event of events) {
  applicationChooseHowToHandle(event.settings.raw, event.settings.known);
}
```

Only version-1 ordinary controls **601/603**, a valid byte subcommand, successful transport metadata and an **own numeric inner `error_code:0`** enter this path. Missing inner status or string `'0'` is not silently accepted. Active reset markers suppress the controls, as the installed normal-control handler takes its reset branch instead; unsupported reset forms are also excluded conservatively. This is transport validation, not a settings revision check.

Each selected row is `{content:{act_type:'my_settings',act:'update',data:patch},...}`. Object data is accepted directly. String data is parsed once only when its first character is `{` or `[`; whitespace is not trimmed and another JSON-string layer is not unwrapped. The settings consumer requires an object patch, so parsed arrays/null/primitives do not produce settings events. Malformed matching JSON or unsafe custom-frame accessors return a fixed empty result.

Each event contains `controlIndex`, the original `rawControl` and `rawContent` references, and a settings snapshot using the same raw/known projection as HTTP reads. The raw row/content references intentionally preserve unknown wrapper fields and are neither cloned, frozen nor mutated. Patch copying inspects own data descriptors; it does not invoke unknown getters or `toJSON`. Its frozen shallow copy preserves raw unknown nested values by reference. Numeric-looking `version`, `ts`, `timestamp` and `controlId` fields remain opaque raw metadata; no units, stale-event rule, deduplication or sorting is assigned to them. Repeated patches remain repeated in provider order.

Native integration emits the complete raw patch first, filters recognized keys into its own cache, and broadcasts a full recognized snapshot with changed keys. Its app reducer then replaces local privacy state. This extractor does not recreate that app-owned cache or reducer, and does not optimistically merge an HTTP write acknowledgement with a passive event.

## Bounds and lifecycle

HTTP response bytes use the connection's configured `maxResponseBytes`. Snapshots admit at most 1,024 enumerable own patch/settings keys. The shared selected-control reader admits at most 20,000 own control rows; selected `data`/`content` strings each have a 65,536 UTF-8-byte limit and a combined 1,048,576-byte budget per frame. Unrelated act types are excluded before their data is inspected or charged to that selected-text budget. These are SDK resource policies, not measured provider limits.

Input fields are captured before asynchronous work. A write holds the existing account mutation lock shared with renewal, sign-out, password and 2FA operations, and releases it on every completion/failure. Reads take no mutation lock. Both check the owned connection identity and closed state; immediately before `utils.request`, they check cancellation and live connection state again. No concurrent operation is queued and no automatic retry or redirect replay occurs.

`DesktopAccountSettingsError` has fixed `code`, `submitted`, `outcomeUnknown`, optional safe-integer provider/HTTP codes and an optional fixed failure `reason`. It contains no setting values, encrypted query, provider body, token/key or underlying cause. Invalid local input, an unbranded/closed connection, pre-cancellation and a busy write have no handoff. A usable nonzero provider refusal is known. Once a write is handed to the authenticated request adapter, a timeout, cancellation, close, HTTP/network failure or unreadable response can leave the result unknown; it does not trigger a retry, rollback or connection retirement. Handoff is conservative adapter-call evidence, not proof of remote receipt. Read failures do not claim a potentially applied mutation. Reconcile an unknown write outcome before another explicit attempt.

Provider-refusal metadata is accepted only from the shared account decoder operating on an owned `Response` of already bounded text. The account key and owned response are prepared before that narrow decoding boundary; the decoder receives no raw caller signal. The original network/body reader still owns cancellation, close and deadline handling. A cancellation accessor, setup/body exception or caller-created public protocol error cannot supply a provider refusal. Before handoff, all provider/HTTP metadata is discarded. After handoff, local failures can retain an actual HTTP status but still leave a write unknown. A complete captured acknowledgement is not erased by a later cancellation during finite owned-text decoding.

## Evidence and verification boundary

Installed Desktop **26.11.10**, build **26.11.10.3400**, exact packed SHARED SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`; MAIN SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. Zero-based UTF-8 byte anchors:

| Contract | SHARED byte anchor |
| --- | --- |
| Auth-origin no-param read and one-object AES-query write | 12,413,100–12,413,460 |
| Common query / direct auth-domain command registration | 12,402,415 / 12,404,312 / 2,695,900–2,696,350 |
| Strict HTTP200/nested account response decoder | 13,736,118–13,737,570 |
| All 15 recognized names and setting registry | 15,853,500–15,855,500 |
| Active settings fetch/write/merge/cache/filter/sync | 15,861,500–15,864,300 |
| Bootstrap my_settings merge | 12,075,303 |
| Active privacy UI numeric toggle conversion and choices | 7,194,985–7,203,300 |
| Archived/quick-message camelCase write exceptions | 4,542,802 / 14,343,455 |
| Strict false seen / stranger numeric1 / 2FA truthiness consumers | 7,846,128 / 14,020,750–14,022,200 / 5,713,171–5,715,400 |
| Successful control dispatch/reset branch / command constants | 3,001,900–3,003,850 / 7,612,170–7,612,230 |
| Control grouping and first-character JSON / my_settings dispatch | 12,027,012 / 12,029,527 |
| Application-store dispatch and snapshot replacement | 4,570,748 / 4,776,068 |

The source feature flag defaults on but can be remotely overridden. An explicit SDK read/write does not assert that the corresponding Desktop UI is enabled for this account. This feature excludes application configuration/notifications, per-conversation settings, archived-conversation list CRUD, password/reset/OTP/2FA changes and credential persistence. Existing pinned upstream settings helpers remain available with their Web request form. The exact installed source fallback is reused without application execution or REA setup retry.

Offline fixtures independently decrypt every selected write, verify the parameterless owned-origin read and all 15 projections, empty/error acknowledgements, normal cookie lifecycle, shared mutation lock, final live guard, bounded body/deadline/abort/close, and passive own-field/status/reset/order/raw/accessor/text-budget behavior. Four read/write regressions for locally thrown public protocol errors before and after handoff were retained and reproduced against the original source before narrowing provider-evidence handling.

On 6 November 2026, one guarded read through the saved user-approved Desktop HTTP session succeeded after two bootstrap requests. The result contained 14 raw own keys and 14 recognized own keys; no values or names were logged. The guard permitted only those bootstrap GETs and one common-query-only `/api/setting/me` GET on the approved auth origin, with redirects refused. This check opened no socket, submitted no settings change and did not save or clear credentials. Selected writes and passive updates remain fixture-tested; the read does not prove write acceptance or cross-device convergence.
