import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileSessionStore, PersonalZalo, startManagedRealtime, ThreadType } from 'zalo-personal-sdk';

// Run only with an account and a direct conversation you use for testing.
const threadId = process.env.ZALO_ECHO_THREAD_ID;
if (typeof threadId !== 'string' || !/^[1-9]\d{0,39}$/.test(threadId)) {
  throw new Error('Set ZALO_ECHO_THREAD_ID to a positive decimal direct test-conversation ID.');
}

const path = process.env.ZALO_SESSION_PATH ?? join(homedir(), '.config', 'zalo-personal-sdk', 'session.json');
const client = new PersonalZalo({ store: new FileSessionStore(path) });
const realtime = startManagedRealtime((signal) => client.resume(signal), {
  onConnection({ api, signal }) {
    const onMessage = (message) => {
      if (signal.aborted || message.type !== ThreadType.User || message.isSelf !== false || message.threadId !== threadId) return;
      const text = message.data.content;
      if (typeof text !== 'string' || !text.startsWith('!echo ') || text.length <= 6) return;
      void api.sendMessage(text.slice(6), threadId, ThreadType.User).catch(() => console.error('Zalo reply failed.'));
    };
    api.listener.on('message', onMessage);
    signal.addEventListener('abort', () => api.listener.off('message', onMessage), { once: true });
  },
  onStatus({ state }) {
    if (state === 'authenticated') console.log('Listening for !echo in the configured direct conversation.');
  },
  onFrameError() { console.error('Zalo realtime error.'); },
});

process.once('SIGINT', realtime.stop);
process.once('SIGTERM', realtime.stop);
const result = await realtime.closed;
console.log(`Zalo realtime ended (${result.reason}).`);
