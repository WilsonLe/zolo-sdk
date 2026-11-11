# Create a PC-to-phone backup

The 0.25 workflow prepares an encrypted backup from **caller-owned message records**, allocates one backup session, initializes its metadata and uploads sequential chunks. It uses an existing SDK Desktop connection and its matching frame feed. It does not inspect the installed app's database, read another application's credentials, fetch a complete account history, open another listener or signal a phone restore.

`createPcPhoneBackup` composes the workflow. `preparePcPhoneBackup` stops with a durable pre-init checkpoint and a private archive; `uploadPcPhoneBackup` explicitly continues a safe checkpoint. The [importable example](../examples/pc-phone-backup.mjs) performs no operation until one of its exported functions is called. [Existing-backup reads and restore handoff](pc-phone-backup.md) remain separate choices.

## Complete workflow

Use Node 22+ with the built-in `node:zlib` Zstandard compressor/decompressor available; some Node 22 builds lack these functions. Check availability before allocating a remote session. The archive currently requires POSIX owner checks (`geteuid` and `O_NOFOLLOW`), a regular owner-only 0600 file and a single hard link.

The application must supply a stable snapshot, choose a new absolute archive path and hold a single-writer lock for the account/checkpoint. Load an independent 32-byte wrapping key from the application's secret store **before** starting. Keep that durable key separately from the checkpoint file; generating a replacement key on restart cannot open the old journal. The wrapping key is not the account AES key, Desktop session token, server nonce or client salt.

```ts
import {
  createPcPhoneBackup, FilePcPhoneBackupCheckpointStore, PcPhoneBackupJobError,
} from 'zalo-personal-sdk';
import type { PcPhoneBackupSource } from 'zalo-personal-sdk';

// connection/feed already belong to this approved Desktop session.
// source is an immutable application-owned snapshot; wrappingKey is durably held elsewhere.
const store = new FilePcPhoneBackupCheckpointStore('/private/app/backup-checkpoint');

try {
  const result = await createPcPhoneBackup(connection, feed, source, {
    filePath: '/private/app/new-backup.bin',
    wrappingKey,
    signal,
    onCheckpoint: checkpoint => store.save(checkpoint),
  });
  // result.status === 'uploaded'; acceptedChunks === archive.totalChunks.
  // result.assemblyConfirmed === false; result.phoneImportConfirmed === false.
} catch (error) {
  if (error instanceof PcPhoneBackupJobError) {
    const latestPrivateJournal = error.getCheckpoint();
    // Reconcile/save explicitly if persistence failed. Do not log this ciphertext or replay blindly.
  }
  throw error;
}
```

Starting another `createPcPhoneBackup` is a new operation, not a recovery action. Check the application's existing checkpoint before choosing to create. The SDK preserves it until your persistence callback replaces it; it does not automatically clear a prior journal or choose a different file.

## Caller-owned source

`PcPhoneBackupSource` has an own, nonempty `revision` string and two asynchronous callbacks. Keep the revision, callbacks and underlying snapshot stable throughout preparation. A changed revision is rejected. Deterministic ordering and an immutable backing snapshot are the application's responsibility; changing rows without changing the revision cannot be detected reliably.

```ts
const source: PcPhoneBackupSource = {
  revision: snapshot.revision,
  async readThreads({ after, limit, signal }) {
    // limit is 500. Return distinct local conversation IDs in stable order.
    // snapshot is YOUR read-only store, not an SDK Desktop database importer.
    return snapshot.readThreadPage({ after, limit, signal });
  },
  async readMessages({ threadId, after, limit, signal }) {
    // limit is 5000. Return native-compatible raw records for this thread.
    return snapshot.readMessagePage({ threadId, after, limit, signal });
  },
};
```

Each page is `{items,next?}` with a dense readonly array. Missing/null `next` finishes that page stream; otherwise it is a nonempty opaque string. Repeating a cursor or conversation ID is rejected. Callbacks must honor `signal` and settle their promises; the SDK cannot forcibly finish arbitrary trusted application promises. The same applies to custom resolvers, diagnostics and persistence callbacks.

Conversation IDs are canonical positive decimal strings; group IDs use one leading `g`. Raw `fromUid` uses local PC identities (`'0'` means self); it is not an already-global token. Use exact decimal strings for 64-bit message/client/timestamp fields. Unsafe integer Numbers, accessors, sparse arrays and undefined array entries are rejected; optional own object members set to undefined are omitted. Raw nested values must be bounded JSON data. The raw formatter follows native type/status, text, attachment, mention, quote, reference, property, media/location and first-contact rules. It carries supplied prior recall IDs plus observed current/earlier-batch undo IDs; it does not consult the installed recall cache or rewrite earlier blocks after a later undo.

The default identity resolver reads the account's own profile, mini profiles in 100-ID batches and group info in 100-ID batches. Local and opaque global identities remain separate; numeric-looking global tokens are retained as text. Self mapping is required. Missing required partition/sender/quote/contact mappings fail preparation by default. There is no automatic lookup retry.

To deliberately discard unresolvable records, set `onUnmappable:'drop'` **and** provide an awaited `onDiagnostics` callback. Reports contain thread/batch/record indexes and fixed reasons, not IDs, content or raw provider errors. Successful complete creation reports `diagnosticCount`. All-dropped/empty snapshots cannot publish a successful backup. The SDK never silently turns them into a populated archive.

This is a message-record backup. It does not include standalone reactions/notify fields, bundle referenced binary media, decrypt arbitrary encrypted records or guarantee that every attachment locator remains usable. Supply authenticated clear records through their proper source. Native content fallbacks and some unsupported metadata are intentionally lossy; unknown JSON fields are not invented protobuf tags.

## Preparation and restart

For an explicit prepare-now/upload-later choice:

```ts
import { preparePcPhoneBackup, uploadPcPhoneBackup } from 'zalo-personal-sdk';

const prepared = await preparePcPhoneBackup(connection, feed, source, {
  filePath: newArchivePath, wrappingKey, signal,
  onCheckpoint: checkpoint => store.save(checkpoint),
});

// A later process may bootstrap a new connection/feed for the SAME account and IMEI.
const checkpoint = await store.load();
if (checkpoint !== null) {
  const uploaded = await uploadPcPhoneBackup(connection, feed, checkpoint, {
    wrappingKey, signal, onCheckpoint: next => store.save(next),
  });
}
```

The authenticated journal binds the account+Desktop IMEI identity, source revision, device name, policy, session key inputs, archive identity/hash/layout and upload progress. Creation command 631 and initialization command 630 IDs are separate: a returned init ID may replace the creation ID. Opaque strings and nonzero signed safe numeric IDs retain their exact type. Wrong account/IMEI/key, altered checkpoints and changed files fail before a new remote mutation.

Journal phases describe conservative recovery boundaries:

| Last durable phase | Explicit continuation |
| --- | --- |
| `creating` | Do not replay 631. Reconciliation is required; the journal alone cannot establish whether creation completed. |
| `preparing` | Known 631 result, no completed archive. Call `preparePcPhoneBackup` with this checkpoint, the same source revision/options and a **new, uncreated file path**. It reuses known creation rather than sending 631 again. |
| `prepared` | Verify the retained private file, persist `initializing`, then submit 630 once. |
| `initializing` | Do not replay 630. Reconciliation is required. |
| `uploading`, accepted prefix and no in-flight chunk | Verify the file and submit only the next unaccepted chunk. An all-accepted prefix can finalize the journal without a file or further remote work. |
| `uploading`, an in-flight chunk recorded | That chunk may have reached the provider. Reconciliation is required; no automatic resend occurs. |
| `uploaded` | Historical chunk-ACK result. Return it without 630/HTTP or requiring the local archive to still exist. |

The file creator uses exclusive creation, preserves partial files on every failure and never overwrites/deletes them. Preparation resume at the old partial path therefore fails rather than appending blindly. Applications own cleanup, retention and source lifetime. Safe upload continuation verifies owner/mode, inode/device, timestamps, size, hashes and chunk layout before sending new data.

`onCheckpoint` must resolve only after durable persistence. Intent is saved before 631, 630 or a chunk handoff; known acknowledgments are saved before another request. A cancellation/closure arriving after a known ACK does not erase that progress. If saving fails, `PcPhoneBackupJobError.getCheckpoint()` explicitly returns the latest encrypted in-memory journal, which may be newer than the on-disk record. Repair/reconcile persistence before another attempt; resending from an older file can duplicate an uncertain effect.

`FilePcPhoneBackupCheckpointStore` serializes its own writes and stores owner-only ciphertext atomically. It does not store the wrapping key, supply cross-process locking, detect rollback to an older valid journal or reconcile the provider. The workflow also rejects overlapping jobs for the same account or persistence callback within the process; that is not a substitute for the application's single-writer policy.

## Results, errors and limits

`PreparedPcPhoneBackup` contains status `prepared`, checkpoint, archive metadata and diagnosticCount. `UploadedPcPhoneBackup` contains status `uploaded`, checkpoint, the acknowledged init bkid, archive metadata and acceptedChunks. Complete `createPcPhoneBackup` also retains diagnosticCount. The immutable result always says **assemblyConfirmed:false** and **phoneImportConfirmed:false**: uploaded bytes/ACKs do not prove server assembly, phone acceptance, decryption or database import.

`PcPhoneBackupJobError` has fixed code/stage, submitted, outcomeUnknown, acceptedChunks, sessionAllocated, optional safe providerCode and the explicit encrypted-journal getter. No provider body, credential, raw key or arbitrary callback cause appears in the ordinary error. Known nonzero provider refusal is distinct from a local failure. A known refused init/chunk rolls back its unaccepted intent to a safe checkpoint; a later retry is an explicit application choice. Post-handoff cancellation, missing/malformed acknowledgment or transport failure may report `submission-unknown`. Do not treat a failure as permission to replay.

Defaults are 10s per correlated 631/630 request, 60s per HTTP chunk, 3145728-byte upload chunks and a 1 GiB archive ceiling. Configurable chunks are 1 byte–16 MiB; file ceiling is at most 64 GiB, with at most 65536 chunks/batches. Each raw batch is at most 5000 records; protobuf is at most 64 MiB, strings 1 MiB, JSON snapshots 64 MiB/200000 nodes/depth 32. The authenticated checkpoint plaintext is at most 16 MiB. These are SDK resource policies, not measured server maxima. There is no automatic expiry refresh, upload retry, phone notification, restore 633, receipt, chat send, queue reset or archive cleanup.

The connection/feed remain caller-owned. Stop them explicitly when appropriate; the workflow neither reconnects nor closes a successful shared connection. Preserve private raw records, keys, journal ciphertext and backup IDs outside bot messages/logs.

## Evidence and remaining boundary

The source contract is from installed Desktop 26.11.10/build 26.11.10.3400: SHARED SHA `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`, MAIN SHA `899609aa5a03f339a77b896d524fadb8f84b9831033041039bca12c14f595121`, worker SHA `6304c3fece19686a4a65d46044eca49a6df5fc1f8b4b65064ca5e728ef1aaf53`. UTF-8 byte anchors: worker 208600–228600 record/global-ID transforms; 248938–251300 message protobuf; MAIN 784600–787600 message-only pipeline/metadata; SHARED 14417800–14418700 commands 631/630; 12539937 upload; preload 988844 uint32 host-endian framing (portable SDK writes explicit little-endian).

The dedicated ChaCha20-Poly1305 backup cipher has independent isolated stock-WASM synthetic vectors. It is separate from account AES, Signal/E2EE and 590 phone-to-client snapshot encryption. The creation fixtures use real temporary archives/private checkpoint files, synthetic Desktop/feed authentication and multipart responses; they cross-decrypt/decompress/inspect raw-known records, check complete upload bytes and exercise durable restart/failure boundaries. No installed user database is used.

There is **no live 631/630/upload or phone-import proof** for this workflow. A separately authorized Desktop read accepted registration/configuration and a 632 metadata request timed out after 5s without retained raw frames. That timeout proves neither backup absence nor a wrong request contract, and those reads do not validate creation. Phone receiver/version compatibility, retention, live service acceptance and final import remain controlled-validation boundaries. This feature does not establish complete installed-client or full-account backup parity.
