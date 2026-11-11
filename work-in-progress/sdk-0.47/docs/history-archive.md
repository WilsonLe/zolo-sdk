# Desktop SQLite history archive

`openHistoryArchive(path)` reads an explicit SQLite snapshot with the installed desktop client's message table. Use it to page the history present in a conversation's archive. Direct threads use their decimal peer ID and group threads use the desktop `g<groupId>` ID. The archive reader works independently of a Zalo login.

```ts
import { openHistoryArchive } from 'zalo-personal-sdk';

const archive = await openHistoryArchive('/absolute/path/to/message-snapshot.sqlite');
try {
  let before;
  do {
    const page = archive.readConversation(threadId, { before, limit: 100 });
    await saveMessages(page.messages);
    before = page.nextCursor;
  } while (before);
} finally {
  archive.close();
}
```

Supply a standalone ordinary SQLite snapshot. Checkpoint and close the exporter before using the file so it has no WAL, SHM, or journal sidecars. The reader opens it in immutable, read-only mode, uses only the `message` table, and rejects unsupported schemas. Node loads `node:sqlite` on the first archive open. The SDK accepts one explicit path per archive handle, which fits the desktop's per-conversation message partitions.

The reader treats rows with `ev` absent or null as decoded JSON in a standalone export. For rows explicitly marked `ev=0`, pass `{ messageEncoding: { kind: 'legacy-xor', key: fieldKey } }` with the field key supplied with that export. The same snapshot can contain both forms. In the app, unmarked rows can depend on separate migration state. Export those rows as decoded JSON because the snapshot reader has no migration state. Opening a SQLCipher-encrypted database, recovering an account field key, and decrypting conversation E2EE messages require separate inputs and implementations. Treat history data and field keys as private.

The reader follows the desktop index ordering for `sendDttm` and `msgId`. Both are strings. `nextCursor` can resume a page in the same thread, including ties at the same timestamp. The result retains the stored message type, sender and client IDs, parsed message content, and available quote, mention, and E2EE status fields. The returned `message` is provider-shaped JSON. [Recovery queue and mobile transfer differences](direct-history.md)

## Shipped evidence

The source is the installed **26.11.10** archive. The hashes and offsets below identify packed ASAR members. [Desktop build identity](desktop-evidence.md)

| Member | SHA-256 |
| --- | --- |
| `main-dist/preload-sqlite.js` | `c30cd73b111230c0ffbd4f8ade73446416189a656d5e4ed64cd5deeb1ea9287a` |
| `main-dist/utility-process-sqlite.js` | `388a3c0e75438fdf0b6a0a97019e73e6acfa97c8961dee7408332e7102253821` |

| Part | Source finding |
| --- | --- |
| Message table | The SQLite utility defines table `message` with `msgId` as its primary key. Its `userId_sendDttm_msgId` index is a unique composite over `toUid`, `sendDttm`, and `msgId`. All three use SQLite `TEXT`. Utility offsets 1,028,243–1,034,000 and 259,350–260,650. |
| Partition and query | The SQLite adapter chooses a message partition by `toUid`. The preload builds a separate pool name from the account database name, table name, and partition key. The desktop history controller queries that partition with the composite index and a timestamp/ID range. Utility 1,033,670, preload 1,787,994, and SHARED 848,640–849,765. |
| JSON fields | The preload serializes JSON fields for SQLite and parses them on read. It runs the row transform before serialization and reverses it after parsing. Preload offsets 1,825,205–1,826,100 and 1,827,943–1,828,840. |
| Legacy transform | The SQLite message schema declares version 0 `BasicEncryption` on `message`. The implementation XORs successive JavaScript UTF-16 code units with the field key cyclically. The row transform writes its version to `ev` and encodes the JSON string for the field. Utility offsets 1,033,670–1,034,000, 218,550–219,320, and 221,600–222,450. |
| Database encryption | The app also ships a SQLCipher path and can export between database files with SQLCipher keys. That database layer is separate from the row field encoding. Preload offsets 1,726,600–1,727,600 and 1,763,650–1,765,480. |

Offline fixtures reproduce the shipped schema and both JSON layouts. They verify timestamp ties, direct and group selection, large IDs, the legacy field transform, unsupported files, and unchanged source bytes. No profile files or live history requests were used.
