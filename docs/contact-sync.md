# Contact synchronization and maintenance

These helpers fill specific gaps around the existing `api.getFriendRecommendations()`, `api.getUserInfo()`, `api.getAllFriends()`, `api.getAliasList()`, and `api.getCloseFriends()` operations. They use the explicitly authenticated account API. Reads return provider data; the application owns cache merging, revision storage, and background scheduling. Three maintenance methods explicitly change account state and submit once, without automatic retry.

```ts
import {
  getContactAliasPage, getMiniProfiles, getPhonebookSnapshot, verifyFriendProfiles,
} from 'zalo-personal-sdk';

const aliases = await getContactAliasPage(api, { page: 1, count: 100 });
const profiles = await getMiniProfiles(api, applicationSelectedUserIds);
const names = await getPhonebookSnapshot(api, { knownVersion: applicationPhonebookVersion });

// Missing means the response supplies no replacement. Empty means replace with empty.
if (names.phonebook !== undefined) await replaceApplicationPhonebookNames(names.phonebook);
if (names.version !== undefined) await saveApplicationPhonebookVersion(names.version);

const checked = await verifyFriendProfiles(api, {
  profiles: applicationKnownFriends.map(friend => ({
    userId: friend.userId, lastUpdateTime: friend.lastUpdateTime,
  })),
  phonebookVersion: applicationPhonebookVersion,
});
await reconcileApplicationFriendProfiles(checked);
```

Application functions and state in this example belong to the caller. Store revisions and their corresponding data consistently. Do not interpret an omitted map or a missing requested profile as a deletion. Contact names, aliases, profile metadata, context, and recommendation IDs are private account data; the `raw` fields retain the decoded provider records and deserve the same protection.

## Read contracts

| Helper | Input and result |
| --- | --- |
| `getContactAliasPage(api, options?)` | Options are `page` (default 1), `count` (default 20), `source` (default -1), and `signal`. Returns `{items:[{userId,alias}], updateTime?, hasMore, raw}`. Fetches exactly one v2 page. |
| `getMiniProfiles(api, ids, options?)` | Reads one batch of up to 100 distinct user IDs. Optional `sourceRequest` defaults to -1. Returns a map keyed by user ID. Each profile retains its provider fields; present `userId`, `uid`, and `id` fields normalize to decimal strings. Missing entries remain missing. |
| `getFriendContexts(api, ids, signal?)` | Reads up to 100 distinct direct-contact IDs. Returns a UID-keyed map retaining provider fields. Observed `purpose` values are `none`, `family`, `friend`, `work`; observed `role` arrays include `none` and `boss`. Other strings remain intact. It does not manufacture the Desktop cache's local `ts` field or placeholders for absent contacts. |
| `getPhonebookSnapshot(api, options?)` | `knownVersion` defaults to 0. Optional positive `source` goes outside encrypted params. Returns `{version?, phonebook?:Record<UID,string>, raw}`. A supplied phonebook is a whole replacement, including an empty object; missing or null provides no replacement. Names and empty strings remain unchanged. This route reads server phonebook names; it does not upload device contacts. |
| `verifyFriendProfiles(api, input)` | Requires a nonempty `profiles` array of `{userId,lastUpdateTime}` records. `lastUpdateTime` must be positive. `phonebookVersion` defaults to 0, `language` to `vi` (`en` also accepted). Returns optional `friends`, `nonefriends`, and `phonebookVersion`, plus `raw`. Omitted/null membership maps stay omitted; empty maps stay explicit. |
| `getContactTabReadTime(api, signal?)` | Returns the numeric synchronized millisecond timestamp from `{ts}`. This exact GET sends no encrypted `params` or IMEI. |

User IDs are positive decimal strings, without the group `g` prefix or the mini-profile dispatcher's special self sentinel `0`. Decimal revisions can be safe nonnegative integer numbers or decimal strings up to 40 digits. Large numeric provider IDs and revisions are parsed without precision loss. Revision strings are preserved, including their original decimal formatting. No helper changes the context's stored phonebook version or merges membership changes automatically.

The installed mini-profile consumer renames `bizPkg` to `bizInfo` and substitutes `zaloName` when `displayName` is missing. These are UI/cache transformations; this helper returns the provider fields without those transformations. `verifyFriendProfiles` likewise does not add `isFr:0` to `nonefriends`, overwrite stored profiles, or copy the installed consumer's erroneous lookup against the other map.

Alias v2 provides the same proven `{userId,alias}` items used by the installed alias consumer. Aliases preserve their exact text, including empty strings and whitespace. Its pagination follows the installed rule: when the response owns `hasMore`, use `Boolean(raw.hasMore)`; otherwise another page is indicated when the returned count equals the requested count. This means a provider string such as `"false"` is truthy. The unmodified field remains in `raw`. A full final page can require an additional request under the fallback rule. The helper does not fetch further pages, swallow code 212 after partial results, claim a total, or commit a complete alias inventory. `updateTime` is the provider revision; it is not a promise that independently fetched pages form an atomic snapshot.

Alias source codes reflect installed attribution: -1 unspecified, 1 no data, 2 version change, 3 warning/control polling, 4 update signal, 5 periodic synchronization, 6 last error, and 7 login. These are request metadata, not instructions to start those flows. The installed controller normally uses a configured page size with fallback 100; the raw builder's default is 20.

## Explicit maintenance

```ts
import {
  dismissFriendRecommendation, markContactTabRead, markFriendRequestsSeen,
} from 'zalo-personal-sdk';

// Pass the timestamp corresponding to the application's explicit contact-tab view.
await markContactTabRead(api, applicationSynchronizedViewTime);
await markFriendRequestsSeen(api, applicationViewedIncomingRequestIds);

const recommendations = await api.getFriendRecommendations();
const selected = recommendations.recommItems[applicationSelectedIndex].dataInfo;
await dismissFriendRecommendation(api, selected);
```

`markContactTabRead` sends the caller-supplied nonnegative safe integer milliseconds. It does not infer a current view, create a local clock offset, or automatically mark anything seen during reads. `markFriendRequestsSeen` sends only explicitly selected received-request IDs; it does not accept or reject requests. `dismissFriendRecommendation` uses the selected provider record's `userId`, original `recommSrc`, and `recommType` (1 recommendation, 2 received request). It does not substitute another rejection/removal route or infer a source from display text. All three return `void` after an accepted account acknowledgment, including a successful empty acknowledgment.

Every request rejects HTTP redirects. No helper retries. Explicit provider rejections retain their numeric `ZaloProtocolError.providerCode`. Cancellation, transport failure, or a malformed response after a maintenance request was submitted can leave the result unknown. Reconcile with a fresh read before deciding on another explicit submission. The helper does not claim that local acknowledgment independently proves every device's unread state changed.

Bounds are SDK limits, not proven server maxima: 100 IDs per mini-profile/context request; 1,000 seen-request IDs; 20,000 verified friend revisions or returned map entries; 1,000 requested/returned aliases per page; 16 KiB UTF-8 per returned alias/name; 40 decimal digits per ID/revision; 100 context roles. Alias page/source and other source values must be bounded integers. Invalid inputs fail before I/O, and malformed responses use sanitized errors without including private response content.

## Exact wire and evidence

All nine use the account's advertised service domain and common protocol parameters. POST bodies are URL-encoded forms whose `params` is account-AES-CBC encrypted JSON. GET parameters are encrypted JSON in the query except the contact-tab timestamp read. IMEI is added only in the rows explicitly showing it.

| Helper | Service, method, path | JSON fields / outer query |
| --- | --- | --- |
| Alias page | `alias` GET `/api/alias/list/v2` | `{page,count,src,imei}` |
| Mini profiles | `profile` POST `/api/social/friend/getminiprofiles` | `{friend_ids,avatar_size:160,incInvalid:1,srcReq}` |
| Contexts | `friend` POST `/api/friend/context/multiget` | `{fids,imei}` |
| Phonebook | `profile` GET `/api/social/friend/phonebook/v2` | `{phonebook_version}`; optional plain outer `src` query |
| Verification | `profile` POST `/api/social/friend/verify` | `{phonebook_version,friend_pversion_map:["uid_lastUpdateTime"],avatar_size:160,language,imei}` |
| Contact read time | `friend` GET `/api/friend/last-read-contact-tab` | Common query only; no `params` |
| Mark contact read | `friend` POST `/api/friend/read-contact-tab` | `{ts}` |
| Mark requests seen | `friend` POST `/api/friend/recommendsv2/read-requests` | `{uids_seen}` array |
| Dismiss recommendation | `friend` POST `/api/friend/recommendsv2/remove` | `{uid,src,type}` |

Evidence uses installed 26.11.10 SHARED, extracted as `desktop-shared.js`, SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`, and main-startup SHA-256 `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`. Offsets are zero-based UTF-8 bytes. [Artifact identity](desktop-evidence.md)

| Offsets | Contract |
| --- | --- |
| SHARED `12402476` | Installed avatar-size constant 160; upstream profile helpers default to 120 |
| `12497923`–`12498300`, `9973400`–`9977000`, `9970031` | Alias v2 builder, item/revision/pagination consumer, and source codes |
| `12534410`–`12535600`, `9157500`–`9158980` | Mini-profile fields, UID map, normalization, and 100-ID batching |
| `12418924`, `12104890`–`12105300`, `4240310`–`4242600` | Context builder, map consumer, purpose/role fields, and locally added cache timestamp |
| `12485694`, `9106672`–`9107500`, `6053648` | Phonebook revision/source builder, whole-map replacement, and name lookup |
| `12415233`, `10732800`–`10736100` | Friend verification request versions and membership-map/revision consumers |
| `12439966`–`12440670`, `772230`, `13822460` | Recommendation dismissal, marker builders, direct record-field mapping and acknowledgment consumers |
| main-startup `970151`–`972050`, SHARED `748594`, `11600927` | Marker timestamp shape, explicit seen IDs, contact-tab view timestamp, synchronized millisecond clock |

The existing upstream methods remain available for recommendation lists, modern versioned profiles, full friends, alias v1, close-friend reads, and friend-request acceptance/rejection. This module does not implement legacy duplicate routes or an unproved close-friend action-number mapping. It does not enable native automatic polling, stage-domain debug overrides, profile enrichment requests, or unrelated account changes.

`test/contact-sync.test.mjs` independently decrypts synthetic requests and encrypts synthetic provider responses. It covers all nine routes, the omitted-params read, exact methods/IMEI/source placement, aliases paging, raw-field preservation, large IDs/revisions, omitted/empty maps, explicit one-shot maintenance, cancellation, input bounds, provider errors, sanitized transport errors, and malformed data.

On 6 November 2026, separate live reads through the saved Web session returned 20 aliases with `hasMore:true`, one requested mini profile, one contact context, a 51-entry phonebook replacement, and a contact-tab timestamp. Verification using one existing friend's actual fetched revision and phonebook revision zero returned 66 friends, no nonfriends, and a phonebook revision. Response size is provider-controlled; it need not equal the submitted revision-list size. The probe printed only counts and receipt flags. Contact-tab marking, friend-request seen markers, and recommendation dismissal remain fixture-only; none was submitted live.
