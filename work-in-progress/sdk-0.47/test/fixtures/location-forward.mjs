import assert from 'node:assert/strict';
import { SDK, fileBase, apiVersion, apiType, request, fixed as ordinaryError, privacy } from './ordinary-forward.mjs';
export * from './ordinary-forward.mjs';

export const source = (patch = {}) => ({ latitude: 12.3456789012345, longitude: -74.9876543210123, ...patch });
export const point = (patch = {}) => ({ threadType: 'user', threadId: '00042', clientId: 61, source: source(), ...patch });
export function location(api, input) {
  assert.equal(typeof SDK.forwardLocation, 'function', 'The public selected static-location operation must exist.');
  return SDK.forwardLocation(api, input);
}
export function fixed(code, submitted, outcomeUnknown, details = {}) {
  const check = ordinaryError(code, submitted, outcomeUnknown, details);
  return error => {
    check(error);
    const text = `${error} ${error.stack} ${JSON.stringify(error)}`;
    for (const privateCoordinate of ['12.3456789012345', '-74.9876543210123']) assert.equal(text.includes(privateCoordinate), false);
    for (const name of ['latitude', 'longitude', 'coordinates', 'target']) assert.equal(Object.hasOwn(error, name), false);
    return true;
  };
}
export function invalid(error) {
  assert.ok(error instanceof TypeError); privacy(error);
  const text = `${error} ${error.stack} ${JSON.stringify(error)}`;
  for (const coordinate of ['12.3456789012345', '-74.9876543210123']) assert.equal(text.includes(coordinate), false);
  return true;
}
export function exactLocation(f, call, expected, group = false) {
  assert.equal(call.raw, `${fileBase}/api/${group ? 'group' : 'message'}/forward?zpw_ver=${apiVersion}&zpw_type=${apiType}`);
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'error');
  const headers = new Headers(call.init.headers);
  assert.match(headers.get('content-type'), /^application\/x-www-form-urlencoded/);
  const cookies = new Map((headers.get('cookie') ?? '').split(';').filter(Boolean).map(text => {
    const [name, ...value] = text.trim().split('='); return [name, value.join('=')];
  }));
  assert.equal(cookies.get('root_fixture'), 'allowed'); assert.equal(cookies.get('tenant_fixture'), 'matching');
  assert.equal(cookies.has('wrong_path'), false); assert.equal(cookies.has('foreign_host'), false);
  const result = request(f, call); assert.deepEqual(result.data, expected);
  assert.equal(result.data.msgType, 7); assert.equal(typeof result.data.msgType, 'number');
  assert.notEqual(result.encrypted, result.text);
  for (const key of ['totalIds', 'toIds', 'grids']) assert.equal(Object.hasOwn(result.data, key), false);
  if (group) { assert.equal(Object.hasOwn(result.data, 'imei'), false); assert.equal(Object.hasOwn(result.data, 'toId'), false); }
  else assert.equal(Object.hasOwn(result.data, 'visibility'), false);
  return result;
}
