import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { renderDesktopQr } from '../bin/desktop.mjs';
import { FileDesktopSessionStore } from '../dist/desktop-session-store.js';
import { FileSessionStore } from '../dist/session-store.js';

const execute = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function setup(t, failBootstrap = false) {
  const directory = await mkdtemp(join(tmpdir(), 'zalo-desktop-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, 'provider.mjs');
  const fixture = pathToFileURL(join(root, 'test/fixtures/desktop-login.mjs')).href;
  await writeFile(preload, `import {desktopLoginFixture} from ${JSON.stringify(fixture)};\nconst provider=desktopLoginFixture({mode:'png'});\nglobalThis.fetch=async(input,init)=>{const response=await provider.fetch(input,init);if(${failBootstrap}&&new URL(input).pathname==='/api/login/getServerInfo'){const body=await response.json();body.data.setttings.features.socket.retries={'invalid/profile':{times:1000}};return Response.json(body);}return response;};\n`);
  const desktopPath = join(directory, 'desktop.json');
  const webPath = join(directory, 'web.json');
  const run = (...args) => execute(process.execPath, ['--import', preload, 'bin/zalo.mjs', ...args], {
    cwd: root, timeout: 4000, env: { ...process.env,
      ZALO_DESKTOP_SESSION_PATH: desktopPath, ZALO_SESSION_PATH: webPath,
      ZALO_DESKTOP_AUTH_ORIGIN: 'https://wpa.zaloapp.com', ZALO_DESKTOP_POLL_ORIGINS: 'https://qr-id.zaloapp.com',
      ZALO_DESKTOP_USER_AGENT: 'Fixture CLI',
    },
  });
  return { run, desktopPath, webPath };
}

test('CLI Desktop login saves private credentials, removes QR, verifies and forgets through normal commands', async t => {
  const { run, desktopPath, webPath } = await setup(t);
  const web = { imei: 'fixture-web', userAgent: 'fixture-web', cookie: [{ key: 'web', value: 'synthetic-web' }] };
  await new FileSessionStore(webPath).save(web);
  const before = await readFile(webPath, 'utf8');
  const login = await run('desktop-login');
  assert.match(login.stdout, /Desktop sign-in completed/);
  assert.doesNotMatch(login.stdout + login.stderr, /synthetic-approved-session|synthetic-refresh|9007199254740993/);
  const image = login.stdout.split('\n').find(line => line.endsWith('.png'));
  assert.ok(image);
  await assert.rejects(stat(image), { code: 'ENOENT' });
  const record = await new FileDesktopSessionStore(desktopPath).load();
  assert.equal(record.credentials.sessionToken, 'synthetic-approved-session');
  assert.equal(record.credentials.refreshToken, 'synthetic-refresh');
  if (process.platform !== 'win32') assert.equal((await stat(desktopPath)).mode & 0o777, 0o600);
  const verified = await run('desktop-verify');
  assert.match(verified.stdout, /Desktop session accepted and profile read succeeded/);
  assert.doesNotMatch(verified.stdout + verified.stderr, /9007199254740993|synthetic-approved-session/);
  await run('desktop-forget');
  assert.equal(await new FileDesktopSessionStore(desktopPath).load(), null);
  assert.equal(await readFile(webPath, 'utf8'), before);
});

test('CLI Desktop probe cancels after QR and leaves both credential paths absent', async t => {
  const { run, desktopPath, webPath } = await setup(t);
  const result = await run('desktop-probe');
  assert.match(result.stdout, /issued a desktop QR PNG/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-approved-session|synthetic-refresh/);
  assert.equal(await new FileDesktopSessionStore(desktopPath).load(), null);
  assert.equal(await new FileSessionStore(webPath).load(), null);
});

test('CLI renders text and preserves provider PNG bytes with a PNG signature', async () => {
  const png = await renderDesktopQr({ kind: 'text', text: 'synthetic Z1@ QR fixture +/="\nTiếng Việt' });
  assert.ok(png.length > 100);
  assert.deepEqual(await renderDesktopQr({ kind: 'png', png }), png);
  await assert.rejects(renderDesktopQr({ kind: 'png', png: Buffer.from('invalid synthetic image') }), /Desktop QR image is invalid/);
});

test('CLI reports safe bootstrap reason after approval without printing or saving credentials', async t => {
  const { run, desktopPath } = await setup(t, true);
  await assert.rejects(run('desktop-login'), error => {
    assert.match(error.stderr, /bootstrap-failed/);
    assert.match(error.stderr, /reason:unsupported-config/);
    assert.match(error.stderr, /stage:bootstrap/);
    assert.doesNotMatch(error.stderr + error.stdout, /synthetic-approved-session|synthetic-refresh|9007199254740993/);
    return true;
  });
  assert.equal(await new FileDesktopSessionStore(desktopPath).load(), null);
});
