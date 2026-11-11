# Ordinary signed voice: connected forwarding caller and remaining carrier

8 November 2026. **A concrete computed Voice forwarding caller is now connected through upload and final-send projection.** This extends the previous literal-initializer search: MAIN recovery is not the only relevant caller. It does **not** establish the provider's signed-Voice completion contract. The exact unresolved edge remains HTTP provider ID versus local session ID, matching `voice_aac_success` emission, and cache/control order. No native bug, current eligibility, successful upload or delivery is claimed.

## Evidence and boundary

B=`/Users/wilsonle/.codex/visualizations/2026/11/05/01a1ab67-18aa-7c51-9627-12849903926c`. Only existing reports and exact cached text under `B/zalo-next-voice-source/pc-dist/lazy` were read/rehashed:

| Label/member | Bytes | SHA-256 |
| --- | ---: | --- |
| SHARED `default-login-main-startup-shared-worker-znotification.4bb5e1e2c2e9bab4f7b3.js` |17,605,735| `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e` |
| MAIN `main-startup.89bb530b91927fd5dd28.js` |2,692,557| `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121` |

Prior reports read in full: `zalo-sdk-next-voice-after044-survey.md`, SHA-256 `58859ae4285b66a02f68fab5f32c711cc91ca30fb643db3c0fd029d95463e84b`; `zalo-sdk-next-signed-voice-normalization.md`, SHA-256 `de3d682a9a3522af1ac8a4456d7ad6e6de50906858f66cc341c5a93e62d69fe7`. Their installed ASAR binding `9217d0e419c4f2b89033cf23e89073de0052d7417e6e16270afc2d68e31896d2` is reused, not freshly reread here. All anchors below are zero-based UTF-8 bytes in SHARED unless marked MAIN.

Only this report was written. No047 candidate files, source/tests/plans or declarations were read or changed. No target/SDK/Node/compiler/tests/harness/socket/app/native/WASM/stock/provider execution, network/account/profile access, new extraction or delegation. Root remains sole execution owner.

## Newly connected caller: ordinary cross-conversation voice forwarding

The `Eyfw` module at **4,462,213** imports `qWd+` as `f` and `UYGI` as `W`. Its exported controller admits MSG_VOICE in `checkIsSupportForward` **4,485,939** and constructs the forwarding session in `ce.forward` **4,484,075**. These are static conditional call paths, not observed user execution.

1. `qWd+.getMainUrlFromMessageV2` **14,804,349**, Voice case **14,804,728**, returns `{url:params.m4a||message.href,uploadType:Voice}`. Downloader `downloadMainFile` **4,468,533** uses that result and returns the same selected upload type with the acquired file at **4,470,696**. Voice therefore reaches upload through a computed value, without another literal Voice initializer.
2. `te.upload` **4,474,124/4,474,536** takes `{file,uploadType:d}`. At **4,476,432/4,476,510** it builds a fresh upload action, destination/group flag, `extData:{uploadMainType:d,fType:...,e2ee:i}`, `feature:SendMsg`, and invokes `W.b.uploadFile` **4,476,792**. For an ordinary target, `i=isOnE2ee(target)` is false. There is no pcloud flag/cloudInfo. The later URL enrichment is conditional on `i` being true.
3. The forwarding session **4,481,427/4,482,172** awaits download, upload, then `createContentForward` before `doForward`; no result is projected before upload settles. `qWd+` Voice projection **14,809,286** reads `fileAsync.fileUrl` as `voiceUrl`, ordinary `fileAsync.aacUrl` as `m4aUrl`, and `totalSize` as `fileSize`; it also records params `{m4a,fileSize}`. It does not manufacture missing URL values.
4. `getMsgTypeForwardFromMsgType` **14,803,704/14,803,932** selects MSGTYPE_FORWARD_VOICE. `doForward` **4,479,968** calls `dThN.apiForwardMessage` **12,090,473**. Its ordinary branch reaches `fBUP.forwardMessage` **12,460,076**. `transformForwardMessage` **12,458,543/12,459,850** copies the content and serializes it as `msgInfo` for the existing group/message forward route. No Voice-specific field rename after this projection repairs an absent primary URL.

The previously established MAIN recovery `_upload` **2,096,528** independently supplies explicit Voice/e2ee:false/SendMsg and consumes `aacUrl||fileUrl`; it returns a recoverable URL rather than sending chat. Both callers select the waiter path described below. Legacy `sendVoice` **12,463,906** instead uploads `fileContent` to voicemp3/sendmp3; that separate transport is not evidence of signed Voice completion.

## Conditional selection, ordinary options and negotiation

`QmhL` **7,590,976** preserves an explicitly supplied uploadMainType. Factory **3,504,595** selects MultiSite for the ordinary branch only if `ubQb` **15,864,544/15,864,919** allows socket chat, overall switch, file type, feature and the separate MyCloud gate. Defaults **3,712,561** disable MultiSite and omit Voice from allowed types; current overrides/eligibility were not read. The signed validator nevertheless admits Voice (**3,480,168**).

Voice mapping **3,480,832** selects CHAT_FILE_1_1=11 or CHAT_FILE_GROUP=12 (enum **3,478,143/3,478,181**). It does not select photo4/6 or video2, and does not special-case MyCloud. Builder **3,494,299**, common request projection **3,475,243**, emits fileSize/cliFileId/fileName/uploadFeature and destination1/2. Socket method **14,417,326** submits GET_MEDIA_UPLOAD_URL/800, subcommand0; request correlation is distinct from upload completion identity.

`Vy3F.uploadOptions` **9,956,261/9,956,536** creates security options only for e2ee==1 or pcloud==1. Both ordinary callers therefore get null. Header helper **3,938,891**, called at **3,495,279**, adds cloud headers only for cloudInfo&&secureOptions. Signed chunks **3,495,500 onward** use multipart `file`, first negotiated URL, full filesize/global offset and credentials. No missing cloud-only header/key is established for the ordinary Voice branch.

## Identifiers and exact completion chain

| Symbol | Producer and meaning |
| --- | --- |
| C | Caller upload action, e.g. fresh `z.a.next()` at4,476,432; negotiation cliFileId and chunk clientId. |
| S | Separate uploader session from `$.next()` at9,121,092; signed HTTP context `clientFileId:e` at3,495,994. |
| F | `raw.data.fileId` when truthy, otherwise String(S), chosen by Voice mapper3,490,019. This is not proven equal to C or S. |
| K | Waiter key `fileId||photoId` at7,411,099, hence F for Voice. Cache keys stringify values. |
| V | Final forwarding message action `this.newClientId`; distinct role from fresh resource upload C. No equality is inferred. |

HTTP mapper base **3,487,131** takes clientFileId from context S. `mapVoiceResponse` **3,490,019** spreads only that base and projects raw `amr||aac` to `fileUrl/url`, raw `aac` to `aacUrl`, F to `fileId`, optional secureKey and `finished:1`. It does **not** retain raw `amr/aac` keys. The finished marker alone does not prove nonempty URLs.

Terminal handling **3,496,922 onward** inserts the mapped Voice object in cache under S (**3,496,571**) before returning completion. Cache set/get **3,938,164/3,938,411** and underlying NzUN LRU **7,094,400-7,094,930** preserve the value schema. `getUploadResp` **3,500,031/3,500,234** selects F, and `getFileAsyncItem` **3,941,244** builds metadata with fileId=F, action C and destination, without copying URL fields. SendMsg invokes the waiter; it does not use the direct UploadPersist merge.

The Voice waiter **7,413,532/7,413,671** consumes an object with **amr/aac**, assigning fileUrl=amr||aac and alternate aacUrl only when amr is present. It immediately consults cache K (**7,414,250**). Thus the mapped object is not itself the expected completion object. Replays **3,502,160 onward/7,410,742** return a non-photo URL string when recognized; the Voice handler requires an object, so replay supplies no missing rename.

The actual alternate producer is incoming control dispatch: `voice_aac_success` **12,027,779** -> `_processVoiceAsyncDoneEvent` **12,023,519**, which converts numeric AMR5/AAC6 (constants **1,530,088**) to `{amr:data[5],aac:data[6]}` and calls `handleEventFromCtrl` **7,405,321** with control fileId. That handler caches/notifies under the control ID. This receiving adapter can satisfy a waiting Voice result; the HTTP mapper/terminal code does not synthesize that control.

## What order is established, and what is still missing

Established client order is mapped HTTP cache insertion -> result-selected F -> waiter lookup at F -> returned fileAsync -> final Voice projection. The control path can populate a cache entry before waiting or notify a pending handler. No provider order is established:

- If F differs from S, the HTTP insertion is not the immediate K hit; a control using F can supply the right schema. Whether signed feature11/12 emits it remains unknown.
- If F=S and the mapped HTTP object is consumed, its amr/aac keys are absent; the shown waiter can settle without a nonempty primary URL check. A matching control must replace that entry before lookup to change this case. A control arriving after settlement updates cache but cannot repair the already returned result because the handler was cleared.
- Control data cached before HTTP completion under that same key can be overwritten by the terminal mapped-object insertion. There is no proved server ID relationship or scheduling guarantee that excludes these cases. These are structural conditions, not an observed native failure.

All seven symbolic UploadPersist occurrences were rechecked. The direct mapped-data merge at **3,500,686** is real, but the concrete producers at **5,406,432** and photo helper **14,339,999 onward** are photo-oriented; MAIN has no symbolic UploadPersist occurrence. The newly connected forwarding path uses SendMsg. No concrete Voice+UploadPersist caller was established; computed/literal alternatives beyond this bounded search are not disproved.

The specific unresolved producer contract is: eligible ordinary signed Voice11/12 -> provider HTTP fileId F and/or self-contained raw amr/aac -> matching voice_aac_success(fileId=F,data[5/6]) -> arrival relative to the local cache/lookup above. These two cached client members establish the receiver and final projection, not provider emission, ID guarantees, remote feature overrides or usable remote bytes. The single named-control literal in SHARED is the incoming dispatch; MAIN has none. No further provider producer can be established within this source boundary.

## Minimal SDK design supported only as a narrower candidate

Source supports considering an explicit **qualified-terminal-only** signed Voice staging operation: fixed11/12 negotiation on caller-prepared ordinary bytes; sequential existing signed HTTP; require terminal0/-4 with nonempty, ordinary validated raw `amr||aac`; project primary voiceUrl and AMR's optional AAC alternate directly, with truthful provider/local fileId provenance and genuine existing Voice receipt ownership. Reject missing/malformed/encrypted results; do not turn ACK-only data into a ready receipt, invent a control, reuse UploadPersist as a claimed Voice producer, or silently retry/raw-fallback/send.

That design would deliberately consume self-contained terminal fields rather than emulate native cache timing. The mapper supplies its field vocabulary and the new forwarding caller supplies the final consumer semantics. **It would not close native SendMsg/control parity**, and this report does not declare that narrower contract accepted or implementation-ready. Current SDK ownership/error details would need a separate bounded design read. If complete native completion semantics are required, the provider edge above remains a blocker; another local rename cannot establish it.

No new probe or live authorization is requested.047 remains untouched; all-operations/native/provider readiness remains incomplete.
