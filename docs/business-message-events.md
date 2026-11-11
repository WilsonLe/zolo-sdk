# Passive business messaging events

`extractBusinessMessageEvents(frame)` observes quick-message template changes and auto-reply invalidations from decoded ordinary account controls. It reuses the same successful version1, command601/603, byte subcommand, numeric inner-zero and inactive-reset boundary as the other passive account extractors. It creates no subscription, HTTP request, timer, cache, database write or automatic reply.

```ts
import { extractBusinessMessageEvents } from 'zalo-personal-sdk';

const unsubscribe = feed.subscribe(frame => {
  for (const event of extractBusinessMessageEvents(frame) ?? []) {
    switch (event.change?.kind) {
      case 'quick-messages-created':
      case 'quick-messages-updated':
        // Ordered entries expose original raw records and optional partial values.
        break;
      case 'quick-messages-deleted':
        // ids contains ID values from data.items, not deleted records.
        break;
      case 'auto-replies-invalidated':
        // The application chooses whether and when to refresh its rule list.
        break;
    }
  }
}, [601, 603]);
```

The application removes its subscription when finished. Existing `getQuickMessageList`, `addQuickMessage`, `updateQuickMessage`, `removeQuickMessage`, `getAutoReplyList`, `createAutoReply`, `updateAutoReply` and `deleteAutoReply` remain separate authenticated operations. A control is not a correlated acknowledgment of one of those requests.

## Ordered observations and raw ownership

The result is `readonly BusinessMessageEvent[] | undefined`: undefined means unsupported/invalid/failed/reset-bearing common frame; an accepted collection with no selected rows yields `[]`. Each selected `quick_message` or `auto_reply` row retains `controlIndex`, original `act`, `rawControl`, `rawContent` and optional `change`. Unknown acts and unsupported payloads remain raw wrappers in original order, including duplicates.

Common data normalization parses one layer only when the first character is `{` or `[`, without trimming or recursive unwrapping. Malformed selected JSON leaves that row without a change. Original raw control/content references remain; a change's `raw` is its normalized data reference. Wrappers, changes, list arrays, entry wrappers and qualified partial values are frozen. Raw and unknown nested objects are shared, not cloned, traversed or recursively frozen.

## Quick messages

| Exact act | Change | Data source |
| --- | --- | --- |
| `create` | `quick-messages-created` | Nonempty dense `data.items` record list |
| `update` | `quick-messages-updated` | Same record-list shape; this is not a fieldwise merge result |
| `delete` | `quick-messages-deleted` | `data.items` ID-value list |

Delete's passive `items` differs from the HTTP request/acknowledgment field `itemIds`. The extractor never interprets deletion record objects as IDs. Each list slot survives as `{raw,value?}`; unsupported records/IDs are retained in place. Missing, empty, sparse, oversized or selected-accessor lists have no typed change.

A qualified record value can expose own `id`, `keyword`, `type`, `createdTime`, `lastModified`, `message` and `media`. ID policy is a safe-integer number (zero/negative/-0 retained) or nonempty exact string up to256UTF-8bytes; this is an observation subset, not account-UID grammar or a cache-key validity claim. `keyword` allows original text up to64KiB. `type` is finite numeric. Time fields and versions allow finite numbers or original strings up to256UTF-8bytes, including empty, without units/coercion/order claims. `message` and `media` stay opaque own values, including null/undefined, with no resource fetching or schema invention. Unknown fields stay raw.

Selected accessors are never invoked. A selected record-field fault removes only that entry's partial value, retaining its raw slot. New projection containers must be ordinary nonproxy records/arrays; the shared selector may already inspect custom descriptors before qualification and does not promise every custom Proxy is trap-free.

An own parent `version` becomes optional `{raw,value?}` independently of item qualification. Unsupported/falsy versions do not discard a valid quick event. The parent version is not copied over record fields, compared with a local version or treated as freshness. Native sorting, `lastUpdate=Date.now()`, cache acceptance and database operations are not reproduced.

## Auto-reply invalidations

Exact `create`, `update` and `delete` produce `auto-replies-invalidated` for supported nonnull data even when version is missing, zero, false, empty or null. Ordinary objects, genuine arrays and nonnull primitive data are supported; function/class/Proxy containers or selected version accessors remain raw-only. Primitive data has no projected own version.

For any other act, the native fallback invalidates only when the captured raw own version is truthy. This gate is independent of typed qualification: a truthy object, array, function or unsupported version still signals invalidation without being traversed or executed. String `'0'` is truthy; numeric0, false, empty string, null, undefined and absence are not. The original act and raw version remain available. This is an invalidation signal, not a rule record, deletion result, completed fetch or proof an automatic response was sent.

## Bounds and evidence

The common selector limits controls to20000 slots, selected strings to64KiB and combined selected text to1MiB. This reader additionally charges attempted quick-list slots against a20000-slot aggregate per frame before entry qualification. An oversized/exhausting list exhausts that budget; sparse or accessor faults do not refund attempted work. Later constant-work auto-reply invalidations remain observable. Unknown nested raw data is not walked. These are post-decode limits, not generic wire-byte or deadline guarantees.

Static evidence is the pinned installed Desktop26.11.10 SHARED router12029740–12030080, quick controller3637417–3639100/5451290–5453850, data loader13033565 onward, and auto handler9941756–9943950/reducer4212924–4216630. Local synthetic fixtures and strict public types verify SDK behavior; live control delivery/account eligibility remain unverified. Business-profile patches belong to the existing [profile extractor](account-profile-events.md#business-profile-patch-observations).
