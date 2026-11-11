import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseProtocolJson } from './protocol-request.js';

export interface HistoryArchiveOptions {
  /** The SQLite file itself must already be readable as ordinary SQLite. */
  messageEncoding?: { kind: 'json' } | { kind: 'legacy-xor'; key: string };
}

export interface HistoryArchiveCursor {
  readonly threadId: string;
  readonly sendDttm: string;
  readonly msgId: string;
}

export interface HistoryArchiveMessage extends HistoryArchiveCursor {
  readonly msgType: number;
  readonly cliMsgId?: string;
  readonly fromUid?: string;
  readonly message: unknown;
  readonly quote?: unknown;
  readonly mentions?: unknown;
  readonly e2eeStatus?: number;
}

export interface HistoryArchivePage {
  readonly messages: HistoryArchiveMessage[];
  readonly nextCursor?: HistoryArchiveCursor;
}

export interface HistoryArchive {
  /** Pages newest first using the archive's text ordering. Group thread IDs use the desktop g prefix. */
  readConversation(threadId: string, options?: { before?: HistoryArchiveCursor; limit?: number }): HistoryArchivePage;
  close(): void;
}

const errors = {
  'runtime-unavailable': 'Opening a Zalo history archive requires a Node.js build with node:sqlite.',
  'archive-unreadable': 'The Zalo history archive could not be opened or read.',
  'snapshot-required': 'Use a standalone SQLite snapshot with no WAL, SHM, or journal sidecar.',
  'unsupported-format': 'The history archive must be an ordinary SQLite file.',
  'unsupported-schema': 'The archive does not contain the supported Zalo desktop message table.',
  'field-key-required': 'The archive marks this message as field encoded. Supply its legacy field encoding and key.',
  'unsupported-field-encoding': 'The archive contains an unsupported message field encoding.',
  'invalid-record': 'The archive contains a message with an unexpected format or field key.',
  'archive-closed': 'The Zalo history archive is closed.',
} as const;

export class HistoryArchiveError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(errors[code]);
    this.name = 'HistoryArchiveError';
  }
}

type Row = Record<string, unknown>;
const sqliteHeader = Buffer.from('SQLite format 3\0', 'ascii');
const requiredColumns = { toUid: 'TEXT', sendDttm: 'TEXT', msgId: 'TEXT', msgType: 'INTEGER', message: 'TEXT' } as const;
const optionalColumns = ['cliMsgId', 'fromUid', 'quote', 'mentions', 'ev', 'e2eeStatus'] as const;

async function snapshotUrl(path: string): Promise<URL> {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new TypeError('Supply one explicit SQLite snapshot path.');
  const filename = resolve(path);
  try {
    const info = await lstat(filename);
    if (!info.isFile()) throw new HistoryArchiveError('archive-unreadable');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        await lstat(filename + suffix);
        throw new HistoryArchiveError('snapshot-required');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const header = Buffer.alloc(sqliteHeader.length);
      const result = await file.read(header, 0, header.length, 0);
      if (result.bytesRead !== header.length || !header.equals(sqliteHeader)) {
        throw new HistoryArchiveError('unsupported-format');
      }
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof HistoryArchiveError) throw error;
    throw new HistoryArchiveError('archive-unreadable');
  }
  const url = pathToFileURL(filename);
  url.searchParams.set('immutable', '1');
  return url;
}

function archiveStatements(db: DatabaseSync) {
  db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
  const table = db.prepare("PRAGMA main.table_list('message')").get();
  if (table?.schema !== 'main' || table.type !== 'table') throw new HistoryArchiveError('unsupported-schema');
  const columns = new Map(db.prepare("PRAGMA main.table_xinfo('message')").all().map((column) => [column.name, column]));
  for (const [name, type] of Object.entries(requiredColumns)) {
    const column = columns.get(name);
    if (typeof column?.type !== 'string' || column.type.toUpperCase() !== type || column.hidden !== 0) {
      throw new HistoryArchiveError('unsupported-schema');
    }
  }
  if (columns.get('msgId')?.pk !== 1 || [...columns.values()].filter((column) => column.pk !== 0).length !== 1) {
    throw new HistoryArchiveError('unsupported-schema');
  }
  const selected = [...Object.keys(requiredColumns), ...optionalColumns.filter((name) => columns.get(name)?.hidden === 0)];
  const base = `SELECT ${selected.map((name) => `"${name}"`).join(', ')} FROM main."message" WHERE "toUid" = ?`;
  const order = ' ORDER BY "sendDttm" DESC, "msgId" DESC LIMIT ?';
  const first = db.prepare(base + order);
  const continuation = db.prepare(base + ' AND ("sendDttm", "msgId") < (?, ?)' + order);
  first.setReadBigInts(true);
  continuation.setReadBigInts(true);
  return { first, continuation };
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\0');
}

function requireText(value: unknown): string {
  if (!validText(value)) throw new HistoryArchiveError('invalid-record');
  return value;
}

function optionalText(value: unknown): string {
  if (typeof value !== 'string') throw new HistoryArchiveError('invalid-record');
  return value;
}

function integer(value: unknown): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) throw new HistoryArchiveError('invalid-record');
  return number;
}

function json(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== 'string') throw new HistoryArchiveError('invalid-record');
  try { return parseProtocolJson(value); }
  catch { throw new HistoryArchiveError('invalid-record'); }
}

function decodeMessage(row: Row, fieldKey?: string): unknown {
  if (row.ev == null) return json(row.message);
  if (row.ev !== 0n && row.ev !== 0) throw new HistoryArchiveError('unsupported-field-encoding');
  if (fieldKey === undefined) throw new HistoryArchiveError('field-key-required');
  const value = json(row.message);
  if (!value) return value;
  if (typeof value !== 'string') throw new HistoryArchiveError('invalid-record');
  const decoded = new Array<string>(value.length);
  for (let i = 0; i < value.length; i++) {
    decoded[i] = String.fromCharCode(value.charCodeAt(i) ^ fieldKey.charCodeAt(i % fieldKey.length));
  }
  return json(decoded.join(''));
}

function archiveMessage(row: Row, fieldKey?: string): HistoryArchiveMessage {
  return {
    threadId: requireText(row.toUid),
    sendDttm: requireText(row.sendDttm),
    msgId: requireText(row.msgId),
    msgType: integer(row.msgType),
    message: decodeMessage(row, fieldKey),
    ...(row.cliMsgId == null ? {} : { cliMsgId: optionalText(row.cliMsgId) }),
    ...(row.fromUid == null ? {} : { fromUid: optionalText(row.fromUid) }),
    ...(row.quote == null ? {} : { quote: json(row.quote) }),
    ...(row.mentions == null ? {} : { mentions: json(row.mentions) }),
    ...(row.e2eeStatus == null ? {} : { e2eeStatus: integer(row.e2eeStatus) }),
  };
}

/** Opens one caller-supplied standalone SQLite export. The SDK never writes to the source. */
export async function openHistoryArchive(path: string, options: HistoryArchiveOptions = {}): Promise<HistoryArchive> {
  const encoding = options.messageEncoding;
  if (encoding && encoding.kind !== 'json' && (encoding.kind !== 'legacy-xor' || typeof encoding.key !== 'string' || !encoding.key)) {
    throw new TypeError('Supply a nonempty legacy field key or choose JSON message encoding.');
  }
  let fieldKey = encoding?.kind === 'legacy-xor' ? encoding.key : undefined;
  const url = await snapshotUrl(path);
  let sqlite: typeof import('node:sqlite');
  try { sqlite = await import('node:sqlite'); }
  catch { throw new HistoryArchiveError('runtime-unavailable'); }
  let db: DatabaseSync;
  try { db = new sqlite.DatabaseSync(url, { readOnly: true, allowExtension: false, enableDoubleQuotedStringLiterals: false }); }
  catch { throw new HistoryArchiveError('archive-unreadable'); }
  let statements: ReturnType<typeof archiveStatements>;
  try { statements = archiveStatements(db); }
  catch (error) {
    try { db.close(); } catch { /* Preserve the schema error. */ }
    if (error instanceof HistoryArchiveError) throw error;
    throw new HistoryArchiveError('archive-unreadable');
  }

  let closed = false;
  return {
    readConversation(threadId, { before, limit = 100 } = {}) {
      if (closed) throw new HistoryArchiveError('archive-closed');
      if (!validText(threadId) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new TypeError('Supply a desktop thread ID and a page size from 1 to 1000.');
      }
      if (before && (before.threadId !== threadId || !validText(before.sendDttm) || !validText(before.msgId))) {
        throw new TypeError('Use a history cursor returned for this thread.');
      }
      let rows: Row[];
      try {
        rows = before
          ? statements.continuation.all(threadId, before.sendDttm, before.msgId, limit + 1)
          : statements.first.all(threadId, limit + 1);
      } catch { throw new HistoryArchiveError('archive-unreadable'); }
      const messages = rows.slice(0, limit).map((row) => archiveMessage(row, fieldKey));
      if (rows.length <= limit) return { messages };
      const { sendDttm, msgId } = messages[messages.length - 1];
      return { messages, nextCursor: { threadId, sendDttm, msgId } };
    },
    close() {
      if (closed) return;
      closed = true;
      fieldKey = undefined;
      try { db.close(); }
      catch { throw new HistoryArchiveError('archive-unreadable'); }
    },
  };
}
