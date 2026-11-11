import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import QRCode from 'qrcode';
import {
  connectDesktopSession, DesktopLoginError, DesktopSessionError, FileDesktopSessionStore, loginDesktopWithQR,
} from '../dist/index.js';

export class DesktopCliError extends Error {}
const diagnosticReasons = new Set([
  'invalid-credentials', 'invalid-response', 'invalid-endpoint', 'unsupported-config', 'account-mismatch',
  'provider-rejected', 'request-failed', 'response-limit', 'timed-out', 'aborted', 'closed',
  'invalid-state', 'invalid-poll-origin', 'expired',
]);
const diagnosticStages = new Set(['challenge', 'scan', 'approval', 'bootstrap', 'persistence']);

/** Exact UTF-8 bytes, opaque black/white modules and the standard four-module quiet zone. */
export async function renderDesktopQr(qr) {
  const png = qr.kind === 'png' ? Buffer.from(qr.png)
    : qr.kind === 'text' ? await QRCode.toBuffer([{ data: Buffer.from(qr.text, 'utf8'), mode: 'byte' }], {
      errorCorrectionLevel: 'M', margin: 4, scale: 8,
    }) : undefined;
  if (!png?.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new DesktopCliError('Desktop QR image is invalid.');
  return png;
}

export async function runDesktopCommand(command, { signal, verifyRealtime }) {
  const path = process.env.ZALO_DESKTOP_SESSION_PATH ? resolve(process.env.ZALO_DESKTOP_SESSION_PATH)
    : join(homedir(), '.config', 'zalo-personal-sdk', 'desktop-session.json');
  const authOrigin = process.env.ZALO_DESKTOP_AUTH_ORIGIN ?? 'https://wpa.zaloapp.com';
  const pollOrigins = process.env.ZALO_DESKTOP_POLL_ORIGINS?.split(',') ?? ['https://qr-id.zaloapp.com'];
  const store = new FileDesktopSessionStore(path);
  try {
    if (command === 'desktop-forget') {
      await store.clear();
      console.log('Local desktop session cleared.');
      return;
    }
    if (command === 'desktop-verify') {
      const record = await store.load();
      if (!record) throw new DesktopCliError('No saved desktop session. Run desktop-login first.');
      const connection = await connectDesktopSession(record.credentials, { authOrigin, signal });
      try {
        await connection.api.fetchAccountInfo();
        await store.save({ ...record, credentials: connection.snapshot() });
        console.log('Desktop session accepted and profile read succeeded.');
        if (verifyRealtime) await verifyRealtime(connection.api);
      } finally { connection.close(); }
      return;
    }
    if (command !== 'desktop-login' && command !== 'desktop-probe') throw new DesktopCliError('Unknown desktop command. See --help.');
    const userAgent = process.env.ZALO_DESKTOP_USER_AGENT
      ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
    const imei = `${randomUUID()}-${createHash('md5').update(userAgent).digest('hex')}`;
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let gotQr = false;
    const directory = command === 'desktop-login' ? await mkdtemp(join(tmpdir(), 'zalo-desktop-qr-')) : undefined;
    let previousQr;
    try {
      const result = await loginDesktopWithQR({
        authOrigin, allowedPollOrigins: pollOrigins, imei, userAgent, computerName: 'Zalo SDK', language: 'en', signal: combined,
        async onEvent(event, context) {
          context.signal.throwIfAborted();
          if (event.type === 'qr') {
            const png = await renderDesktopQr(event.qr);
            context.signal.throwIfAborted();
            gotQr = true;
            if (command === 'desktop-probe') { controller.abort(); return; }
            const image = join(directory, `login-${event.generation}.png`);
            await writeFile(image, png, { mode: 0o600, flag: 'wx' });
            context.signal.throwIfAborted();
            if (previousQr) await rm(previousQr, { force: true });
            context.signal.throwIfAborted();
            previousQr = image;
            console.log(`Open this image, scan it with Zalo, and approve on your phone:\n${image}`);
          }
          if (event.type === 'scanned') console.log('Desktop QR scanned. Approve the sign-in on your phone.');
        },
        persist: command === 'desktop-login' ? ({ session, companion }, context) => {
          context.signal.throwIfAborted();
          return store.save({ credentials: session, ...(companion ? { companion } : {}) });
        } : undefined,
      });
      result.connection.close();
      if (command === 'desktop-probe') throw new DesktopCliError('Unexpected sign-in result during desktop probe.');
      console.log('Desktop sign-in completed and the private session was saved.');
    } catch (error) {
      if (command !== 'desktop-probe' || !gotQr || !(error instanceof DesktopLoginError) || error.code !== 'aborted') throw error;
      console.log('Zalo issued a desktop QR PNG. The challenge was cancelled locally before scanning.');
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  } catch (error) {
    if (error instanceof DesktopCliError) throw error;
    if (error instanceof DesktopLoginError || error instanceof DesktopSessionError) {
      const details = [error.code];
      if (error instanceof DesktopLoginError) {
        if (diagnosticStages.has(error.stage)) details.push(`stage:${error.stage}`);
        if (diagnosticReasons.has(error.reason)) details.push(`reason:${error.reason}`);
      }
      if (Number.isSafeInteger(error.providerCode)) details.push(`provider:${error.providerCode}`);
      throw new DesktopCliError(`${error.message} (${details.join('; ')})`);
    }
    throw new DesktopCliError('Desktop command failed. Check the session file and configured origins.');
  }
}
