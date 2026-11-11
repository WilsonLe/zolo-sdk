# Native call bridge

`startNativeCallBridge()` starts the macOS Qt call helper from the inspected Zalo installation and waits for `update/native-ready`. The SDK verifies the paired desktop JavaScript and helper build, reads the local transport material directly from the installed ASAR, and starts the helper with two private Unix sockets. The bridge has no account dependency. Call `bridge.send(message)` to wait for the socket acknowledgment, or `bridge.request(command, data)` to wait for a typed application response to `makeCall` or `hide`. Use `onMessage` to receive events and await `bridge.close()` when finished. Tests can supply an external compatible executable and its transport key through the `source` option.

`startNativeCallController(api, options)` connects that helper to an authenticated SDK session. The caller provides the native `init` object and a `shouldForwardControl` callback. The controller starts one SDK realtime feed, forwards approved `voip` controls, routes native `sendSignal` commands through `sendCallSignal`, and replies to the helper with the original native command ID. It exposes `ready` for WebSocket key negotiation and `send` for explicit local actions. Use the controller in place of starting `api.listener` yourself. The normal listener still receives chat events. An app that already uses `startRealtimeFrameFeed` can pass the same session's feed through `options.feed`. The controller subscribes to commands 601 and 603. Closing the controller detaches its subscription and leaves that feed open. [Call signaling](calls.md)

```ts
import { startNativeCallController } from 'zalo-personal-sdk';

const controller = await startNativeCallController(api, {
  init: appSuppliedNativeSettings,
  shouldForwardControl: (control) => appAllowsCallControl(control),
  onNativeMessage: (message) => handleNativeCallEvent(message),
  onError: (error) => handleCallError(error.code),
});

try {
  if (await controller.ready) {
    const result = await controller.makeCall(selectedCall);
    if (result.error !== 0) handleNativeRejection(result);
  }
  // Keep the controller open for call events and close it when the app ends the session.
  await appSessionEnded;
} finally {
  await controller.close();
}
```

## Data supplied by the app

The shipped renderer initializes the native helper with `type: 'update'`, `command: 'init'`, and a `data` object. The inspected renderer and arm64 helper consume these settings. Native defaults and the required values for successful media negotiation still need controlled account tests.

| Fields | Observed use |
| --- | --- |
| `local`, `mainWindowId` | The renderer passes the current account ID as `mainWindowId` and in `local.id`, plus `local.name` and `local.avatar`. The native user parser reads string `id` and separately checks integer `userId`. |
| `clientVersion`, `osInfo`, `language` | Client version and platform/language information supplied by the renderer. |
| `logPath`, `zrtcLogPath`, `dumpPath` | App-selected paths for native logs and a dump. `zrtcLogPath` is an existing directory. The installed helper appends `/voip.log` and `/zalocall_config.ini` to it. Provide paths inside a directory owned by your app. |
| `timeoutMakeCall2ZRtp`, `timeoutHandshake`, `renderType` | The native parser reads these fields. The renderer's traced initializer sets `timeoutMakeCall2ZRtp` from desktop config. |
| `enablePreviewDeviceOutgoing`, `enablePreviewDeviceIncall`, `enableUnstableConnecting` | The renderer passes configured preview and connection behavior flags. |
| `autoAudioInput`, `autoAudioOutput`, `defaultAudInputDevice`, `defaultAudOutputDevice`, `defaultVidDevice` | The renderer passes its default-device policy. The native device parser also reads `otherAudInputDevice`, `otherAudOutputDevice`, and `otherVidDevice` and looks up device objects by `id` and `name`. |

The desktop `makeCall` request sends `data.partner` as an array of `{id, name, avatar}` entries using IDs from its contact list, `data.type` as `1` for direct audio, `3` for direct video, `5` for group audio, or `6` for group video, and optional `data.isFirstCall`. The group path includes `data.groupInfo`. Its native parser reads group `id`, `name`, `avatar`, and `maxUsers`. The native engine subsequently generates the HTTP signaling payload, including its own codec and RTP/RTCP negotiation values.

The helper distinguishes its socket acknowledgment from its local response. `makeCall` answers as `response/show`, while `hide` answers as `response/hide`. Both return an integer `error` and a string `extendData`. `controller.endCall()` waits for the socket acknowledgment. The helper emits `response/endCall` with null data if a call is active and omits that response when idle. A local success confirms the helper accepted the command. The eventual call status comes from native events and signaling. HTTP failures surface through the controller's `onError`, separately from the local response.

Only one typed request per response name can be pending. Native replies lack a correlation ID, so a timed-out or cancelled response name stays reserved until its late reply arrives or the bridge closes. Cancellation stops the SDK's wait and leaves a dispatched native action to the helper. Prefer the typed helpers if your app needs to distinguish a local native response from a socket acknowledgment.

The native helper can emit application requests as well as `sendSignal`. The controller passes those through `onNativeMessage`. For example, the desktop answers a `request/serverTime` message with `{type: 'response', command: 'serverTime', data: {timestamp}}` and looks up the contact name for `getAliasName`. Device selection UI, audio and video permission prompts, contact picker, popup, and log upload behavior belong to the caller. The controller does not run those actions automatically.

## Protocol evidence

The installed helper is the universal executable at `/Applications/Zalo.app/Contents/ZaloHelper.app/Contents/MacOS/ZaloCall`. Its SHA-256 is `ad1c7b44ab149c9f7697e19c5484072f6facb6edcec4ef9b1cf580ddf80e6101`. The corresponding integrity-checked `main-dist/main.js` SHA-256 is `328f2d2c12101b965a738559f6e7c3e48d2e1fd0e956bef4e44fde84e2019c43`. [Desktop artifact identity](desktop-evidence.md)

| Evidence | Observed behavior |
| --- | --- |
| `MAIN` bytes 315,250–322,028 | The host binds two sockets and calls `spawn(executable, [helperToHostPath, hostToHelperPath])`. The helper connects to both as a client. The host sends `recvSignal`, `control`, `request`, and `update`; helper events are `update`, `sendSignal`, `request`, and `response`. |
| `MAIN` byte 356,690 | The host writes a single `HEX$` frame for ciphertext of at most 4,000 hex characters. Longer values are `HEX#messageId#count#index#$`, with zero-based indices. Host writes one frame and waits for an acknowledgment before the next. |
| `MAIN` bytes 3872110–3872580 and 423,572 | Both directions carry UTF-8 JSON encrypted with AES-128-CBC, a zero IV, and PKCS#7 padding. Ciphertext is hex. The key is fixed for the inspected local IPC protocol and stored in the shipped desktop bundle. |
| Qt arm64 `0x10012dbac` and `0x10012f4a8` | Native `main` accepts two socket arguments. The receive path reads bytes from the second socket and writes the three bytes `ack` after passing the payload to the message parser. |
| Qt arm64 `0x10002e29c` and `0x10002e640` | The native transport splits on `$`, reassembles indexed chunks, decrypts, then parses JSON. Startup emits an encrypted `{type: 'update', command: 'native-ready'}`. |
| Qt arm64 `0x1000ceec4`, `0x100028dac`, `0x100028f44`, `0x1000cedac`, `0x10002912c` | The init consumer assigns the native log directory. The serializers produce `hide`, `show`, and `endCall` application responses. The `endCall` handler skips serialization when idle. Its serializer assigns the JSON null singleton and ignores its integer parameter. |
| `SHARED` bytes 7,262,750–7,268,950 | The renderer dispatches the 28 native numeric `sendSignal` commands to HTTP operations and replies as `{type:'recvSignal', command, data}`. A successful response with no data omits the JSON `data` field. Inbound call control is `{type:'control', data:{act_type:'voip', act, data}}`. For incoming `request` and `group_request`, the renderer supplies `inCallStatus` as `'zalo'` or `null`. |
| `SHARED` bytes 7,261,500–7,262,250 and 7,271,106–7,271,991 | Renderer init assembly and the `makeCall` request builder. The native `ZInitInfo`, `ZCallDevice`, `ZMakeCallInfo`, and `ZGroupInfo` JSON constructors confirm the field names. |

The SDK restricts installed-helper mode to the inspected build pair. It reads the one IPC transport value at startup and keeps it in memory. It uses an owner-only temporary directory and process-local sockets rather than the desktop's fixed socket names. The `external` source mode is intended for an explicitly supplied compatible process and transport key. `createNativeCallCodec` exposes the framing for other integrations. The protocol's cipher is part of Zalo's compatibility format. Socket directory permissions are the isolation boundary.

## Verification boundary

The installed helper reached `native-ready` in a local probe on 5 November 2026. A follow-up under the same isolation sent synthetic initialization, observed the helper create `voip.log` in the selected temporary directory, and decrypted the local `response/hide` with `error: 0` and empty `extendData`. An idle `endCall` probe received the socket acknowledgment with no subsequent application response. The probes allowed only the private Unix sockets and temporary directory writes, denied home-directory reads, and denied microphone and camera access. The init probes also blocked TCC and per-user preferences daemon lookups. The probes used no account session and placed no call. They terminated only their own helper process.

Offline tests cover byte-fragmented frames, multipart payloads, socket acknowledgment ordering, startup and write timeouts, and process/socket cleanup. The controller fixture exercises a native `makeCall` request, the command-401 reservation HTTP envelope, the decrypted `recvSignal` response, and filtered `voip` controls on one local WebSocket. It also checks that an injected feed continues delivering events after the controller closes. A live authenticated session and a controlled second account are needed to verify actual ringing, answer, audio, video, and hangup.
