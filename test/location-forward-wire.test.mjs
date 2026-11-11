import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, location, point, source, exactLocation, request, imei, jsonContent, frozenTree, forward, intent, target } from './fixtures/location-forward.mjs';

// Expected payloads are independent literal projections from the settled plan.
test('W01 direct selected static point uses singular FILE numeric7, explicit caller ID/TTL and context IMEI with exact metadata order', async () => {
  const f = fixture();
  f.hooks.respond = call => {
    exactLocation(f, call, { toId: '00042', clientId: 61, ttl: 1234, zsource: -1, msgType: 7,
      msgInfo: '{"title":"selected label","desc":"selected description","appId":"","lat":12.3456789012345,"lon":-74.9876543210123,"placeId":"000place"}', imei });
    return f.reply({ msgId: '0007001', minGlobalMsgId: '0007000', future: { kept: [1, false] } });
  };
  const result = await location(f.api, point({ ttl: 1234, source: source({ title: 'selected label', description: 'selected description', placeId: '000place' }) }));
  assert.deepEqual(jsonContent(result.target), { threadType: 'user', threadId: '00042', clientId: 61, ttl: 1234 });
  assert.equal(result.msgId, '0007001'); assert.equal(result.minGlobalMsgId, '0007000'); frozenTree(result);
  assert.equal(f.sent.length, 1); assert.equal(f.effects.listenerStarts, 0);
});

test('W02 group uses normalized grid and explicit open visibility without IMEI/toId; top TTL defaults independently to0', async () => {
  const f = fixture();
  f.hooks.respond = call => {
    exactLocation(f, call, { grid: '00043', visibility: Number.MAX_SAFE_INTEGER, clientId: 62, ttl: 0, zsource: -1, msgType: 7,
      msgInfo: '{"title":"","appId":"","lat":0,"lon":0}' }, true); return f.reply({});
  };
  const result = await location(f.api, point({ threadType: 'group', threadId: 'g00043', clientId: 62, visibility: Number.MAX_SAFE_INTEGER,
    source: { latitude: 0, longitude: -0 } }));
  assert.deepEqual(jsonContent(result.target), { threadType: 'group', threadId: '00043', clientId: 62, ttl: 0 });
  f.hooks.respond = call => {
    exactLocation(f, call, { grid: '43', visibility: 0, clientId: 62, ttl: 0, zsource: -1, msgType: 7,
      msgInfo: '{"title":"","appId":"","lat":-90,"lon":180}' }, true); return f.reply({});
  };
  await location(f.api, point({ threadType: 'group', threadId: '43', clientId: 62, source: { latitude: -90, longitude: 180 } }));
  assert.equal(f.sent.length, 2);
});

test('W03 finite coordinate boundary/fraction/zero values remain numbers, with no received17/current-location/map/source-ID fields', async () => {
  const f = fixture();
  for (const [latitude, longitude] of [[90, -180], [-90, 180], [0, 0], [-0, -0], [0.000001, -0.000001], [45.125, 179.999]]) {
    f.hooks.respond = call => {
      const data = request(f, call).data, info = JSON.parse(data.msgInfo);
      assert.equal(data.msgType, 7); assert.equal(typeof data.msgType, 'number');
      assert.deepEqual(info, { title: '', appId: '', lat: latitude === 0 ? 0 : latitude, lon: longitude === 0 ? 0 : longitude });
      for (const key of ['latitude', 'longitude', 'href', 'thumb', 'type', 'sourceID', 'isUserLocation']) assert.equal(Object.hasOwn(info, key), false);
      return f.reply({});
    };
    await location(f.api, point({ source: { latitude, longitude } }));
  }
  assert.equal(f.sent.length, 6); assert.equal(f.effects.listenerStarts, 0);
});

test('W04 title applies native falsey-to-empty only after JSON validation; all truthy open JSON values retain their representations', async () => {
  const f = fixture();
  for (const title of [undefined, null, false, 0, -0, '']) {
    f.hooks.respond = call => { assert.equal(request(f, call).data.msgInfo, '{"title":"","appId":"","lat":1,"lon":2}'); return f.reply({}); };
    await location(f.api, point({ source: { latitude: 1, longitude: 2, title } }));
  }
  for (const title of [true, -1, 1.5, ' {"opaque":true} ', [], {}, [false, null], { label: ['x'] }]) {
    f.hooks.respond = call => {
      assert.deepEqual(JSON.parse(request(f, call).data.msgInfo), { title, appId: '', lat: 1, lon: 2 }); return f.reply({});
    };
    await location(f.api, point({ source: { latitude: 1, longitude: 2, title } }));
  }
  assert.equal(f.sent.length, 14);
});

test('W05 description/placeId omit only undefined and preserve null/false/0/empty/JSON-looking text/object/array without a Place grammar', async () => {
  const f = fixture();
  for (const value of [null, false, 0, '', ' {"opaque":true} ', ['future', 1], { future: true }]) {
    f.hooks.respond = call => {
      assert.equal(request(f, call).data.msgInfo, JSON.stringify({ title: '', desc: value, appId: '', lat: 1, lon: 2, placeId: value })); return f.reply({});
    };
    await location(f.api, point({ source: { latitude: 1, longitude: 2, description: value, placeId: value } }));
  }
  f.hooks.respond = call => {
    assert.equal(request(f, call).data.msgInfo, '{"title":"","appId":"","lat":1,"lon":2}'); return f.reply({});
  };
  await location(f.api, point({ visibility: undefined, ttl: undefined, signal: undefined, referenceLog: undefined, decorLogJson: undefined,
    source: { latitude: 1, longitude: 2, title: undefined, description: undefined, placeId: undefined } }));
  assert.equal(f.sent.length, 8);
});

test('W06 reference/decor and Unicode are byte-faithful; no NFC/JSON-text rebuilding or resource fetch accompanies independent accountAES128/192/256', async () => {
  for (const bytes of [16, 24, 32]) {
    const f = fixture({ key: Buffer.alloc(bytes, bytes) }), title = 'cafe\u0301\n\u0000', referenceLog = '', decorLogJson = ' \n [ {"future":1} ] \t';
    f.hooks.respond = call => {
      exactLocation(f, call, { toId: '00042', clientId: 61, ttl: 0, zsource: -1, msgType: 7,
        msgInfo: JSON.stringify({ title, desc: 'https://opaque-label.invalid/not-fetched', appId: '', lat: 1, lon: 2,
          placeId: '{"not":"parsed"}', reference: '{"type":3,"data":""}' }), decorLog: decorLogJson, imei });
      return f.reply({});
    };
    await location(f.api, point({ source: { latitude: 1, longitude: 2, title, description: 'https://opaque-label.invalid/not-fetched', placeId: '{"not":"parsed"}' }, referenceLog, decorLogJson }));
    assert.equal(f.sent.length, 1); assert.equal(f.effects.listenerStarts, 0);
  }
});

test('W07 metadata bounds apply separately to each field, and ordinary JSON aliases/null-prototype records do not freeze caller data', async () => {
  const f = fixture(), value = Array(997).fill(null), shared = Object.assign(Object.create(null), { a: value }), metadata = { x: shared, y: shared };
  f.hooks.respond = call => {
    const info = JSON.parse(request(f, call).data.msgInfo);
    assert.deepEqual(info.title, Array(997).fill(null)); assert.deepEqual(info.desc, Array(997).fill(null));
    assert.deepEqual(info.placeId, { x: { a: Array(997).fill(null) }, y: { a: Array(997).fill(null) } }); return f.reply({});
  };
  // Each repeated subtree counts independently, placeId has1999 nodes, within2000.
  await location(f.api, point({ source: { latitude: 1, longitude: 2, title: value, description: value, placeId: metadata } }));
  assert.equal(Object.isFrozen(value), false); assert.equal(Object.isFrozen(shared), false); value.push('caller-owned');
  assert.equal(f.sent.length, 1);
});

test('W08 existing public batch operation remains a positive control independent of the new location export', async () => {
  const f = fixture();
  f.hooks.respond = call => {
    assert.match(call.url.pathname, /\/api\/message\/mforward$/);
    const data = request(f, call).data; assert.equal(data.msgType, '1');
    assert.deepEqual(data.toIds, [{ clientId: 11, toUid: '00041', ttl: 5 }]); return f.reply({ success: [{ clientId: '11', msgId: '711' }] });
  };
  const result = await forward(f.api, intent({ targets: [target(11, '00041', 5)] }));
  assert.equal(result.reportedSuccesses[0].target.clientId, 11); assert.equal(result.reportedSuccesses[0].row.msgId, '711'); assert.equal(f.sent.length, 1);
});
