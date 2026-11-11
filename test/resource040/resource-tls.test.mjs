import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('040 TLS: one bounded trusted native-fetch child proves viewer wire header, no Cookie and zero redirect destination GETs', { timeout: 13000 }, async () => {
  const environment = { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('./tls/listener-cert.pem', import.meta.url)), NODE_OPTIONS: '' };
  delete environment.NODE_TLS_REJECT_UNAUTHORIZED;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./resource-tls-child.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('.', import.meta.url)), env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
  });
  let stdout = '', stderr = '', killedForBound = false, timer;
  const killOwned = () => { killedForBound = true; if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  const collect = target => chunk => {
    const text = chunk.toString('utf8');
    if ((target === 'stdout' ? stdout.length : stderr.length) + text.length > 65536) { killOwned(); return; }
    if (target === 'stdout') stdout += text; else stderr += text;
  };
  child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
  const terminal = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    timer = setTimeout(killOwned, 10000);
  }).finally(() => clearTimeout(timer));
  assert.equal(killedForBound, false, 'exact owned child must terminate inside the finite bound');
  assert.equal(terminal.signal, null); assert.equal(terminal.code, 0, stderr);
  const observation = JSON.parse(stdout);
  assert.equal(observation.kind, 'sdk040-fixture-only-tls-child'); assert.equal(observation.groups, 1);
  assert.equal(observation.setupAdapterCalls, 3); assert.equal(observation.resourceWireRequests, 2);
  assert.equal(observation.terminalWireRequests, 0); assert.equal(observation.bytes, 4097);
  assert.match(observation.sha256, /^[0-9a-f]{64}$/);
});
