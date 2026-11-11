import assert from 'node:assert/strict';
import test from 'node:test';
import { extractProductCatalogEvents } from 'zalo-personal-sdk';
import { frame, row, privateText } from './fixtures/business-controls.mjs';
const catalog = (act, data) => row('prod_catalog', act, data);
const extract = controls => extractProductCatalogEvents(frame(controls));
const one = control => extract([control])[0];
function absent(control) { const event = one(control); assert.equal(Object.hasOwn(event, 'change'), false); return event; }

test('all eight catalog predicates preserve original order/duplicates/raw wrappers without native reverse-cache processing', () => {
  const product = { product_id: 'opaque', product_name: 'one', product_photos: { opaque: true } };
  const item = { id: 'original-id', catalog_id: 'different-alias', name: 'original-name', catalog_name: '', version: 0,
    version_catalog: 'separate', totalProduct: 4294967297, catalog_photo: null, catalogPhoto: 'other' };
  const controls = [row('profile', 'biz', {}), catalog('add_prod', { item: product }), catalog('edit_prod', { item: product }),
    catalog('del_prod', { product_id: 'opaque' }), catalog('del_list_prod', { product_ids: ['opaque', 'opaque', null] }),
    catalog('add_catalog', { item }), catalog('edit_catalog', { item }), catalog('del_catalog'), catalog('enable_feature'), catalog('future', {})];
  const events = extractProductCatalogEvents(frame(controls, { cmd: 603, subCmd: 1 }));
  assert.deepEqual(events.map(event => event.controlIndex), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(events.map(event => event.change?.kind), ['product-add-signal', 'product-update-signal', 'product-delete-signal',
    'product-list-delete-signal', 'catalog-add-signal', 'catalog-update-signal', 'catalog-delete-signal', 'catalog-feature-registration-signal', undefined]);
  assert.equal(events[0].change.item.raw, product); assert.equal(events[0].change.item.value.product_photos, product.product_photos);
  assert.deepEqual(events[3].change.productIds.map(entry => entry.raw), ['opaque', 'opaque', null]);
  assert.deepEqual(events[4].change.item.value, item); assert.equal(events[4].change.item.raw, item);
  for (const event of events) {
    assert.equal(event.rawControl, controls[event.controlIndex]); assert.equal(event.rawContent, controls[event.controlIndex].content);
    assert.ok(Object.isFrozen(event)); if (event.change) assert.ok(Object.isFrozen(event.change));
  }
  for (const owned of [events, events[0].change.item, events[0].change.item.value, events[3].change.productIds]) assert.ok(Object.isFrozen(owned));
  for (const raw of [controls, controls[1], controls[1].content, controls[1].content.data, product, product.product_photos, item]) assert.equal(Object.isFrozen(raw), false);
  assert.equal(Object.hasOwn(events[0].change, 'cacheApplied'), false); assert.equal(Object.hasOwn(events[4].change, 'version'), false);
});

test('product add/edit gates on raw own ID truthiness rather than typed ID/version qualification', () => {
  let reads = 0; const hostile = () => { reads++; throw Error(privateText); };
  const opaque = new Proxy({}, { get: hostile, ownKeys: hostile, getPrototypeOf: hostile });
  for (const act of ['add_prod', 'edit_prod']) {
    for (const product_id of ['0', 'opaque', -1, 1.5, true, {}, [], () => {}, opaque, 'x'.repeat(257)]) {
      const data = { item: { product_id }, version_catalog: 0, version_ls_catalog: false }, change = one(catalog(act, data)).change;
      assert.equal(change.kind, act === 'add_prod' ? 'product-add-signal' : 'product-update-signal');
      assert.equal(change.item.raw, data.item); assert.equal(change.item.raw.product_id, product_id);
      const qualifies = (typeof product_id === 'number' && Number.isSafeInteger(product_id)) || (typeof product_id === 'string' && product_id.length <= 256);
      assert.equal(Object.hasOwn(change.item.value, 'product_id'), qualifies);
      assert.deepEqual(change.versionCatalog, { raw: 0, value: 0 }); assert.deepEqual(change.versionListCatalog, { raw: false });
    }
    for (const product_id of [undefined, null, false, 0, -0, '', NaN]) absent(catalog(act, { item: { product_id } }));
    for (const item of [undefined, null, false, [], new Proxy({}, {})]) absent(catalog(act, { item }));
  }
  assert.equal(reads, 0);
});

test('product versions are optional own raw entries and field qualification is partial with no clock/unit/count coercion', () => {
  const product_photos = { noIteration: true };
  const item = { product_id: 'p', catalog_id: 0, owner_id: -2, product_name: '', price: '1.50', description: 'e\u0301',
    currency_unit: 'x'.repeat(256), path: '', product_photos, create_time: -2.5, unknown: true };
  const change = one(catalog('add_prod', { item, version_catalog: undefined, version_ls_catalog: '' })).change;
  assert.deepEqual(change.item.value, { product_id: 'p', catalog_id: 0, owner_id: -2, product_name: '', price: '1.50', description: 'e\u0301',
    currency_unit: 'x'.repeat(256), path: '', product_photos, create_time: -2.5 });
  assert.equal(Object.hasOwn(change.versionCatalog, 'value'), false); assert.equal(change.versionCatalog.raw, undefined);
  assert.deepEqual(change.versionListCatalog, { raw: '', value: '' });
  const missing = one(catalog('edit_prod', { item: { product_id: 'p' } })).change;
  assert.equal(Object.hasOwn(missing, 'versionCatalog'), false); assert.equal(Object.hasOwn(missing, 'versionListCatalog'), false);
  const unsupported = { product_id: 'p', catalog_id: Number.MAX_SAFE_INTEGER + 1, owner_id: '', product_name: 1, price: 1,
    description: 'x'.repeat(65_537), currency_unit: 'x'.repeat(257), path: null, create_time: Infinity };
  assert.deepEqual(one(catalog('add_prod', { item: unsupported })).change.item.value, { product_id: 'p' });
});

test('single product deletion uses root truthy product_id and independently retains optional catalog ID presence', () => {
  for (const product_id of ['0', -1, true, {}, 'x'.repeat(257)]) {
    const change = one(catalog('del_prod', { product_id, catalog_id: null, item: { product_id: 'ignored' } })).change;
    assert.equal(change.kind, 'product-delete-signal'); assert.equal(change.productId.raw, product_id);
    assert.deepEqual(change.catalogId, { raw: null });
  }
  for (const product_id of [undefined, null, false, 0, -0, '']) absent(catalog('del_prod', { product_id, item: { product_id: 'not-root' } }));
  for (const catalog_id of [undefined, null, false, 0, '', '0']) {
    const change = one(catalog('del_prod', { product_id: 'p', catalog_id })).change;
    assert.equal(Object.hasOwn(change, 'catalogId'), true); assert.equal(change.catalogId.raw, catalog_id);
  }
  assert.equal(Object.hasOwn(one(catalog('del_prod', { product_id: 'p' })).change, 'catalogId'), false);
});

test('product list deletion uses only dense product_ids values, preserves unsupported slots, and does not execute iterators/extras', () => {
  let reads = 0, iterated = 0; const hostile = () => { reads++; throw Error(privateText); };
  const ids = [0, -0, -2, '000p', '000p', null, false, undefined, { product_id: 'not-an-ID' }];
  Object.defineProperty(ids, Symbol.iterator, { value() { iterated++; throw Error(privateText); } });
  Object.defineProperty(ids, 'unknown', { get: hostile });
  const change = one(catalog('del_list_prod', { product_ids: ids, catalog_id: 0, ids: ['ignored'] })).change;
  assert.deepEqual(change.productIds.map(entry => entry.raw), [0, -0, -2, '000p', '000p', null, false, undefined, ids[8]]);
  assert.deepEqual(change.productIds.slice(0, 5).map(entry => entry.value), [0, -0, -2, '000p', '000p']);
  for (const entry of change.productIds.slice(5)) assert.equal(Object.hasOwn(entry, 'value'), false);
  assert.deepEqual(change.catalogId, { raw: 0, value: 0 }); assert.equal(iterated, 0); assert.equal(reads, 0);
  for (const data of [{ ids: ['wrong'] }, { items: ['wrong'] }, { product_ids: 'opaque' }, { product_ids: null }, { product_ids: new Array(1) }, { product_ids: new Proxy([], {}) }]) absent(catalog('del_list_prod', data));
  const accessor = []; Object.defineProperty(accessor, 0, { get: hostile }); absent(catalog('del_list_prod', { product_ids: accessor }));
  const huge = new Array(20_001); Object.defineProperty(huge, 0, { get: hostile }); absent(catalog('del_list_prod', { product_ids: huge }));
  assert.equal(reads, 0);
});

test('empty deletion lists remain valid after attempted-slot budget exhaustion and malformed lists do not refund slots', () => {
  const events = extract([catalog('del_list_prod', { product_ids: Array(20_000).fill(null) }), catalog('del_list_prod', { product_ids: ['blocked'] }),
    catalog('del_list_prod', { product_ids: [] }), catalog('del_catalog'), catalog('enable_feature')]);
  assert.equal(events[0].change.productIds.length, 20_000); assert.equal(Object.hasOwn(events[1], 'change'), false);
  assert.deepEqual(events[2].change.productIds, []); assert.equal(events[3].change.kind, 'catalog-delete-signal');
  assert.equal(events[4].change.kind, 'catalog-feature-registration-signal');
  const charged = extract([catalog('del_list_prod', { product_ids: new Array(19_999) }), catalog('del_list_prod', { product_ids: ['a', 'b'] }),
    catalog('del_list_prod', { product_ids: ['last'] }), catalog('del_list_prod', { product_ids: [] })]);
  for (const event of charged.slice(0, 3)) assert.equal(Object.hasOwn(event, 'change'), false);
  assert.deepEqual(charged[3].change.productIds, []);
  const oversized = extract([catalog('del_list_prod', { product_ids: new Array(20_001) }), catalog('del_list_prod', { product_ids: [] })]);
  assert.equal(Object.hasOwn(oversized[0], 'change'), false); assert.deepEqual(oversized[1].change.productIds, []);
  assert.equal(one(catalog('del_list_prod', { product_ids: ['new-frame'] })).change.productIds.length, 1);
});

test('catalog add/edit preserve independently original aliases and large count values, with empty partial items valid and unsupported items raw-only', () => {
  const item = { id: 'original', name: 'raw-name', version: 0, catalog_id: 'different', catalog_name: '', version_catalog: '',
    ownerId: -1, created_time: -2.5, isDefault: false, catalog_photo: null, catalogPhoto: '', path: '', totalProduct: 4294967297 };
  for (const act of ['add_catalog', 'edit_catalog']) {
    const change = one(catalog(act, { item, version_catalog: 'not-used' })).change;
    assert.equal(change.kind, act === 'add_catalog' ? 'catalog-add-signal' : 'catalog-update-signal');
    assert.deepEqual(change.item.value, item); assert.equal(change.item.raw, item); assert.equal(Object.hasOwn(change, 'versionCatalog'), false);
    assert.deepEqual(one(catalog(act, { item: {} })).change.item.value, {});
    for (const raw of [undefined, null, false, [], 'not-row', new Proxy({}, {})]) absent(catalog(act, { item: raw }));
  }
  const bad = { id: '', name: false, version: NaN, catalog_id: [], catalog_name: 'x'.repeat(65_537), version_catalog: {}, ownerId: true,
    created_time: false, isDefault: 1, catalog_photo: 1, catalogPhoto: {}, path: null, totalProduct: 'x'.repeat(257) };
  assert.deepEqual(one(catalog('add_catalog', { item: bad })).change.item.value, {});
});

test('catalog deletion is fieldless for absent/null/primitive data and captures own CID without a truthy-ID or cascade claim', () => {
  for (const raw of [undefined, null, false, 0, '', 'raw', 1n, Symbol('raw')]) {
    const change = one(catalog('del_catalog', raw)).change;
    assert.equal(change.kind, 'catalog-delete-signal'); assert.equal(change.raw, raw); assert.equal(Object.hasOwn(change, 'catalogId'), false);
    assert.equal(Object.hasOwn(change, 'productsDeleted'), false);
  }
  for (const catalog_id of [undefined, null, false, 0, -0, '', '0']) {
    const change = one(catalog('del_catalog', { catalog_id })).change;
    assert.equal(Object.hasOwn(change, 'catalogId'), true); assert.equal(change.catalogId.raw, catalog_id);
  }
  const array = []; Object.defineProperty(array, 'catalog_id', { value: 'array-own' });
  assert.equal(one(catalog('del_catalog', array)).change.catalogId.value, 'array-own');
  class Custom {}
  for (const raw of [() => {}, new Custom(), new Proxy({}, {})]) absent(catalog('del_catalog', raw));
});

test('enable_feature recognizes any unused normalized container without inspecting it or deriving an enabled Boolean', () => {
  let reads = 0; const hostile = () => { reads++; throw Error(privateText); };
  const proxy = new Proxy({}, { get: hostile, ownKeys: hostile, getPrototypeOf: hostile, getOwnPropertyDescriptor: hostile });
  class Custom {}
  for (const raw of [undefined, null, false, 0, '', [], {}, () => {}, new Custom(), proxy]) {
    const change = one(catalog('enable_feature', raw)).change;
    assert.equal(change.kind, 'catalog-feature-registration-signal'); assert.equal(change.raw, raw); assert.equal(Object.hasOwn(change, 'enabled'), false);
  }
  assert.equal(reads, 0); absent(catalog('enable_feature', '{bad'));
});

test('selected descriptor faults suppress only promised projections; unknown metadata remains raw and untraversed', () => {
  let reads = 0; const hostile = () => { reads++; throw Error(privateText); };
  for (const name of ['item', 'version_catalog', 'version_ls_catalog']) {
    const data = { item: { product_id: 'p' } }; Object.defineProperty(data, name, { get: hostile }); absent(catalog('add_prod', data));
  }
  const predicate = {}; Object.defineProperty(predicate, 'product_id', { get: hostile }); absent(catalog('add_prod', { item: predicate }));
  const item = { product_id: 'p' }; Object.defineProperty(item, 'price', { get: hostile });
  const change = one(catalog('add_prod', { item })).change; assert.equal(change.item.raw, item); assert.equal(Object.hasOwn(change.item, 'value'), false);
  const data = { item: {} }; Object.defineProperty(data, 'version_catalog', { get: hostile });
  assert.equal(one(catalog('add_catalog', data)).change.kind, 'catalog-add-signal');
  const del = {}; Object.defineProperty(del, 'catalog_id', { get: hostile }); absent(catalog('del_catalog', del));
  const opaque = new Proxy({}, { get: hostile, ownKeys: hostile, getPrototypeOf: hostile });
  const raw = { product_id: 'p', product_photos: opaque }; Object.defineProperty(raw, 'future', { get: hostile });
  const value = one(catalog('add_prod', { item: raw })).change.item.value;
  assert.equal(value.product_photos, opaque); assert.equal(reads, 0); assert.equal(Object.isFrozen(raw), false);
});

test('exact one-layer JSON normalization retains unsafe integer tokens and unsupported/future controls without trimming', () => {
  const json = '{"item":{"product_id":900719925474099312345,"owner_id":"original-owner-text"},"version_catalog":0,"version_ls_catalog":""}';
  const control = catalog('add_prod', json), event = one(control);
  assert.equal(event.change.item.value.product_id, '900719925474099312345'); assert.equal(event.change.item.value.owner_id, 'original-owner-text');
  assert.equal(event.rawContent.data, json); assert.equal(event.change.versionCatalog.value, 0);
  for (const raw of [` ${json}`, JSON.stringify(json), '{bad', '[]']) absent(catalog('add_prod', raw));
  const unknown = catalog('future-act', { item: { product_id: 'p' } }); assert.equal(absent(unknown).rawControl, unknown);
});

test('common strict601603 status/reset/own-frame/text bounds and pure no-clock/no-fetch behavior stay unchanged', () => {
  const control = catalog('del_catalog');
  for (const options of [{ cmd: 603, subCmd: 1 }, { subCmd: 255 }, { resetLastActionId: null }, { resetLastActionId: 0 }, { resetLastActionId: '0' }]) assert.equal(extractProductCatalogEvents(frame([control], options))[0].change.kind, 'catalog-delete-signal');
  for (const options of [{ cmd: 614 }, { cmd: 610 }, { version: 2 }, { subCmd: 256 }, { code: '0' }, { code: 212 }, { transportCode: '0' }, { transportCode: 212 }, { resetLastActionId: '1' }]) assert.equal(extractProductCatalogEvents(frame([control], options)), undefined);
  assert.deepEqual(extract([]), []); assert.deepEqual(extract([row('quick_message', 'create', {})]), []);
  assert.equal(extract(Array(20_001).fill(control)), undefined);
  assert.equal(extract([catalog('enable_feature', '🙂'.repeat(16_385))]), undefined);
  assert.equal(extract(Array.from({ length: 17 }, () => catalog('enable_feature', 'x'.repeat(65_536)))), undefined);
  assert.equal(extract([row('profile', 'biz', 'x'.repeat(1_048_577)), control]).length, 1);
  let reads = 0; const bad = frame([control]); Object.defineProperty(bad, 'cmd', { get() { reads++; throw Error(privateText); } });
  assert.equal(extractProductCatalogEvents(bad), undefined); assert.equal(reads, 0);
  const oldNow = Date.now, oldFetch = globalThis.fetch; Date.now = () => { throw Error('unexpected clock'); }; globalThis.fetch = () => { throw Error('unexpected fetch'); };
  try { assert.equal(one(control).change.kind, 'catalog-delete-signal'); } finally { Date.now = oldNow; globalThis.fetch = oldFetch; }
});
