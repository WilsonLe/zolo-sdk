import assert from 'node:assert/strict';
import test from 'node:test';
import { ThreadType } from 'zalo-personal-sdk';
import { apiFixture, base } from './fixtures/pinned-cookie.mjs';

for (const kind of ['voice', 'video']) test('037 actual ' + (kind === 'voice' ? 'sendVoice' : 'sendVideo') + ' external HEAD keeps raw on its visible GET hop and then uses normal account POST', async () => {
  const f = apiFixture(), original = 'https://media.fixture.invalid/a/source.' + (kind === 'voice' ? 'mp3' : 'mp4');
  const terminal = 'https://terminal.fixture.invalid/b/content';
  f.cookie.setCookieSync('account037=normal-account; Path=/api', base);
  f.cookie.setCookieSync('media037=must-not-dispatch; Path=/', original);
  f.cookie.setCookieSync('terminal037=must-not-dispatch; Path=/', terminal);
  const before = f.cookie.serializeSync().cookies.map(cookie => ({ ...cookie }));
  f.hooks.respond = call => {
    if (call.url.hostname === 'media.fixture.invalid') return new Response(null, { status: 200,
      headers: { Location: terminal, 'set-cookie': 'rawFirst037=must-not-import; Path=/' } });
    if (call.url.hostname === 'terminal.fixture.invalid') return new Response(null, { status: 200,
      headers: { 'content-length': '64', 'set-cookie': 'rawLast037=must-not-import; Path=/' } });
    assert.equal(call.url.pathname, '/api/message/forward'); return f.reply({ msgId: kind === 'voice' ? '37' : 37 });
  };
  const result = kind === 'voice'
    ? await f.api.sendVoice({ voiceUrl: original, ttl: 0 }, '9300000000000000038', ThreadType.User)
    : await f.api.sendVideo({ videoUrl: original, thumbnailUrl: 'https://media.fixture.invalid/thumb.jpg',
      width: 400, height: 300, duration: 1000, ttl: 0 }, '9300000000000000038', ThreadType.User);
  assert.equal(result.msgId, kind === 'voice' ? '37' : 37); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].raw, original); assert.equal(f.calls[0].init.method, 'HEAD');
  assert.equal(f.calls[1].raw, terminal); assert.equal(f.calls[1].init.method, 'GET');
  for (const call of f.calls.slice(0, 2)) for (const name of ['cookie', 'user-agent', 'referer', 'origin', 'accept-language'])
    assert.equal(call.headers.has(name), false);
  assert.equal(f.calls[2].init.method, 'POST'); assert.equal(f.calls[2].cookies.get('account037'), 'normal-account');
  assert.equal(f.cookie.getCookiesSync(original).some(cookie => cookie.key === 'rawFirst037'), false);
  assert.equal(f.cookie.getCookiesSync(terminal).some(cookie => cookie.key === 'rawLast037'), false);
  const after = f.cookie.serializeSync().cookies;
  assert.deepEqual(after.map(cookie => [cookie.key, cookie.value, cookie.domain, cookie.path]),
    before.map(cookie => [cookie.key, cookie.value, cookie.domain, cookie.path]));
  assert.equal(f.listenerStarts(), 0);
});
