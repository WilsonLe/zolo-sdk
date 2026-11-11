import { isProxy } from 'node:util/types';
import type { API } from '#zca';
import { parseAccountControlData, readAccountControlRows } from './account-controls.js';
import type { AccountControlRow } from './account-controls.js';
import { createProtocolAbortScope, getDecodedProtocolRefusal, protocolRequest, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';

export type ProductCatalogIdentifier = number | string;
export type ProductCatalogVersion = number | string;
export interface ProductCatalogEntry<T> {
  readonly raw: unknown;
  readonly value?: T;
}
export interface ProductCatalogProductFields {
  readonly product_id?: ProductCatalogIdentifier;
  readonly catalog_id?: ProductCatalogIdentifier;
  readonly owner_id?: ProductCatalogIdentifier;
  readonly product_name?: string;
  readonly price?: string;
  readonly description?: string;
  readonly currency_unit?: string;
  readonly path?: string;
  readonly product_photos?: unknown;
  readonly create_time?: ProductCatalogVersion;
}
export interface ProductCatalogCatalogFields {
  readonly id?: ProductCatalogIdentifier;
  readonly name?: string;
  readonly version?: ProductCatalogVersion;
  readonly catalog_id?: ProductCatalogIdentifier;
  readonly catalog_name?: string;
  readonly version_catalog?: ProductCatalogVersion;
  readonly ownerId?: ProductCatalogIdentifier;
  readonly created_time?: ProductCatalogVersion;
  readonly isDefault?: boolean;
  readonly catalog_photo?: string | null;
  readonly catalogPhoto?: string | null;
  readonly path?: string;
  readonly totalProduct?: number | string;
}
export type ProductCatalogChange =
  | { readonly kind: 'product-add-signal' | 'product-update-signal';
      readonly item: ProductCatalogEntry<ProductCatalogProductFields>;
      readonly versionCatalog?: ProductCatalogEntry<ProductCatalogVersion>;
      readonly versionListCatalog?: ProductCatalogEntry<ProductCatalogVersion>; readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'product-delete-signal'; readonly productId: ProductCatalogEntry<ProductCatalogIdentifier>;
      readonly catalogId?: ProductCatalogEntry<ProductCatalogIdentifier>; readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'product-list-delete-signal'; readonly productIds: readonly ProductCatalogEntry<ProductCatalogIdentifier>[];
      readonly catalogId?: ProductCatalogEntry<ProductCatalogIdentifier>; readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'catalog-add-signal' | 'catalog-update-signal';
      readonly item: ProductCatalogEntry<ProductCatalogCatalogFields>; readonly raw: Readonly<ProtocolData> }
  | { readonly kind: 'catalog-delete-signal'; readonly catalogId?: ProductCatalogEntry<ProductCatalogIdentifier>; readonly raw: unknown }
  | { readonly kind: 'catalog-feature-registration-signal'; readonly raw: unknown };
export interface ProductCatalogEvent {
  readonly controlIndex: number;
  readonly actType: 'prod_catalog';
  readonly act: unknown;
  /** Original private input references; product metadata can contain private locators. */
  readonly rawControl: Readonly<ProtocolData>;
  readonly rawContent: Readonly<ProtocolData>;
  readonly change?: ProductCatalogChange;
}
export interface ProductCatalogViewInput {
  readonly productId: ProductCatalogIdentifier;
  readonly signal?: AbortSignal;
}
export interface ProductCatalogViewResult {
  readonly raw: Readonly<ProtocolData>;
  readonly known: Readonly<ProductCatalogProductFields>;
}
export interface ProductCatalogDeleteInput {
  readonly productId: ProductCatalogIdentifier;
  readonly catalogId: ProductCatalogIdentifier;
  readonly signal?: AbortSignal;
}
export interface ProductCatalogDeleteResult {
  /** Decoded account acknowledgement, without an inferred deletion or echo schema. */
  readonly raw: unknown;
}
export type ProductCatalogDeleteFailure = 'busy' | 'aborted' | 'unsupported-service' | 'request-failed' | 'submission-unknown';

const deleteMessages: Readonly<Record<ProductCatalogDeleteFailure, string>> = Object.freeze({
  busy: 'This product and catalog already have an active deletion submission.',
  aborted: 'The product deletion request was cancelled.',
  'unsupported-service': 'This Zalo session does not advertise the product catalog service.',
  'request-failed': 'The product deletion request was refused or could not start.',
  'submission-unknown': 'Zalo may have accepted the product deletion without confirming its outcome.',
});

export class ProductCatalogDeleteError extends Error {
  constructor(
    readonly code: ProductCatalogDeleteFailure,
    readonly submitted = false,
    readonly outcomeUnknown = false,
    readonly providerCode?: number,
    readonly status?: number,
  ) { super(deleteMessages[code]); this.name = 'ProductCatalogDeleteError'; }
}

const unsupported = Symbol('unsupported product catalog observation');
const maximumTextBytes = 65_536;
const maximumScalarBytes = 256;
const maximumListEntries = 20_000;
const actTypes: readonly string[] = Object.freeze(['prod_catalog']);
const deletions = new WeakMap<API, Set<string>>();
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
type Budget = { remaining: number };

function ordinary(value: unknown): ProtocolData | undefined {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as ProtocolData : undefined;
}

/** Capture only an own data descriptor, without invoking selected accessors. */
function property(value: object, key: string): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw unsupported;
  return descriptor;
}

function own(value: object, key: string): unknown { return property(value, key)?.value; }

function boundedText(value: unknown, limit = maximumTextBytes): value is string {
  return typeof value === 'string' && value.length <= limit && Buffer.byteLength(value, 'utf8') <= limit;
}

function identifier(value: unknown): ProductCatalogIdentifier | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  return boundedText(value, maximumScalarBytes) && value.length > 0 ? value : undefined;
}

function version(value: unknown): ProductCatalogVersion | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return boundedText(value, maximumScalarBytes) ? value : undefined;
}

function entry<T>(raw: unknown, project: (value: unknown) => T | undefined): ProductCatalogEntry<T> {
  let value: T | undefined;
  try { value = project(raw); } catch { /* A selected field fault leaves this raw entry unqualified. */ }
  return Object.freeze(value === undefined ? { raw } : { raw, value });
}

function productFields(value: unknown, capturedId?: PropertyDescriptor): ProductCatalogProductFields | undefined {
  const data = ordinary(value);
  if (!data) return;
  const productId = identifier(capturedId === undefined ? own(data, 'product_id') : capturedId.value);
  const catalogId = identifier(own(data, 'catalog_id')), ownerId = identifier(own(data, 'owner_id'));
  const name = own(data, 'product_name'), price = own(data, 'price'), description = own(data, 'description');
  const currency = own(data, 'currency_unit'), path = own(data, 'path');
  const photos = property(data, 'product_photos'), created = version(own(data, 'create_time'));
  return Object.freeze({
    ...(productId === undefined ? {} : { product_id: productId }),
    ...(catalogId === undefined ? {} : { catalog_id: catalogId }),
    ...(ownerId === undefined ? {} : { owner_id: ownerId }),
    ...(boundedText(name) ? { product_name: name } : {}),
    ...(boundedText(price) ? { price } : {}),
    ...(boundedText(description) ? { description } : {}),
    ...(boundedText(currency, maximumScalarBytes) ? { currency_unit: currency } : {}),
    ...(boundedText(path) ? { path } : {}),
    ...(photos === undefined ? {} : { product_photos: photos.value }),
    ...(created === undefined ? {} : { create_time: created }),
  });
}

function catalogFields(value: unknown): ProductCatalogCatalogFields | undefined {
  const data = ordinary(value);
  if (!data) return;
  const id = identifier(own(data, 'id')), name = own(data, 'name'), revision = version(own(data, 'version'));
  const catalogId = identifier(own(data, 'catalog_id')), catalogName = own(data, 'catalog_name');
  const catalogVersion = version(own(data, 'version_catalog')), ownerId = identifier(own(data, 'ownerId'));
  const created = version(own(data, 'created_time')), isDefault = own(data, 'isDefault');
  const photo = own(data, 'catalog_photo'), camelPhoto = own(data, 'catalogPhoto'), path = own(data, 'path');
  const count = version(own(data, 'totalProduct'));
  return Object.freeze({
    ...(id === undefined ? {} : { id }), ...(boundedText(name) ? { name } : {}),
    ...(revision === undefined ? {} : { version: revision }),
    ...(catalogId === undefined ? {} : { catalog_id: catalogId }),
    ...(boundedText(catalogName) ? { catalog_name: catalogName } : {}),
    ...(catalogVersion === undefined ? {} : { version_catalog: catalogVersion }),
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(created === undefined ? {} : { created_time: created }),
    ...(typeof isDefault === 'boolean' ? { isDefault } : {}),
    ...(photo === null || boundedText(photo) ? { catalog_photo: photo } : {}),
    ...(camelPhoto === null || boundedText(camelPhoto) ? { catalogPhoto: camelPhoto } : {}),
    ...(boundedText(path) ? { path } : {}), ...(count === undefined ? {} : { totalProduct: count }),
  });
}

/** Empty arrays remain valid even after the proportional per-frame budget is spent. */
function productIds(value: unknown, budget: Budget): readonly ProductCatalogEntry<ProductCatalogIdentifier>[] {
  if (value === null || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)) throw unsupported;
  const count = own(value, 'length');
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw unsupported;
  if (count > maximumListEntries || count > budget.remaining) {
    budget.remaining = 0;
    throw unsupported;
  }
  budget.remaining -= count;
  const result: ProductCatalogEntry<ProductCatalogIdentifier>[] = [];
  for (let index = 0; index < count; index++) {
    const descriptor = property(value, String(index));
    if (!descriptor) throw unsupported;
    result.push(entry(descriptor.value, identifier));
  }
  return Object.freeze(result);
}

function catalogDeletion(normalized: unknown): ProductCatalogChange | undefined {
  if (typeof normalized === 'function') return;
  let catalogId: PropertyDescriptor | undefined;
  if (normalized !== null && typeof normalized === 'object') {
    if (isProxy(normalized)) return;
    const data = Array.isArray(normalized) ? normalized : ordinary(normalized);
    if (!data) return;
    catalogId = property(data, 'catalog_id');
  }
  return Object.freeze({ kind: 'catalog-delete-signal',
    ...(catalogId === undefined ? {} : { catalogId: entry(catalogId.value, identifier) }), raw: normalized });
}

function project(row: AccountControlRow, budget: Budget): ProductCatalogChange | undefined {
  try {
    const normalized = parseAccountControlData(row.data);
    // These two acts can be observations even without an object payload.
    if (row.act === 'enable_feature') return Object.freeze({ kind: 'catalog-feature-registration-signal', raw: normalized });
    if (row.act === 'del_catalog') return catalogDeletion(normalized);
    const data = ordinary(normalized);
    if (!data) return;
    if (row.act === 'add_prod' || row.act === 'edit_prod') {
      const item = own(data, 'item'), record = ordinary(item);
      if (!record) return;
      const productId = property(record, 'product_id');
      if (!productId || !Boolean(productId.value)) return;
      const catalogVersion = property(data, 'version_catalog'), listVersion = property(data, 'version_ls_catalog');
      return Object.freeze({ kind: row.act === 'add_prod' ? 'product-add-signal' : 'product-update-signal',
        item: entry(item, (value) => productFields(value, productId)),
        ...(catalogVersion === undefined ? {} : { versionCatalog: entry(catalogVersion.value, version) }),
        ...(listVersion === undefined ? {} : { versionListCatalog: entry(listVersion.value, version) }), raw: data });
    }
    if (row.act === 'del_prod') {
      const productId = property(data, 'product_id');
      if (!productId || !Boolean(productId.value)) return;
      const catalogId = property(data, 'catalog_id');
      return Object.freeze({ kind: 'product-delete-signal', productId: entry(productId.value, identifier),
        ...(catalogId === undefined ? {} : { catalogId: entry(catalogId.value, identifier) }), raw: data });
    }
    if (row.act === 'del_list_prod') {
      const ids = productIds(own(data, 'product_ids'), budget), catalogId = property(data, 'catalog_id');
      return Object.freeze({ kind: 'product-list-delete-signal', productIds: ids,
        ...(catalogId === undefined ? {} : { catalogId: entry(catalogId.value, identifier) }), raw: data });
    }
    if (row.act === 'add_catalog' || row.act === 'edit_catalog') {
      const item = own(data, 'item');
      if (!ordinary(item)) return;
      return Object.freeze({ kind: row.act === 'add_catalog' ? 'catalog-add-signal' : 'catalog-update-signal',
        item: entry(item, catalogFields), raw: data });
    }
  } catch { /* Preserve the selected raw wrapper for unsupported fields, shapes or budgets. */ }
}

/** Pure source-ordered observations; no native reverse reduction, cache, clock or cursor effects. */
export function extractProductCatalogEvents(frame: RealtimeFrame): readonly ProductCatalogEvent[] | undefined {
  const rows = readAccountControlRows(frame, actTypes);
  if (!rows) return;
  const budget: Budget = { remaining: maximumListEntries };
  const result: ProductCatalogEvent[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], change = project(row, budget);
    result.push(Object.freeze({ controlIndex: row.controlIndex, actType: 'prod_catalog', act: row.act,
      rawControl: row.rawControl, rawContent: row.rawContent, ...(change === undefined ? {} : { change }) }));
  }
  return Object.freeze(result);
}

function invalidInput(): never { throw new TypeError('Supply valid bounded product catalog input.'); }

/** An owned shallow snapshot; unknown nested values are neither inspected nor frozen. */
function dataRecord(value: unknown, allowed?: readonly string[]): ProtocolData {
  if (!ordinary(value)) return invalidInput();
  const result: ProtocolData = Object.create(null);
  for (const key of Reflect.ownKeys(value as object)) {
    if (typeof key !== 'string' || (allowed !== undefined && !allowed.includes(key))) return invalidInput();
    const descriptor = property(value as object, key);
    if (!descriptor) return invalidInput();
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function outgoingId(value: unknown): ProductCatalogIdentifier {
  const selected = identifier(value);
  if (selected === undefined || (typeof selected === 'string' && Buffer.from(selected, 'utf8').toString('utf8') !== selected)) return invalidInput();
  return selected;
}

function selectedSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object' || isProxy(value)) return invalidInput();
  Reflect.apply(signalAborted, value, []);
  return value as AbortSignal;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && Reflect.apply(signalAborted, signal, []) === true;
}

function viewInput(input: unknown) {
  try {
    const raw = dataRecord(input, ['productId', 'signal']);
    return Object.freeze({ productId: outgoingId(raw.productId), signal: selectedSignal(raw.signal) });
  } catch { return invalidInput(); }
}

function deleteInput(input: unknown) {
  try {
    const raw = dataRecord(input, ['productId', 'catalogId', 'signal']);
    return Object.freeze({ productId: outgoingId(raw.productId), catalogId: outgoingId(raw.catalogId), signal: selectedSignal(raw.signal) });
  } catch { return invalidInput(); }
}

function requireApi(api: API): void {
  if (!api || (typeof api !== 'object' && typeof api !== 'function')) return invalidInput();
}

/** Public protocol fields are informational; only the private decoder brand supplies a refusal. */
function errorMetadata(error: unknown): { code: 'unsupported-service' | 'request-failed' | 'invalid-response' | 'aborted'; status?: number } | undefined {
  try {
    if (error === null || typeof error !== 'object' || isProxy(error) || Object.getPrototypeOf(error) !== ZaloProtocolError.prototype) return;
    const code = Object.getOwnPropertyDescriptor(error, 'code'), status = Object.getOwnPropertyDescriptor(error, 'status');
    if (!code || !Object.hasOwn(code, 'value') || (status && !Object.hasOwn(status, 'value'))) return;
    const selected: unknown = code.value, statusValue: unknown = status?.value;
    if (selected !== 'unsupported-service' && selected !== 'request-failed' && selected !== 'invalid-response' && selected !== 'aborted') return;
    return { code: selected,
      status: typeof statusValue === 'number' && Number.isSafeInteger(statusValue) && statusValue >= 100 && statusValue <= 599 ? statusValue : undefined };
  } catch { return; }
}

/** Reads one direct product row once, without cache lookup, fallback or returned-ID correlation. */
export async function getProductCatalogItem(api: API, input: ProductCatalogViewInput): Promise<ProductCatalogViewResult> {
  const value = viewInput(input);
  requireApi(api);
  let submitted = false, scope: { readonly signal?: AbortSignal; stop(): void } | undefined;
  let qualifying = false;
  try {
    scope = createProtocolAbortScope(value.signal);
    const decoded = await protocolRequest(api, {
      service: 'catalog', path: '/api/prodcatalog/product/view', method: 'POST',
      params: { product_id: value.productId }, redirect: 'error', requireHttp200: true, allowEmpty: true, signal: scope.signal,
      onRequestStart() { if (aborted(value.signal)) throw new Error(); submitted = true; },
    });
    if (aborted(value.signal)) throw new ZaloProtocolError('aborted');
    qualifying = true;
    const raw = dataRecord(decoded), known = productFields(raw);
    if (!known) throw unsupported;
    return Object.freeze({ raw: Object.freeze(raw), known });
  } catch (error) {
    const metadata = qualifying ? undefined : errorMetadata(error);
    const refusal = submitted && !qualifying ? getDecodedProtocolRefusal(error) : undefined;
    if (refusal !== undefined) throw new ZaloProtocolError('request-failed', metadata?.status, refusal);
    if (aborted(value.signal) || metadata?.code === 'aborted') throw new ZaloProtocolError('aborted', submitted ? metadata?.status : undefined);
    if (qualifying) throw new ZaloProtocolError('invalid-response');
    throw new ZaloProtocolError(metadata?.code ?? 'request-failed', submitted ? metadata?.status : undefined);
  } finally { scope?.stop(); }
}

/** Explicit single-product mutation; success is only an account acknowledgement, never deletion proof. */
export async function deleteProductCatalogItem(api: API, input: ProductCatalogDeleteInput): Promise<ProductCatalogDeleteResult> {
  const value = deleteInput(input);
  requireApi(api);
  if (aborted(value.signal)) throw new ProductCatalogDeleteError('aborted');
  // JSON equivalence matches the actual payload: numeric -0/0 share a key, while 1/'1' do not.
  const key = JSON.stringify([value.productId, value.catalogId]);
  const pending = deletions.get(api) ?? new Set<string>();
  if (pending.has(key)) throw new ProductCatalogDeleteError('busy');
  pending.add(key); deletions.set(api, pending);
  let submitted = false, scope: { readonly signal?: AbortSignal; stop(): void } | undefined;
  try {
    scope = createProtocolAbortScope(value.signal);
    const decoded = await protocolRequest(api, {
      service: 'catalog', path: '/api/prodcatalog/product/delete', method: 'POST',
      params: { product_id: value.productId, catalog_id: value.catalogId },
      redirect: 'error', requireHttp200: true, allowEmpty: true, signal: scope.signal,
      onRequestStart() { if (aborted(value.signal)) throw new Error(); submitted = true; },
    });
    return Object.freeze({ raw: decoded });
  } catch (error) {
    const metadata = errorMetadata(error), refusal = submitted ? getDecodedProtocolRefusal(error) : undefined;
    if (refusal !== undefined) throw new ProductCatalogDeleteError('request-failed', true, false, refusal, metadata?.status);
    if (!submitted && metadata?.code === 'unsupported-service') throw new ProductCatalogDeleteError('unsupported-service');
    if (aborted(value.signal) || metadata?.code === 'aborted') {
      throw new ProductCatalogDeleteError('aborted', submitted, submitted, undefined, submitted ? metadata?.status : undefined);
    }
    throw new ProductCatalogDeleteError(submitted ? 'submission-unknown' : 'request-failed', submitted, submitted,
      undefined, submitted ? metadata?.status : undefined);
  } finally {
    scope?.stop(); pending.delete(key); if (!pending.size) deletions.delete(api);
  }
}
