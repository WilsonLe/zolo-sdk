# Mobile sync v2 control

`attachMobileSyncControl(feed, input, options?)` adds a phone sync tracker to a caller-owned realtime feed. Calling `request()` explicitly sends a request to the linked phone. Pass the receiver identity and fresh ephemeral public keys as Base64. Keep their private keys for opening the matching transfer metadata. The SDK generates a fresh sync ID and correlates replies and pushes for that request. [Snapshot decryption](mobile-snapshot.md)

```ts
import { attachMobileSyncControl, startRealtimeFrameFeed } from 'zalo-personal-sdk';

const feed = startRealtimeFrameFeed(api, { signal });
const sync = attachMobileSyncControl(feed, existingSyncInputs, { signal });

if (await feed.ready) {
  sync.request();
}
// Read sync.progress() or subscribe through the onEvent option.
// Close this tracker when done. The caller still owns the feed.
```

The tracker reports the request acknowledgment, mobile status, batch indexes and errors, and disposal acknowledgment. `batches-received` means every announced batch index arrived. It can include failed batches and says nothing about file download, decryption, or import. Use `dispose(reason)` explicitly when appropriate. Desktop reason values are 0 for user cancel, 1 for sync success, 2 for error, and 3 for outdated. Calling `close()` or aborting detaches the tracker locally. It leaves the remote session and shared feed to their owners. Apply deadlines in the calling application.

An `onEvent` callback receives batch metadata, which may include a sensitive file URL. Preserve the original batch event for `downloadMobileSyncSnapshotBatch` or `createMobileSyncSnapshotReader`. These accept batches from an approved transfer and require configured file origins. `splitMobileSyncBatchFile(bytes)` can split a separately obtained batch into ciphertext views. [Snapshot retrieval and decoding](mobile-snapshot.md) · [Desktop SQLite history reader](history-archive.md)

## Wire evidence

The source is the installed **26.11.10** archive. SHARED is the member identified in the desktop evidence. WORKER is `pc-dist/shared-worker.cfeba43a9a8e4e40dda3.js`, SHA-256 `6304c3fece19686a4a65d46044eca49a6df5fc1f8b4b65064ca5e728ef1aaf53`. RENDERER is `pc-dist/lazy/main-startup.89bb530b91927fd5dd28.js`. [Desktop evidence](desktop-evidence.md) · [Renderer identity](direct-history.md)

| Part | Shipped behavior |
| --- | --- |
| Request | Version 1 WebSocket command `590`, subcommand 0, sends `{reqId,data}`. Inner `data` holds `syncId,syncType,ek,ik,toDevice,tempKey,deviceName,req,ver,ussidx`. Full sync uses `syncType:0`, mobile `toDevice:0`, and `ver:1`. The request uses one database and priority with `{type,priority,queries,batchSize}` and query `{partition,from,to,limit}`. The per-user sync index starts at zero. SHARED 7,612,356 and 14,415,980–14,417,620, WORKER 276,824 and 284,300–285,275. |
| Acknowledgment and disposal | Commands `590` and `591` are registered as API replies on subcommand 0. The dispatcher resolves using decoded `data.reqId` and processes `error_code`. Disposal sends `{reqId,data:{syncId,toDevice,reason}}`. SHARED 7,613,793–7,614,300 and 14,413,850–14,417,840, WORKER 280,900–281,450. |
| Control events | Commands `601` and `603` carry decoded `data.controls[]`. Each record's `content` has `act_type`, `act`, and `data`. The renderer uses `transfer_sync2` actions `transfer_status`, `upload_batch`, and `transfer_error`. The app parses JSON strings inside control data when needed. SHARED 3,002,403–3,003,580 and 12,027,012–12,029,460, RENDERER 2,534,711–2,539,420. |
| Phone status and batch ordering | Phone statuses 1 through 10 are active, idle, waiting for confirmation, confirmed, bypass confirmed, rejected, cancelled, busy, low storage, and logged out. The tracker scopes status and batch events by `syncId`. The desktop deduplicates `idx` and completes receipt when all batch indices from zero through the `isLast` batch are present. Batch type 1 is messages and 2 is embedded metadata. SHARED 7,402,049 and 7,905,477–7,906,520, WORKER 286,190–287,580. |
| Snapshot file | The downloader reads repeated four-byte unsigned little-endian lengths followed by one ciphertext block of the specified length. The metadata block uses the receiver identity and ephemeral private keys to establish the session record. Message blocks then decrypt against that record. The app decompresses the plaintext with Zstandard and parses a SyncChunk protobuf. WORKER 246,911–248,690, 282,880–283,720, 305,560–308,630, and 378,950–379,180. |

Command `592` has a wake request builder at SHARED 14,417,602. Its reply is absent from the same bundle's API dispatch table. This SDK's control client covers the correlated request and disposal commands. The control and file retrieval tests use synthetic request and event fixtures. A complete phone-approved transfer and database import remain unverified.
