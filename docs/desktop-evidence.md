# Zalo desktop evidence

The installed macOS app is Zalo **26.11.10**, build **26.11.10.3400**, bundle ID `com.vng.zalo`. Its signed Electron bundle is at `/Applications/Zalo.app`. The application archive at `Contents/Resources/app.asar` is 183,869,581 bytes with SHA-256 `9217d0e419c4f2b89033cf23e89073de0052d7417e6e16270afc2d68e31896d2`. The findings below come from the shipped files. They establish static code paths and protocol candidates. Server behavior and authenticated account results require separate tests.

| ID | Archive member | SHA-256 |
| --- | --- | --- |
| MAIN | `main-dist/main.js` | `328f2d2c12101b965a738559f6e7c3e48d2e1fd0e956bef4e44fde84e2019c43` |
| LOGIN | `pc-dist/lazy/login-startup.65eb8d358ddd85ba3f21.js` | `0929a20e9181fbed984ed70aaa51c9aa55b3936eeffe10a30623f34e08080b1e` |
| SHARED | `pc-dist/lazy/default-login-main-startup-shared-worker-znotification.4bb5e1e2c2e9bab4f7b3.js` | `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` |

The hashes of these three members match their ASAR integrity entries. macOS `codesign --verify --strict` also passed for the app. REA reported 52 hash discrepancies in unpacked native companions, consistent with a packaging or signing change after the archive manifest was produced. The origin of those differences remains unverified. The protocol findings use packed JavaScript members.

## Login and session setup

- The Electron main process loads the bundled login page. The renderer's QR flow calls `GET /api/login/reqqr` with command ID `11133`. Inputs include language, client time, the client identifier, computer name, and QR mode. The auth helper adds client type, version, and a signature. It conditionally encrypts request parameters according to server configuration. The compiled auth host is derived from the configurable domain suffix, with `https://wpa.zaloapp.com` as the fallback. MAIN at byte 2,831,920 and SHARED at bytes 6,981,290–6,983,300 and 12,404,540–12,410,260.
- The response supplies separate URLs for waiting for scan and approval, plus timeout and retry values. The UI handles expiry, rate limits, a server-triggered second QR, and optional trusted-device verification. On approval it receives session data, and the Electron main process installs the session cookie as Secure and HttpOnly. LOGIN at bytes 48,300–48,800 and 54,200–59,300, and MAIN at byte 390,023.
- The app has separate `/api/login/getServerInfo` and `/api/login/getLoginInfo` calls. Login information updates chat and control endpoints and the per-feature service map. Compiled fallbacks use client type `30` (`31` in the embedded build) and version `695`. The desktop app can replace these values with server configuration. SHARED at bytes 6,981,480–6,984,050, 7,004,400–7,004,850, 11,902,770–11,903,175, and 12,412,450–12,414,640.

The pinned [zca-js 2.2.0](https://www.npmjs.com/package/zca-js/v/2.2.0) adapter follows Zalo Web's separate `id.zalo.me/account/authen/qr/` flow, then uses the shared login-info API. Its default web protocol version is `685`. Those defaults and the web QR flow come from the pinned package. The desktop values above characterize the installed app. [Upstream source](https://github.com/RFS-ADRENO/zca-js).

## Messaging and other operations

| Operation | Shipped desktop evidence | Member byte offsets |
| --- | --- | --- |
| Send plain text to a user | `POST /api/message/sms`, command `11151`. The form field `params` holds the encrypted JSON payload with `message`, `clientId`, `imei`, and `toid`. | SHARED 12,452,429–12,452,968 |
| Send plain text to a group | `POST /api/group/sendmsg`, command `11163`. The payload uses `grid` and includes visibility. The endpoint is selected from the active group service. | SHARED 12,452,429–12,452,968 |
| Receive live updates | The client opens a WebSocket with binary frames and registers open, message, error, and close handlers. Chat and control endpoint lists come from login and configuration. | SHARED 1,214,000–1,214,580 and 11,902,770–11,903,175 |
| Receipts, media and forwarding | Route entries include `/api/message/deliveredv2`, `/api/message/seenv2`, `/api/message/forward`, and distinct group and direct routes for uploads. | SHARED 2,675,060–2,682,138 |
| Friends and groups | The command map covers friend profile lookup, friend requests, group listing, membership, roles, invites, and group settings. | SHARED 2,682,234–2,687,627 |
| Polls, pinned items, labels and catalogs | The bundle has separate board, poll, conversation label, and product catalog routes. | SHARED 2,687,724–2,689,231 and 2,697,911 |

The selected shared chunk has **454 distinct quoted `/api/…` strings**. Scanning the installed `zca-js@2.2.0` package's `dist/apis/*.js` produces **166 distinct `/api/…` strings**, of which **161** occur verbatim in the desktop chunk. Those matches span 148 upstream modules. Four unmatched strings are base paths assembled into complete paths at runtime by `sendMessage`. The other is `/api/devices/linked`. A literal match establishes path spelling only. Method, payload, permission, runtime availability, and desktop parity need their own evidence.

The [route inventory](desktop-route-inventory.tsv) lists each of the 454 candidates with its first byte offset, occurrence count, and upstream modules with a matching literal. Regenerate it with `python3 scripts/desktop-route-inventory.py`. An empty upstream column only means the literal scan found no exact match. [Traced coverage gaps](desktop-gaps.md) identify which selected candidates have enough static evidence for implementation.

The desktop archive also ships `pc-dist/libs/libsignal-protocol.static.js`, WebAssembly modules for Zalo protocol, backup, and trusted devices, and a native calling module. The shared chunk contains distinct E2EE, voice calling, backup, and mobile message sync routes. The web adapter's exposed operations therefore cover a subset of the desktop app. The SDK has separate source/fixture implementations for these families; live E2EE/device enrollment, authenticated calls and full historical synchronization remain unverified. Ordinary Desktop QR approval, bootstrap, profile reads and the initial realtime key frame have passed a phone-approved live test. [Current verification](authentication.md#current-verification)

## Reproduce the evidence

REA 6.5.0 produced the partial graph `ev_04b6d06a627ec518148167f734acfa79235e328cce3e705991f78243436dbd07` for eight selected archive members. The default macOS SDK failed to compile REA's helper with the installed Swift compiler. Selecting the installed macOS 26.5 SDK for the CLI process resolved that issue. The default REA worker heap limited analysis of MAIN and SHARED. A focused larger-heap pass retained partial evidence `ev_da56795f0b2de54f2695eadf01aa4194354c4ae8cf0a0448b0e06b06566e53b6` at the time limit. The offsets and protocol findings above come from direct inspection of the integrity-checked archive bytes.

Run the following from the SDK root after `npm ci` to verify the shared chunk hash and route overlap. It reads the installed app and pinned dependency in place.

```sh
python3 - <<'PY'
import hashlib
import json
from pathlib import Path
import re
import struct

archive_path = "/Applications/Zalo.app/Contents/Resources/app.asar"
member = (
    "pc-dist/lazy/"
    "default-login-main-startup-shared-worker-znotification."
    "4bb5e1e2c2e9bab4f7b3.js"
)
with open(archive_path, "rb") as archive:
    _, header_size, _, json_size = struct.unpack("<4I", archive.read(16))
    entry = json.loads(archive.read(json_size))
    for part in member.split("/"):
        entry = entry["files"][part]
    archive.seek(8 + header_size + int(entry["offset"]))
    source = archive.read(entry["size"])

digest = hashlib.sha256(source).hexdigest()
assert digest == entry["integrity"]["hash"]
print("Shared chunk SHA-256", digest)
desktop = set(re.findall(rb'["`\x27](/api/[A-Za-z0-9/_-]+)["`\x27]', source))
modules = Path("node_modules/zca-js/dist/apis").glob("*.js")
upstream_by_module = {
    path.name: set(re.findall(rb"(/api/[A-Za-z0-9/_-]+)", path.read_bytes()))
    for path in modules
}
upstream = set().union(*upstream_by_module.values())
print("Desktop routes", len(desktop))
print("Upstream routes", len(upstream))
print("Overlapping routes", len(desktop & upstream))
print("Upstream modules with a match", sum(
    bool(routes & desktop) for routes in upstream_by_module.values()
))
PY
```
