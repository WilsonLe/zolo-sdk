import { homedir } from 'node:os';
import { join } from 'node:path';
import { connectDesktopSession, FileDesktopSessionStore, startManagedRealtime, ThreadType } from 'zalo-personal-sdk';

// Opt in only with an account and a direct conversation you use for testing.
const shutdown = new AbortController();
const ownedConnections = new Set();
let realtime;
const stop = () => {
  shutdown.abort();
  realtime?.stop();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  const threadId = process.env.ZALO_ECHO_THREAD_ID;
  if (typeof threadId !== 'string' || !/^[1-9]\d{0,39}$/.test(threadId)) {
    throw new Error('Choose an explicit positive decimal direct test-conversation ID.');
  }
  const path = process.env.ZALO_DESKTOP_SESSION_PATH
    ?? join(homedir(), '.config', 'zalo-personal-sdk', 'desktop-session.json');
  const store = new FileDesktopSessionStore(path);
  const record = await store.load();
  if (!record) throw new Error('Save an approved Desktop session before running this example.');
  shutdown.signal.throwIfAborted();

  realtime = startManagedRealtime(async signal => {
    const connection = await connectDesktopSession(record.credentials, {
      authOrigin: process.env.ZALO_DESKTOP_AUTH_ORIGIN ?? 'https://wpa.zaloapp.com', signal,
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', close);
      ownedConnections.delete(close);
      connection.close();
    };
    ownedConnections.add(close);
    // Managed startup's signal includes the attempt lifetime after authentication.
    // Desktop bootstrap alone detaches that signal, so the example owns this close.
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) {
      close(); // Also retire a bootstrap result that arrived after startup ended.
      signal.throwIfAborted();
    }
    return connection.api;
  }, {
    signal: shutdown.signal,
    startupTimeoutMs: 20_000,
    maxRetries: 3,
    initialRetryMs: 1000,
    maxRetryMs: 8000,
    stableAfterMs: 30_000,
    onConnection({ api, signal }) {
      const onMessage = message => {
        if (signal.aborted || message.type !== ThreadType.User || message.isSelf !== false || message.threadId !== threadId) return;
        const text = message.data.content;
        if (typeof text !== 'string' || !text.startsWith('!echo ') || text.length <= 6) return;
        void api.sendMessage(text.slice(6), threadId, ThreadType.User).catch(() => {
          if (!signal.aborted) console.error('Desktop echo reply failed; delivery is not confirmed.');
        });
      };
      api.listener.on('message', onMessage);
      const remove = () => api.listener.off('message', onMessage);
      signal.addEventListener('abort', remove, { once: true });
      if (signal.aborted) remove();
    },
    onStatus({ state }) {
      if (state === 'authenticated') console.log('Desktop echo connected; waiting for commands in the configured test chat.');
      if (state === 'retrying') console.log('Desktop echo reconnecting.');
    },
    onFrameError() { console.error('Desktop echo realtime error.'); },
  });
  const result = await realtime.closed;
  console.log(`Desktop echo ended (${result.reason}).`);
  if (result.reason !== 'stopped') process.exitCode = 1;
} catch {
  if (shutdown.signal.aborted) console.log('Desktop echo stopped.');
  else {
    console.error('Desktop echo could not start. Check the explicit test-chat ID, Desktop session and configuration.');
    process.exitCode = 1;
  }
} finally {
  realtime?.stop();
  for (const close of ownedConnections) close();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
