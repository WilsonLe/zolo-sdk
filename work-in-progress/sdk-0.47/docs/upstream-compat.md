# Pinned adapter compatibility

SDK-created Web and Desktop APIs correct two `zca-js@2.2.0` sticker URL factories when their advertised `sticker` service has multiple hosts. The correction is internal; callers keep using `api.getStickers(keyword)` and `api.getStickersDetail(ids)` with the pinned input/result contracts. No package dependency or installed module is modified.

The pinned factories interpolate the entire array into a URL. For `["https://one.example","https://two.example"]`, JavaScript produces a comma-joined address whose parsed host is `one.example,https` and whose path starts `//two.example/`. Web requests therefore target a malformed host; Desktop's endpoint guard rejects it. The detail method catches each rejected operation through `Promise.allSettled`, so the visible result can be an empty list rather than an error.

`installUpstreamCompatibility` reconstructs just these two methods through one non-enumerable per-instance `API.custom` factory and captures the first advertised host. It runs after successful `PersonalZalo.loginWithQR`/`connect` and immediately after `connectDesktopSession` constructs its API. Resume paths use those same entry points. It preserves every service-map array and every unaffected method. Single-host instances retain their original methods. Repeated installation is a no-op. Raw APIs independently constructed outside these SDK entry points are not modified automatically.

| Supported cause-family leaf | Disposition |
| --- | --- |
| `getStickers` URL construction | Selects the first advertised host; preserves account-AES `{keyword,gif:1,guggy:0,imei}`, suggestion ordering and sticker-ID-only return. |
| `getStickersDetail` URL construction | Selects the same first host; preserves scalar/array handling, per-ID requests and fulfilled-only ordered results. A refused ID is omitted; an entirely failed batch still returns `[]`. |
| Web QR / explicit Web session | Both returned API paths install the per-instance correction. |
| Desktop approval/session / resume | Fresh Desktop API construction installs the correction; endpoint validation and connection lifetime remain owned by the session transport. |
| `getStickerCategoryDetail` | Excluded from correction: its pinned builder already selects `sticker[0]`. |
| Other service-array references | Bounded static search found exactly two interpolations without an index in the pinned JavaScript tree; unrelated factories are not rewritten. |

The helper uses the pinned request and response utilities, including `utils.resolve`. It preserves `ZaloApiError` validation behavior (`name:'ZcaApiError'`), messages such as `Missing keyword`/`Missing sticker id`, ordinary headers/cookies, encryption and normal request lifetime. It introduces no retry, host rotation, shared-array mutation, global URL rewriting, response schema replacement or stronger error-redaction promise for these upstream methods. The first host's failure is not permission to try another host.

Exact installed package evidence:

| `zca-js@2.2.0` artifact | SHA-256 | Evidence |
| --- | --- | --- |
| `dist/apis/getStickers.js` | `37ef74ad6c17053fbf1c76c8c91db2930f00cc1bde1472e7e0f52ccdd85f7095` | Line 4 whole-array interpolation; lines 13 onward argument validation, encrypted fields and sticker suggestion result projection. |
| `dist/apis/getStickersDetail.js` | `15b9716b09b30376e093320dd756523bc3a959295dddd01ada5661a605d4c059` | Line 4 whole-array interpolation; scalar/array normalization, all-settled order and individual account-response resolution. |
| `dist/apis/getStickerCategoryDetail.js` | `66148707d8656bdda390fabc21a2fb051d3004a04a3bf80001c085046649bef2` | Line 4 already uses the first host. |

Before the correction, all six retained regressions failed across both affected methods and the returned Web QR, Web connect and Desktop APIs: malformed host/endpoint rejection for suggestions and silently empty details. The same six synthetic bootstrap-and-operation cases now pass, preserving unknown detail fields, partial failures, scalar IDs, input errors, order and unmodified two-host maps. The existing thirteen Web client and thirteen Desktop session fixtures also pass after installing the hooks. No live sticker request, QR scan, phone approval, private account-file read or provider mutation was used for this compatibility verification.
