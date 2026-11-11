# Product catalogs: passive signals and exact item requests

`extractProductCatalogEvents` observes decoded `prod_catalog` controls. `getProductCatalogItem` and `deleteProductCatalogItem` are separate explicit authenticated requests. Receiving a control does not call either operation or modify a product, cache, registration, version, cursor or unread badge.

Existing account APIs still provide catalog/product create/update/list, product batch deletion, catalog deletion/registration and product-photo upload. The new single-delete request differs from a one-item `/product/mdelete`, and the new view response is a direct row rather than `.item`.

## Ordered passive signals

```ts
import { extractProductCatalogEvents } from 'zalo-personal-sdk';

const unsubscribe = feed.subscribe(frame => {
  for (const event of extractProductCatalogEvents(frame) ?? []) {
    // The application decides how to reconcile change and its retained raw data.
  }
}, [601, 603]);
```

The shared boundary is version1, command601/603, byte subcommand, absent/numeric-zero transport error, own numeric-zero inner status and inactive reset. Common data normalization parses one layer only when its first character is `{` or `[`, without trimming or recursive unwrap. Undefined means invalid/unrelated/failed/reset frame; a valid collection with no selected controls yields `[]`. Each frozen event retains original order/duplicates, `controlIndex`, `actType:'prod_catalog'`, raw act/control/content references and optional change. Unknown/unsupported rows stay raw.

| Exact act | Change and consumed fields |
| --- | --- |
| `add_prod`, `edit_prod` | product-add/update-signal from ordinary `data.item` with a raw-truthy own product_id; optional root version_catalog/version_ls_catalog observed separately |
| `del_prod` | product-delete-signal using raw-truthy **root product_id** and optional root catalog_id |
| `del_list_prod` | product-list-delete-signal using dense **root product_ids** and optional catalog_id; an empty list remains a known empty signal |
| `add_catalog`, `edit_catalog` | catalog-add/update-signal with original ordinary item; edit is not reclassified by its misleading native deletion-named UI event |
| `del_catalog` | catalog-delete-signal even with absent/null/primitive data or missing/falsy CID; no identified deletion or cascade is implied |
| `enable_feature` | catalog-feature-registration-signal without inspecting its unused data container; no enabled flag, entitlement or remote registration is inferred |

Product single-ID predicates use captured **raw truthiness**, independently of typed ID success. Numeric0, false, empty/null/missing skip; string `'0'` and opaque truthy values can enter with unqualified raw identity. Missing/falsy/unqualified product versions do not remove an otherwise recognized signal or mean native cache admission. Catalog deletion has no such truthy-CID guard. Feature registration data can be absent, null, primitive or opaque because it is not inspected.

Each selected item/ID/version is a frozen `{raw,value?}` wrapper. Qualified partial products expose own IDs, name/price/description/currency/path text, opaque product_photos and observed create_time. Catalogs retain independently own id/name/version and catalog_id/catalog_name/version_catalog plus other selected metadata; no aliases/defaults or 32-bit totalProduct conversion are manufactured. IDs use safe numeric or exact nonempty text up to256UTF-8bytes, with no UID grammar/coercion. Version/count/time observations allow finite numeric or exact text up to256bytes, including empty; no unit/freshness/monotonicity claim. Text is generally bounded to64KiB; currency_unit256. Product photos remain an opaque shared own value, not a fetched/validated list. Only actual Boolean isDefault qualifies.

Selected accessors are never called. A faulty selected root prevents its known change; an item-field fault removes that entry's whole partial value while keeping raw. New qualifiers reject Proxy/class/root misuse before extra introspection, but the existing common frame selector may already inspect custom descriptors and is not universally trap-free. Catalog deletion permits genuine array/primitive containers as documented; unsupported Proxy/class/function containers remain raw-only. Feature registration inspects none of that unused container.

Wrappers, changes, list arrays and partial values freeze; original raw/unknown objects stay shared and unfrozen. The common selector bounds controls20000, selected text64KiB each/1MiB combined. Only plural deletion adds proportional work: attempted own dense slots charge a20000 aggregate/list budget before qualification; overbound/exhausting/sparse faults do not refund it. A true empty list remains valid after that budget is exhausted. No caller iterator, reverse scan, seen-ID list, merge, version advancement, feature gate, clock, fetch or persistence is reproduced.

Native reverses catalog batches and deduplicates product IDs across add/edit/single/list deletion with one shared seen list, while catalog acts have no equivalent dedup. Those are mutable application policies, not wire ordering. This extractor keeps every original observation, including a later delete after an add. Native catalog deletion does not cascade its product cache; an incoming signal is not proof of provider state or durable local application.

## Explicit product view

```ts
import { getProductCatalogItem } from 'zalo-personal-sdk';
const product = await getProductCatalogItem(api, { productId: selectedProductId, signal });
// product.raw is the direct decoded row; product.known is a partial observation.
```

One catalog-service POST `/api/prodcatalog/product/view`12057 sends only account-AES `{product_id}` plus common query. No IMEI/language/client ID, list fallback, local guest-cache shortcut, resource fetch or implicit seller-chat action is added. HTTP200/redirect restriction applies. The returned root is an ordinary own-data object, shallow copied/frozen into raw with frozen known partial product fields. It is not unwrapped from `.item`/`.items`; no complete DTO, required entity ID, requested-ID correlation, substituted ID, ownership or not-found status is invented. Unsupported root/scalar/null/empty decoded data is a fixed invalid response. Unknown nested raw values remain shared.

Input is an ordinary own-data record with only productId/signal. Outgoing IDs require safeinteger numeric (zero/negative retained) or nonempty validUTF8 text up to256bytes, without trim/conversion. Null/undefined/Boolean IDs reject as SDK policy, though native arguments are unchecked. Genuine caller cancellation is privately bridged and cleaned up. Read errors are fresh fixed ZaloProtocolError with safe status and current-decoded-refusal provider metadata, without raw adapter/error/input/URL/cause material. There is no new default deadline/wire-byte guarantee.

## Exact singular deletion and uncertain outcomes

```ts
import { deleteProductCatalogItem, ProductCatalogDeleteError } from 'zalo-personal-sdk';
try {
  const ack = await deleteProductCatalogItem(api, {
    productId: selectedProductId, catalogId: selectedCatalogId, signal,
  });
  // ack.raw is the unconsumed account acknowledgment, not a deletion count/receipt.
} catch (error) {
  if (error instanceof ProductCatalogDeleteError && error.outcomeUnknown) {
    // Reconcile before deciding on a separate explicit attempt.
  }
}
```

One catalog-service POST `/api/prodcatalog/product/delete`12042 sends only `{product_id,catalog_id}` in account-AES form params and common query, no IMEI/language/client ID/request ID/product_ids. Input IDs have the same declared bounded policy. There is no automatic mdelete/view/cache/registration fallback, local removal or replay.

Native account decoding accepts HTTP200, a parsed successful outer envelope, then either the unchanged inner success data or undefined for absent/falsy outer encrypted data. The SDK uses its existing numeric/string-zero subset and allowEmpty after outer parsing. An entirely empty HTTP body is not an ACK. Inner null/empty/false/scalar/list/object values remain exact `ack.raw`; no item/msgId/count/version/echo schema or deep inspection/freezing is required because native consumes no layout. The wrapper freezes. This is an account acknowledgment, not observed deletion/cascade, receipt or native database success.

A helper-local API/JSON-wire-tuple(productId,catalogId) lease blocks concurrent same-tuple requests and releases on every terminal path. Numeric1 and string`'1'` remain distinct; JSON-equivalent -0/0 can share a lease. Other helpers/processes/provider idempotency are not coordinated.

`ProductCatalogDeleteError(code,submitted=false,outcomeUnknown=false,providerCode?,status?)` has busy/aborted/unsupported-service/request-failed/submission-unknown codes and fresh fixed messages. Before handoff, pre-abort/busy/missing-service have false/false. After handoff, only current decoded safe nonzero provider refusal gives request-failed,true,false. Other transport/HTTP/body failures yield submission-unknown,true,true; observed cancellation is aborted with false/false or true/true. Forged/reused public error metadata and zero code do not establish refusal. Raw identity/body/error/cause is not copied into errors. Reconcile uncertainty before another explicit attempt.

## Source and remaining verification

Source is pinned installed Desktop26.11.10: SHARED12029834–12030190 router,13711176–13713000 reducer,12528215–12531155 builders,13695490–13698450 adapter,13736118–13737320 account decoder, and14994500–14995580 view UI caller. Product view has a concrete UI caller. Singular deletion has the exact callable exported facade/task/controller/adapter/registry chain; the bounded source search did not prove it is the current normal UI delete choice. Neither static proof establishes live server/account availability or side effects.

Local fixtures and strict public types are separate from live catalog eligibility, schema completeness and provider-state verification. No catalog view/delete/account request is performed by implementation validation. `contact_tab` remains outside this extractor: its passive callback only changes local access/unread UI, while existing contact-sync methods explicitly own its remote read/mark requests.
