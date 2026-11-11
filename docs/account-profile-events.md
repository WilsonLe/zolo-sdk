# Passive account profile events

`extractAccountProfileEvents(frame)` reads alias, profile, hidden-chat and emoji-status observations from a decoded ordinary account-control frame. It is a pure function: it does not subscribe, fetch, consult the account identity, update a cache or vault, create a message, start a timer, acknowledge anything or persist state.

```ts
import { extractAccountProfileEvents } from 'zalo-personal-sdk';

const unsubscribe = feed.subscribe(frame => {
  const events = extractAccountProfileEvents(frame);
  if (!events) return;
  for (const event of events) {
    if (event.change?.kind === 'own-profile-invalidated') {
      // The application decides whether to fetch its current account profile.
    }
    // Unsupported selected rows remain available through rawControl/rawContent.
  }
}, [601, 603]);
```

The application owns the subscription and removes it when its connection ends. Existing profile, contact/alias/phonebook, hidden-conversation and emoji-status read APIs remain separate caller-owned operations. No AUTH inventory or queue negotiation is required to inspect a frame.

## Results and common boundary

The result is `readonly AccountProfileEvent[] | undefined`. Undefined means the shared frame boundary is unsupported, failed, reset-bearing or malformed. A valid frame with no selected controls returns `[]`. Recognized frame headers are version1, command601/603 and integer subcommand0–255; no subtype is treated as a request to recover another page. Transport status must be absent or numeric0, and the own inner status must be **numeric `error_code:0`**. String `'0'` does not pass this inner gate.

Each selected event contains `controlIndex`, `actType`, captured `act`, original `rawControl`/`rawContent` references and optional `change`. The actType values are `alias`, `profile`, `hidden_chat` and `emoji_status`. Unknown acts, incomplete payloads and unsupported known shapes remain selected raw wrappers without a fabricated change. Ordering and duplicate controls are retained. Unrelated control families are ignored.

Wrappers, changes and entry arrays are frozen. Raw objects are original private references; they are not cloned, deep-frozen or redacted. **Hidden-chat raw content can contain credential material. Keep raw results private and do not log them, derive a PIN or forward them into a bot response.** The typed PIN signal deliberately copies no credential value, but that does not remove it from raw input references.

Normal content.data uses one lossless JSON parse only when its first character is `{` or `[`, without trimming or recursive unwrapping. Outer row.content must already be an object. A malformed selected JSON string leaves that row raw without a change; later safe rows remain available. This per-row containment is SDK policy, while native grouping can abort a batch on malformed JSON.

## Twelve change kinds

| Kind | Known shape and meaning |
| --- | --- |
| `aliases-invalidated` | Every alias act, including unknown acts, requests alias synchronization in native code. No alias list or revision is manufactured. |
| `phonebook-invalidated` | profile/phonebook; no data is required and no phonebook replacement is implied. |
| `own-profile-invalidated` | profile/update; native fetches a later account profile. Data is not applied as an avatar/name/profile patch. |
| `own-profile-status-updated` | profile/update_status with an actual bounded string status, including explicit empty string. Targets self without injecting a user ID. |
| `profile-last-online-updated` | profile/online_status with usable uid and positive lastOnline; exposes userId and lastOnlineMilliseconds. No online/offline boolean is inferred. |
| `profile-mode-updated` | profile/mode with a safe integer mode and self or explicit user target. Raw mode1 and future safe integer values are retained. |
| `own-business-profile-patch` | profile/biz; self-targeted package/metadata patch observation, without applying a subscription or profile state. |
| `hidden-chat-membership-updated` | hidden_chat/add_remove with object data; optional add_items/del_items become separate additions/removals entry arrays. |
| `hidden-chat-reset` | hidden_chat/reset; no data is required. A signal only, with no vault/cache/message/cursor action. |
| `hidden-chat-pin-invalidated` | hidden_chat/change_pin with a bounded nonempty string data.pin. No typed credential field or guessed format. |
| `emoji-status-add-signal` | emoji_status/add with object data, independent of an embedded record being present or usable. |
| `emoji-status-delete-signal` | emoji_status/delete with object data, independent of an embedded record being present or usable. |

Every nontrivial data projection exposes its normalized object as `change.raw`; raw content still contains the exact original representation. Unproven future controls remain raw. Business patch values use their separate observation policy below.

Existing profile/hidden-chat/emoji IDs accept canonical positive decimal strings up to40digits or safe positive integer JSON values, producing exact text. Strings do not pass through Number. Prefixes in bare-ID fields, leading zeros, whitespace, unsafe numeric values and unsupported flags do not create an identity. Hidden membership requires numeric is_group0 direct/1 group; native truthiness of unknown values is not extended into the typed projection.

### Profile values are observations

Status text is preserved verbatim. Native replaces falsy status values with a local empty string and shares a2s throttle between profile update/status events. The extractor performs neither behavior: missing/null/false/0 status remains raw, and all observed controls stay ordered.

Last-online metadata uses milliseconds, retained as a safe positive integer or exact bounded positive decimal string. Native code has an online-config feature gate, batches writes, max-merges timestamps and can substitute local time for sentinel -1. The extractor applies no feature gate, no merge, no sentinel substitution and no current-presence calculation.

Mode has one additional source-specific parse: if data remains a string after common normalization, it is JSON-parsed once even with leading whitespace. The resulting value must be an object for a known mode. A string returned by that parse is not parsed again. Missing/undefined/null friendId yields `{kind:'self'}`; a usable friendId yields `{kind:'user', userId}`. Other supplied target forms remain raw. Native UI code maps AWAY1 to AVAILABLE0 and may fetch a missing friend; this helper preserves mode1 and does not fetch. Observed enum values are0 available,1 away,2 busy,3 invisible; future safe integers are not assigned a new meaning. No timestamp/revision ordering is inferred for a mode event.

### Hidden-chat intentions are not a replacement or merge result

Each membership entry is `{raw, value?}` with an optional `{threadType:'user'|'group',threadId}`. Missing collections stay absent, empty lists stay empty, and unsupported entries remain raw in place. Additions and removals retain duplicates and per-array order.

Native collects deletions and additions against the **pre-update cache**, then applies them. For an ID present in both lists, an initially-present ID queues deletion only; an initially-absent ID queues addition only. There is no unconditional add-wins rule or complete snapshot in this control. The extractor preserves the two lists and chooses no cache-dependent outcome. No version or timestamp is consumed by the native membership handler.

A content-level reset calls native credential clearing asynchronously and clears hidden membership. Credential clearing/persistence can fail, so receiving the control does not prove success. The remote branch skips native's separate local delete-all-conversation path. The extractor does none of those operations. A change_pin signal indicates credential-related invalidation; it does not validate a plaintext PIN, assume an incoming hash representation or apply a vault credential.

### Emoji signals do not claim a cache update

Both known acts can contain optional `status: {raw, value?}` and `debounceSeconds`. Missing emojiStatus stays absent; explicit null/unsupported values stay raw entries without a value. The signal itself does not require an embedded record. Native schedules a subsequent friends-status pull for either act; no default debounce, pending-pull persistence or scheduler is reproduced.

A known delete identity is `{noisedOwnerId, emojiStatusId}`. A known add record additionally requires usable emojiId and positive safe numeric createdTime/duration, projected as **createdTimeMilliseconds** and **durationMilliseconds**. Optional bounded caption string/null and usable extraData.song.songId become caption/songId. The entire original embedded record, nested metadata and unknown extensions remain raw. Unsupported optional caption values are omitted from the typed value without discarding valid core identity/time fields.

An explicit finite nonnegative numeric debounceTime becomes debounceSeconds; it is measured in **seconds**, distinct from record lifetime milliseconds. No configured fallback is invented. Old records are retained without computing expiry, filtering, fetching emoji resources or scheduling an expiration timer.

Native directly applies embedded records only when noisedOwnerId strictly equals the signed-in UID; other owners provoke the later friends pull. For own add it guards by createdTime and expiry; for own delete it requires the current emojiStatusId to match. The extractor consults no global UID, clock or cache, and therefore claims neither self/friend application nor unconditional deletion of an owner's current status. Emoji IDs are separate from friends-page version/maxEmojiStatusId cursors.

## Bounds, faults and state separation

The common reader permits at most20,000 control rows. Selected data/content strings are each limited to64KiB UTF-8 and together to1MiB per frame. Unrelated control data is filtered before that budget. Exceeding the common boundary returns undefined.

A20,000 aggregate attempted-entry budget covers hidden-list slots and each present emojiStatus record, including unsupported entries. Counts are charged before entry validation; oversized, sparse, accessor-backed or exhausted known shapes lose change only, preserving their selected raw wrappers. Later constant-size invalidations or emoji signals without a record can still project. Known status/caption/PIN-signal text is limited to64KiB UTF-8; raw unknown nested values are untouched. These are SDK resource policies, not measured provider caps.

Only selected own data descriptors are inspected. Arrays use indexed own slots after count checks, never caller iterators. Accessors are not invoked; private descriptor/parser exceptions become unsupported raw shapes rather than outward errors. Unknown objects are retained by reference without recursive traversal.

Control-domain reset metadata suppresses extraction rather than applying a reset. The bounded inactive reset domain is absent/null/numeric0/string `'0'`. Content hidden_chat/reset is an ordinary selected signal, not that domain reset. saveActionId, controlId, queueStatus and lastActionId remain raw; none advances persistence or recovery. Profile status, hidden membership and emoji status are separate from unread marks, ordinary read markers, reaction read state and E2EE receipts.

## Source and verification

Static evidence: installed Desktop26.11.10/build26.11.10.3400. SHARED SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`; MAIN startup SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. Anchors are zero-based UTF-8 bytes:

| Source bytes | Established behavior |
| --- | --- |
| SHARED3002100–3003550;3010200;12027012–12032580 | Strict successful control dispatch, reset suppression, selected router and first-character normalization. |
| SHARED12031455–12032580;4599337–4601150 | Profile/alias acts, invalidations, status/presence/mode consumers and later profile/friend fetching. |
| SHARED9981887;9108907 | Alias and phonebook initialization/config-dependent refetch policies. |
| SHARED3968043–3969300;10290191–10292400 | Last-online millisecond clock/display and local batching/max-merge. |
| SHARED1533674;16765488 | Mode enum and native AWAY-to-AVAILABLE UI conversion. |
| SHARED4141340;4142716;4143602–4144450;4147780 | Hidden item normalization, fetched replacement versus two-list pre-cache filtering and state application. |
| SHARED4146540–4147790;4151751–4152450;12521026 | Credential signal/async clear, remote reset branch and separate explicit PIN update route. |
| SHARED5676896–5677220; MAIN2397971 | Emoji event DTO preserves normalized content and network forwarding. |
| MAIN2429942–2432700 | Emoji add/delete owner/identity/time guards, explicit debounce seconds and separate scheduled pull/persistence. |
| SHARED1565990–1566450;11600927 | Record lifetime milliseconds and native expiry policy. |

Synthetic offline fixtures cover all eleven changes, raw/private reference fidelity, source-specific mode parsing, invalidation versus snapshots, hidden overlap without folding, PIN signal privacy, optional emoji records and units, statuses/resets, own fields, unknowns, indexed arrays and resource bounds. No live push, app execution, account request, credential operation or state mutation was performed for this slice. Provider availability, incoming credential representation and future control shapes remain unverified.


## Business profile patch observations

Exact `profile/biz` controls with an ordinary normalized data object produce `own-business-profile-patch`, with frozen `{kind:'self'}` target and original `change.raw` reference. An incoming UID does not change the target. This is an additive `AccountProfileChange` union member; update exhaustive consumer switches.

An own `bizPkg` becomes `businessPackage:{raw,value?}`. An ordinary package record can expose its own finite-number or bounded exact-string `pkgId`; null, missing, unsupported values and unknown package fields stay raw. Strings are bounded to256UTF-8bytes, including empty, without coercion or a closed package enum. No label, purchase, upgrade, entitlement or current subscription is inferred.

Truthy outer `content.time` and `content.onboard_info` override their respective nested data fields. Otherwise the own nested value and its presence remain. Only the selected fallback is inspected; the losing nested accessor is not called. `time:{raw,value?}` optionally qualifies finite numeric or exact text up to64KiB, without unit/order/expiry conversion. `onboardingInfo` retains the effective unknown value directly, including own undefined/null/falsy values. Unknown nested objects remain shared and unfrozen.

The new qualifier uses ordinary nonproxy records and own data descriptors. A faulty selected root field leaves the event raw; a faulty package-ID field removes only that package entry's typed value. Existing shared selection may inspect custom Proxy descriptors before this qualifier. No general trap-free frame parsing guarantee is added. There is no native merge, clock, deduplication, profile fetch or UI business-state update. Source evidence is the installed profile router12031447–12032610, `tZKg`15430649–15432325 and self FriendManager/reducer9183725–9187060 in the pinned SHARED member. Local fixture evidence remains separate from live event availability.
