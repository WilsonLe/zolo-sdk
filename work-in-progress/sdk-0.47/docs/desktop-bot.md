# Desktop direct-chat echo example

[`examples/desktop-echo.mjs`](../examples/desktop-echo.mjs) resumes a saved Desktop session and listens through `startManagedRealtime`. It uses the normal account API to reply to one explicitly configured direct test conversation. It is a runnable starting point for an application; it is not an unattended login, credential-renewal or durable message-processing service.

## Set up and opt in

Use an account and a recipient/conversation you control or have agreed to use for testing. Starting the example opens a live Desktop socket; receiving a matching command causes a real message submission. It can displace an existing Desktop listener. Choose the target yourself and do not point the example at an unrelated contact or production inbox.

From this SDK workspace, install the package dependencies and build the SDK, then obtain an explicit Desktop approval if no session has been saved:

```sh
npm install
npm run build
npm run zalo -- desktop-login
```

Scan the private QR image and approve on your phone. The CLI saves a separate Desktop record at `~/.config/zalo-personal-sdk/desktop-session.json` by default. Existing Web cookie files are not interchangeable. A previously saved Desktop session can be checked explicitly with:

```sh
npm run zalo -- desktop-verify
# Optional: opens the listener briefly and may displace another Desktop client.
npm run zalo -- desktop-verify --realtime
```

Those CLI verification commands have their own documented cookie-save behavior. The echo example itself only loads the record: it never saves or clears it, rotates credentials, renews the session or logs out remotely. Keep one application responsible for any separate credential changes. [Desktop sign-in and storage](desktop-session-store.md) · [Connection ownership](desktop-session.md)

Run the example only when ready to send messages to your chosen test chat:

```sh
export ZALO_ECHO_THREAD_ID='REPLACE_WITH_YOUR_POSITIVE_DECIMAL_TEST_CHAT_ID'
node examples/desktop-echo.mjs
```

Replace the placeholder before running. The ID is mandatory, must be a positive decimal string of at most 40 digits, and cannot have a group prefix. The SDK helper's direct message `threadId` is the value to select from your application's authorized contact/conversation data; the example does not print or discover recipients for you. It uses `ZALO_DESKTOP_SESSION_PATH` and `ZALO_DESKTOP_AUTH_ORIGIN` with the same defaults as the Desktop CLI.

From the other test account, send `!echo hello` to the authenticated account. The example submits `hello` back only if all of these hold: `ThreadType.User`, explicitly incoming `isSelf:false`, exact configured `threadId`, string content beginning with `!echo `, and at least one following character. Self messages, other recipients, group messages, nontext content and other commands are ignored. Message bodies, user/conversation IDs, cookies, keys and provider error contents are not logged.

## Stop and reconnect behavior

Press Ctrl-C or send SIGTERM to stop locally. The example removes message listeners and closes every owned Desktop connection. Closing cancels that connection's outstanding HTTP work and clears its in-memory key/cookie state; it does not revoke the saved session or clear its file. A send cancelled after submission can already have reached the provider, so stopping does not prove that a pending reply was unsent.

The managed supervisor allows three consecutive retries after transient disconnects, with 1/2/4-second backoff and an 8-second delay ceiling. Each attempt has 20 seconds for bootstrap and the key frame. A connection lasting 30 seconds resets the consecutive-failure count. Displacement, provider kick, account change and incompatible listeners terminate the run instead of competing indefinitely. The ending message contains only the SDK's safe terminal reason; non-stop termination exits unsuccessfully. [Managed realtime semantics](realtime-recovery.md)

Each retry gets a fresh `connectDesktopSession` from the originally loaded credentials. The managed connect signal remains tied to that attempt's lifetime after authentication. The example explicitly binds its abort to `connection.close()` because Desktop bootstrap detaches its own caller signal after completion. An already-aborted signal closes a late bootstrap result before its API can be returned, including when `onConnection` was never reached. A final ownership cleanup closes any remaining connections. The per-feed signal independently removes the message handler before the next attempt.

No automatic offline queue recovery, durable deduplication, outbox, E2EE enrollment or error resubmission is included. Reconnects can miss or repeat provider events; the example does not promise exactly-once commands or verified delivery. An application that needs those guarantees must own its cursors, deduplication and submission reconciliation.

## What has been verified

On 6 November 2026, a separately approved ordinary Desktop QR session successfully bootstrapped, read its profile and received the initial socket key frame. The saved record had no verified companion identity. These checks establish ordinary Desktop authentication/HTTP access and the initial socket handshake; they do not establish live echo receipt, message delivery, automatic reconnect or trusted companion pairing.

This example was not run against that account or any live conversation during implementation. Syntax and a subprocess fixture with a synthetic public-package adapter cover recipient filters, bounded supervisor options, signal/attempt cleanup, late bootstrap ownership and fixed output without opening sockets or submitting real messages. The operator chooses whether and where to run the terminal example.
