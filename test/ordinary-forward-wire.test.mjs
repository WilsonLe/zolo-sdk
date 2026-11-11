import assert from 'node:assert/strict';
import test from 'node:test';
import { SDK, fixture, forward, intent, target, exact, request, imei, frozenTree, jsonContent } from './fixtures/ordinary-forward.mjs';

// Expected wire objects are independently written from the settled native path.
// Neither a product formatter nor a production codec supplies these expectations.
test('W01 direct TEXT batches retain per-target TTLs, separate top TTL and exact common/accountAES form with no singular fields', async () => {
  const targets = [target(11, '00041', 7), target(12, '9410000000000000000000000000000000000001', 9)];
  const f = fixture();
  f.hooks.respond = call => {
    exact(f, call, { toIds: [{ clientId: 11, toUid: '00041', ttl: 7 }, { clientId: 12, toUid: targets[1].threadId, ttl: 9 }],
      imei, ttl: 123, msgType: '1', totalIds: 2, msgInfo: '{"message":"ordinary text"}' });
    return f.reply({ success: [{ clientId: '12', opaque: true }, { clientId: '11' }], failed: [] });
  };
  const result = await forward(f.api, intent({ targets, ttl: 123 }));
  assert.deepEqual(jsonContent(result.reportedSuccesses.map(entry => entry.target)), [
    { threadType: 'user', threadId: targets[1].threadId, clientId: 12, ttl: 9 },
    { threadType: 'user', threadId: '00041', clientId: 11, ttl: 7 }]);
  assert.deepEqual(result.unresolvedTargets, []); frozenTree(result);
  assert.equal(f.sent.length, 1); assert.equal(f.effects.listenerStarts, 0);
});

test('W02 group batches strip one lowercase g, omit IMEI/visibility and use FILE group/mforward instead of group service', async () => {
  const f = fixture();
  f.hooks.respond = call => {
    exact(f, call, { grids: [{ clientId: 21, grid: '00042', ttl: 0 }, { clientId: 22, grid: '43', ttl: 500 }],
      ttl: 0, msgType: '1', totalIds: 2, msgInfo: '{"message":""}' }, true);
    return f.reply({ failed: [{ clientId: '21', code: 'future' }] });
  };
  const result = await forward(f.api, intent({ threadType: 'group', targets: [target(21, 'g00042'), target(22, '43', 500)], source: { kind: 'text', text: '' } }));
  assert.deepEqual(jsonContent(result.reportedFailures[0].target), { threadType: 'group', threadId: '00042', clientId: 21, ttl: 0 });
  assert.deepEqual(result.unresolvedTargets.map(value => value.clientId), [22]); assert.equal(f.sent.length, 1);
});

test('W03 final RTF text/style stay byte exact, positive containType adds only its two-field paramsExt, and reference/decor are independent JSON text', async () => {
  const f = fixture(), text = 'cafe\u0301\n\u0000', rtfProps = ' { "opaque" : [1] } ', referenceLog = '', decorLogJson = ' \n [ {"future":1} ] \t';
  f.hooks.respond = call => {
    exact(f, call, { toIds: [{ clientId: 11, toUid: '00041', ttl: 0 }], imei, ttl: 0, msgType: '1', totalIds: 1,
      msgInfo: JSON.stringify({ message: text, rtfProps, paramsExt: { containType: 7, shouldParseLinkOrContact: 1 }, reference: '{"type":3,"data":""}' }), decorLog: decorLogJson });
    return f.reply({});
  };
  await forward(f.api, intent({ source: { kind: 'text', text, rtfProps, containType: 7 }, referenceLog, decorLogJson }));
  for (const rtf of ['', undefined]) {
    f.hooks.respond = call => {
      assert.deepEqual(JSON.parse(request(f, call).data.msgInfo), { message: '' }); return f.reply({});
    };
    await forward(f.api, intent({ ttl: undefined, referenceLog: undefined, decorLogJson: undefined,
      source: { kind: 'text', text: '', rtfProps: rtf, containType: 0 } }));
  }
  assert.equal(f.sent.length, 3);
});

test('W04 STICKER preserves numeric/text ID representation, category0 and open type, normalizing only native falsey extInfo', async () => {
  const f = fixture();
  for (const extInfo of [undefined, null, false, 0, -0, '']) {
    f.hooks.respond = call => {
      exact(f, call, { toIds: [{ clientId: 11, toUid: '00041', ttl: 0 }], imei, ttl: 0, msgType: '2', totalIds: 1,
        msgInfo: '{"emoId":"000012345678901234567890","catId":0,"type":"","extInfo":""}' }); return f.reply({});
    };
    await forward(f.api, intent({ source: { kind: 'sticker', stickerId: '000012345678901234567890', categoryId: 0, type: '', extInfo } }));
  }
  for (const extInfo of [true, -1, 1.5, ' {"opaque":true} ', [0, null], { future: { nested: 1 } }]) {
    f.hooks.respond = call => {
      assert.equal(request(f, call).data.msgType, '2');
      assert.deepEqual(JSON.parse(request(f, call).data.msgInfo), { emoId: 0, catId: '0000', type: -77, extInfo }); return f.reply({});
    };
    await forward(f.api, intent({ source: { kind: 'sticker', stickerId: 0, categoryId: '0000', type: -77, extInfo } }));
  }
  assert.equal(f.sent.length, 12);
});

test('W05 LINK maps title to message but always url to linkTitle, retaining null/empty fields and opaque extension string', async () => {
  const f = fixture(), url = 'HTTPS://ordinary.fixture.invalid:443/A%2fb?x=1+2&x=%2F#Exact', extData = ' {"not":"parsed"} ';
  f.hooks.respond = call => {
    exact(f, call, { grids: [{ clientId: 11, grid: '00041', ttl: 0 }], ttl: 0, msgType: '3', totalIds: 1,
      msgInfo: JSON.stringify({ link: url, linkTitle: url, linkDesc: null, linkThumb: '', linkType: null, extData, message: 'caller caption' }) }, true);
    return f.reply({});
  };
  await forward(f.api, intent({ threadType: 'group', source: { kind: 'link', url, title: 'caller caption', description: null, thumbnailUrl: '', type: null, extData } }));
  f.hooks.respond = call => {
    assert.deepEqual(JSON.parse(request(f, call).data.msgInfo), { link: url, linkTitle: url }); return f.reply({});
  };
  await forward(f.api, intent({ source: { kind: 'link', url, title: undefined, description: undefined, thumbnailUrl: undefined, type: undefined, extData: undefined } }));
  for (const extData of [null, false, 0, '', [], { future: true }]) {
    f.hooks.respond = call => {
      assert.deepEqual(JSON.parse(request(f, call).data.msgInfo), { link: url, linkTitle: url, linkDesc: '', linkThumb: null, linkType: -5, extData, message: null }); return f.reply({});
    };
    await forward(f.api, intent({ source: { kind: 'link', url, title: null, description: '', thumbnailUrl: null, type: -5, extData } }));
  }
  assert.equal(f.sent.length, 8);
});

test('W06 independent AES128/192/256 account envelopes all produce one batch and never fetch source/preview/thumbnail', async () => {
  for (const bytes of [16, 24, 32]) {
    const f = fixture({ key: Buffer.alloc(bytes, bytes) });
    f.hooks.respond = call => {
      exact(f, call, { toIds: [{ clientId: 11, toUid: '00041', ttl: 0 }], imei, ttl: 0, msgType: '3', totalIds: 1,
        msgInfo: '{"link":"http://link.fixture.invalid/a","linkTitle":"http://link.fixture.invalid/a","linkThumb":"https://thumbnail.fixture.invalid/no-fetch","message":""}' });
      return f.reply({});
    };
    await forward(f.api, intent({ source: { kind: 'link', url: 'http://link.fixture.invalid/a', thumbnailUrl: 'https://thumbnail.fixture.invalid/no-fetch', title: '' } }));
    assert.equal(f.sent.length, 1); assert.equal(f.effects.listenerStarts, 0);
  }
});

test('W07 maximum50 destinations retain input order and caller IDs/TTLs without native splitting, discovery or generated action IDs', async () => {
  const f = fixture(), targets = Array.from({ length: 50 }, (_, index) => target(index + 1, String(index + 101), index));
  f.hooks.respond = call => {
    const data = request(f, call).data;
    assert.deepEqual(data.toIds, targets.map(value => ({ clientId: value.clientId, toUid: value.threadId, ttl: value.ttl })));
    assert.equal(data.totalIds, 50); assert.equal(data.ttl, 0); assert.equal(data.msgType, '1'); return f.reply({});
  };
  const result = await forward(f.api, intent({ targets }));
  assert.deepEqual(result.unresolvedTargets.map(value => value.clientId), targets.map(value => value.clientId)); assert.equal(f.sent.length, 1);
});

test('W08 pinned public api.forwardMessage remains a separate unchanged TEXT helper with its original success/fail vocabulary', async () => {
  const f = fixture();
  f.hooks.respond = call => {
    assert.equal(call.init.method, 'POST');
    const data = request(f, call).data;
    assert.equal(JSON.parse(data.msgInfo).message, 'legacy ordinary text');
    return f.reply({ success: [{ clientId: '991', msgId: '992' }], fail: [{ clientId: '993', error_code: '212' }] });
  };
  assert.equal(typeof f.api.forwardMessage, 'function');
  const result = await f.api.forwardMessage({ message: 'legacy ordinary text' }, ['00041'], SDK.ThreadType.User);
  assert.deepEqual(result.success, [{ clientId: '991', msgId: '992' }]); assert.deepEqual(result.fail, [{ clientId: '993', error_code: '212' }]);
  assert.equal(Object.hasOwn(result, 'failed'), false); assert.equal(f.sent.length, 1);
});
