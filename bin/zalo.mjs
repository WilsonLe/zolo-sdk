#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FileSessionStore, PersonalZalo, startRealtimeFrameFeed, ZaloSignInError } from '../dist/index.js';
import { DesktopCliError, runDesktopCommand } from './desktop.mjs';

const help = `Usage: zalo-personal <login | probe | verify [--realtime] | forget | desktop-login | desktop-probe | desktop-verify [--realtime] | desktop-forget>

  login   Save a personal session after you scan and approve a QR in Zalo.
  probe   Check if Zalo issues a QR, then cancel without saving it or logging in.
  verify  Resume the saved session and read your profile without printing it.
          Add --realtime to verify the message socket. It can replace a running web listener.
  forget  Delete the saved local session. This does not unlink the web device.

  desktop-login   Scan and approve a Desktop QR, then save its separate private session.
  desktop-probe   Check Desktop QR issuance, then cancel before scanning.
  desktop-verify  Bootstrap the saved Desktop session and read its profile.
                 Add --realtime to check its socket. It may replace another desktop listener.
  desktop-forget  Delete the local Desktop session file.

Set ZALO_SESSION_PATH to override ~/.config/zalo-personal-sdk/session.json.
Set ZALO_DESKTOP_SESSION_PATH to override ~/.config/zalo-personal-sdk/desktop-session.json.`;

const path = process.env.ZALO_SESSION_PATH
  ? resolve(process.env.ZALO_SESSION_PATH)
  : join(homedir(), '.config', 'zalo-personal-sdk', 'session.json');
const client = new PersonalZalo({ store: new FileSessionStore(path) });
const controller = new AbortController();
const cancel = () => controller.abort();

class CliError extends Error {}

async function login() {
  const directory = await mkdtemp(join(tmpdir(), 'zalo-qr-'));
  const qrPath = join(directory, 'login.png');
  try {
    await client.loginWithQR({
      signal: controller.signal,
      onEvent(event) {
        if (event.type === 'qr') {
          writeFileSync(qrPath, event.png, { mode: 0o600, flag: 'wx' });
          console.log(`Open this image, scan it with Zalo, and approve on your phone:\n${qrPath}`);
        }
        if (event.type === 'scanned') console.log('QR scanned. Approve the sign-in on your phone.');
      },
    });
    console.log('Signed in. The local session was saved.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function probe() {
  let gotQr = false;
  try {
    await client.loginWithQR({
      signal: controller.signal,
      onEvent(event) {
        if (event.type === 'qr') {
          gotQr = event.png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
          controller.abort();
        }
      },
    });
  } catch (error) {
    if (!gotQr || !(error instanceof ZaloSignInError) || error.code !== 'aborted') throw error;
    console.log('Zalo issued a QR PNG. The challenge was cancelled locally before scanning.');
    return;
  }
  throw new Error('Unexpected sign-in result during probe.');
}

async function verifyRealtime(api) {
  const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
  const { promise: failure, resolve: fail } = Promise.withResolvers();
  let closeCode;
  const recordClose = (code) => { closeCode = code; };
  api.listener.once('closed', recordClose);
  try {
    const feed = startRealtimeFrameFeed(api, {
      signal: deadline,
      onError(error) { if (error.code === 'listener-failed') fail(false); },
    });
    try {
      if (!(await Promise.race([feed.ready, failure]))) {
        if (controller.signal.aborted) throw new CliError('The realtime check was cancelled.');
        if (deadline.aborted) throw new CliError('Zalo did not finish the realtime handshake in 15 seconds.');
        if (closeCode === 3000) throw new CliError('Zalo reported a competing realtime connection.');
        throw new CliError('The Zalo realtime connection ended before the handshake.');
      }
      console.log('Realtime socket authenticated and delivered its initial key frame.');
    } finally {
      feed.stop();
      await feed.closed;
    }
  } finally {
    api.listener.off('closed', recordClose);
  }
}

async function main(args) {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(help);
    return;
  }
  const realtime = (args[0] === 'verify' || args[0] === 'desktop-verify') && args[1] === '--realtime' && args.length === 2;
  if (args.length !== 1 && !realtime) throw new CliError('Expected one command. See --help.');
  if (args[0].startsWith('desktop-')) {
    await runDesktopCommand(args[0], { signal: controller.signal, verifyRealtime: realtime ? verifyRealtime : undefined });
    return;
  }
  switch (args[0]) {
    case 'login': await login(); break;
    case 'probe': await probe(); break;
    case 'verify': {
      const api = await client.resume(controller.signal);
      try { await api.fetchAccountInfo(); } catch { throw new CliError('Could not read the Zalo profile.'); }
      console.log('Saved session accepted and profile read succeeded.');
      if (realtime) await verifyRealtime(api);
      break;
    }
    case 'forget':
      await client.clearLocalSession();
      console.log('Local session cleared.');
      break;
    default: throw new CliError('Unknown command. See --help.');
  }
}

process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof ZaloSignInError || error instanceof CliError || error instanceof DesktopCliError
    ? error.message : 'Command failed. Check the session path and try again.');
  process.exitCode = controller.signal.aborted && process.argv[2] !== 'probe' && process.argv[2] !== 'desktop-probe' ? 130 : 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
