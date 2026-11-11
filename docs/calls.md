# Call signaling

`sendCallSignal(api, operation, input, { signal })` sends one direct or group call control request using an authenticated SDK session. Its inputs describe the HTTP wire payload. A caller supplies the values normally produced by a compatible media engine, including codecs, transport addresses, session values, and extension data. The adapter returns the decrypted provider payload, or `undefined` for an acknowledgment with no data. The SDK's fixtures exercise the transport and control parser offline. Call placement, acceptance, media negotiation, and playback still require an authenticated integration and a media engine.

## HTTP transport

Both the installed renderer and the public Web startup chunk contain the 28 request builders below. Each sends a GET to the session's `voice_call` service with `zpw_ver`, `zpw_type`, and AES encrypted JSON `params` as query fields. The renderer checks the outer `error_code`, decrypts its `data`, checks the inner `error_code`, and returns inner `data`. If the outer result is successful and empty, the renderer resolves without data. The SDK selects the origin from the login service map. A session that does not advertise `voice_call` returns `unsupported-service`. [Installed app identity](desktop-evidence.md) · [Matching Web build](desktop-gaps.md#matching-public-web-build)

All paths below start with `/api/voicecall/`. Command IDs identify entries in the desktop HTTP command table. The right column shows special wire behavior. Optional input properties omitted by the media engine are omitted from JSON.

| SDK operation | Path suffix | HTTP command ID | Wire notes |
| --- | --- | ---: | --- |
| `reserve` | `requestcall` | 11300 | `calleeId`, `callId`, `typeRequest`, `codec` with fallback `"[]"`, and session `imei`. |
| `request` | `request` | 11301 | `calleeId`, `rtcpAddress`, `rtpAddress`, `codec`, `session`, `callId`, and session `imei`. |
| `ring` | `ringring` | 11302 | `callerId`, `callId`, `status: 0`, and session `imei`. |
| `answer` | `answer` | 11303 | `callerId`, `callId`, `status`, `codec` with fallback `""`, `rtcpAddress`, `rtpAddress`, and `session_id`. |
| `acknowledge` | `answerack` | 11304 | `calleeId`, `callId`, `status: 0`, and session `imei`. |
| `cancel` | `cancel` | 11305 | `callerId`, `callId`, `callType`, `status: 0`, and session `imei`. |
| `end` | `endcall` | 11306 | `uidTo`, `callId`, `status: 3`, and session `imei`. |
| `holdRequest` | `holdreq` | 11307 | `toId`. |
| `holdResponse` | `holdresp` | 11308 | `toId`. |
| `unholdRequest` | `unholdreq` | 11309 | `toId`. |
| `unholdResponse` | `unholdresp` | 11310 | `toId`. |
| `logEnd` | `logendcall` | 11311 | `call_id`, `partner_id`, `status`, `logdata`, `duration`, `role`, and session `imei`. |
| `setCameraMicrophone` | `conf` | 12006 | `calleeId`, `callId`, `isOnCam`, `isOnMic`, and `data`. |
| `setScreenShare` | `requestsharescreen` | 12064 | `uidTo`, `callId`, and `status`. |
| `reserveGroup` | `group/requestcall` | 12433 | `groupId`, `callId`, `typeRequest`, `data`, and `partners`. |
| `requestGroup` | `group/request` | 12434 | `calleeId`, `callId`, `callType`, `data`, `session`, `partners`, and `groupId`. |
| `addGroupParticipants` | `group/adduser` | 12435 | `calleeId`, `callId`, `callType`, `hostCall`, `data`, `session`, and `partners`. |
| `answerGroup` | `group/answer` | 12436 | `calleeId`, `callId`, `callType`, `hostCall`, `data`, and `partners`. |
| `cancelGroup` | `group/cancel` | 12437 | Same outer fields as `answerGroup`. |
| `endGroup` | `group/endcall` | 12438 | Same outer fields as `answerGroup`. |
| `ringGroup` | `group/ringring` | 12439 | Same outer fields as `answerGroup`. |
| `getGroupState` | `group/state` | 12445 | `callId`, `hostCall`, and `callType`. |
| `finishGroup` | `group/finish` | 12446 | `callId`, `callType`, `data`, `duration`, `hostCall`, `partners`, `status`, and `joinTime`. |
| `notifyGroup` | `group/notify` | 12447 | `callId`, `hostCall`, `callType`, `status`, and `data`. |
| `pingGroup` | `group/ping` | 12097 | `callId`, `hostCall`, `userId`, `callstate`, `audiostate`, `videostate`, and `params`. |
| `broadcastGroup` | `group/broadcast` | 12098 | Same outer fields as `pingGroup`. |
| `joinGroup` | `group/join` | 12043 | `userId`, `callId`, `hostCall`, `status`, `srcJoinCall`, `audiostate`, `videostate`, and `data`. |
| `setGroupScreenShare` | `group/sharescreen` | 12044 | `userId`, `callId`, `hostCall`, `status`, `audiostate`, `videostate`, and `data`. |

Direct `request` and `answer` add `extendData` and `subCommand: 3` when the native engine supplies a nonempty extension. The renderer passes account-scoped contact IDs as strings in the direct call UI. The native `ZCallUserInfo` reads `partner.id` into the same string field returned by `getNoisedUserId()`. For group add-participant UI, a separate `GET /api/znoise` on the profile service accepts `{fids,gids}` with call participant IDs. The renderer consumes the returned `fids` and the first `gids` entry to locate the corresponding existing conversation. The `requestaudio2video` path appears in the command map as 12056. Its request builder and payload are unresolved in the inspected bundles.

Desktop shared chunk offsets are 2,694,812–2,695,897 for the command map, 7,262,750–7,266,150 for the native IPC dispatch, 12,085,581–12,089,236 for the response facade, 12,469,546–12,477,837 for the builders, and 13,736,118 for the common response handler. Matching Web locations are 11,266,950 for the response facade, 11,640,844–11,648,828 for the builders, and 12,802,777 for the common response handler. Byte offsets refer to the unmodified files identified in the evidence notes. [Desktop build](desktop-evidence.md) · [Web build](desktop-gaps.md#matching-public-web-build)

## Inbound controls

The installed renderer shares one WebSocket instance between its chat and control handlers. The WebSocket origin comes from `zpw_ws`. `zpw_ctrs_new` contains the separate HTTP control long-poll fallback when the control socket path is disabled or swapped out. Both paths feed the same control reducer. It dispatches each `controls[i].content` with `act_type: 'voip'` and parses its `data` if it is a JSON object or array string. The native process handles events such as `request`, `ring_ring`, `answer`, `answer_ack`, `cancel`, `end_call`, `group_request`, `group_answer`, and `group_broadcast`.

The socket control router accepts command `601` for live push and `603` for queue pulls. The desktop decoder reads a four-byte header and routes these commands without an explicit version or subcommand filter. Its queue configuration references `603_0` and `603_1`, with `603_0` in the default control queue list. The authentication frame supplies negotiated `ctrl_qCmds` for offline pulls. The pinned `zca-js` listener recognizes version 1, command 601, subcommand 0, then handles selected control types and drops `voip`. `604` is named `CTRL_PULL_VOIP` and appears in queue configuration. Its event consumer was not established. [Pinned listener](https://github.com/RFS-ADRENO/zca-js/blob/dadfef18bcac53537741855c99f084152da1fad9/src/apis/listen.ts)

`extractCallControls` accepts the already decrypted `data` object containing the `controls` array and returns `{act,data}` pairs. It isolates malformed individual JSON strings and preserves large numeric identifiers while parsing nested JSON. The installed renderer also drops call controls older than 60 seconds and consults user notification preferences. Those are renderer policy choices outside the parser.

Start `startRealtimeFrameFeed(api, { commands: [601, 603], onFrame })` in place of calling `api.listener.start()` directly. The feed uses the same socket and continues to deliver the usual listener events. Inside `onFrame`, read the decoded frame's `payload.data` and pass it to `extractCallControls`. Call `feed.stop()` and await `feed.closed` before starting again. The feed uses the socket interface of the pinned `zca-js` version and has local WebSocket coverage for all four observed transport modes.

Desktop shared chunk offsets are 1,206,588 and 1,212,915 for frame parsing, 3,002,300 for control command dispatch, 3,008,910–3,011,200 for the shared socket and handler selection, 6,949,962 for queue configuration, 7,612,170 for the command constants, 12,001,964 for registration of the control callback, 12,027,852 for the `voip` dispatch, and 12,468,335 and 12,468,780 for the WebSocket and control long-poll URL builders. The Web shared startup chunk contains the same routing at 2,855,124 and `voip` dispatch at 11,209,365. These are static code paths. Delivery of real call events to a personal SDK session still needs an account test.

## Native media boundary

The main process starts the installed `/Applications/Zalo.app/Contents/ZaloHelper.app/Contents/MacOS/ZaloCall` executable. The signed app ships this universal Qt helper for arm64 and x86_64. Its SHA-256 is `ad1c7b44ab149c9f7697e19c5484072f6facb6edcec4ef9b1cf580ddf80e6101`. Electron sends typed messages such as `recvSignal` and `control` over a local socket bridge, and the native helper sends `sendSignal` commands back for the renderer to submit over HTTP. The desktop helper also contains WebRTC, ZRTP and SRTP code. The ASAR has a separate `zcall_mac.node` addon and JavaScript wrapper for configuring audio, video, RTP/RTCP endpoints, and a media session. The main process launch path traced here uses the Qt helper. MAIN offsets 315,250–320,700 and native arm64 symbols below identify the boundary.

| Native arm64 address | Observed behavior |
| --- | --- |
| `0x10001a270` | `ZMessageDeserializer::parseMessage` dispatches `recvSignal`, `control`, and other IPC message types. |
| `0x10001abb0` | `_parseControl` branches on the call action string. |
| `0x10001d698` | `_parse401Response` consumes `fromId`, `toId`, `id`, `ts`, `protocol`, `status`, `sessId`, `msg`, `zrtc_config`, and `servers`. |
| `0x10001f3cc` | `_parseRequestCallResponseGroup` reads `hostCall` and `params`. Its detail helper at `0x10001f9b4` consumes `callSetting`, `session`, `groupId`, `callId`, `status`, `msg`, and other group fields. |
| `0x1000c0fac` | `_trySendRequestCallSignal` fetches the noised contact ID and the media engine's active codecs, then sends the reservation signal. |
| `0x1000cb98c` | `_prepareCallConfig` is the native configuration consumer after the direct reservation response. |
| `0x1000f6d50` | `ZCallUserInfo` reads the string `id` separately from the integer `userId`. The getter at `0x1000f6f60` reads the stored `id` string. |

The adapter exposes the signaling layer so an existing compatible media engine can supply and consume those values. Completing calls requires reconstructing or integrating the negotiated media transport, lifecycle, and capture/playback path and testing it with a controlled peer.
