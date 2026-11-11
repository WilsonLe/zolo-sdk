import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import * as zlib from 'node:zlib';
import { createPcPhoneBackupCipher } from './pc-phone-backup-crypto.js';
import { decodeMobileSyncSnapshotBlock } from './mobile-snapshot.js';
const messages = {
    'invalid-input': 'Supply bounded PC-to-phone archive inputs.',
    'invalid-batch': 'The PC-to-phone archive batch is not a supported Message SyncChunk.',
    'invalid-state': 'The PC-to-phone archive checkpoint is malformed.',
    'limit-exceeded': 'The PC-to-phone archive exceeds its resource limit.',
    'file-exists': 'The PC-to-phone archive output already exists.',
    'file-invalid': 'The PC-to-phone archive requires a private regular file.',
    'file-changed': 'The PC-to-phone archive file no longer matches its receipt.',
    'io-failed': 'The PC-to-phone archive file operation failed.',
    'source-failed': 'The PC-to-phone archive source failed.',
    'compression-unavailable': 'This Node.js build does not provide Zstandard compression.',
    'compression-failed': 'PC-to-phone archive compression failed.',
    'crypto-failed': 'PC-to-phone archive encryption failed.',
    aborted: 'The PC-to-phone archive operation was cancelled.',
    closed: 'The PC-to-phone archive handle is closed.',
};
export class PcPhoneBackupArchiveError extends Error {
    code;
    constructor(code) {
        super(messages[code]);
        this.code = code;
        this.name = 'PcPhoneBackupArchiveError';
    }
}
const MAX_PROTO = 64 * 1024 * 1024, MAX_FILE = 64 * 1024 * 1024 * 1024;
const MAX_CHUNKS = 65_536, MAX_BATCHES = 65_536, MAX_PARTITION_TEXT = 4 * 1024 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024, DEFAULT_CHUNK = 3_145_728;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag).get;
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength').get;
const typedSet = Uint8Array.prototype.set;
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const eventAdd = EventTarget.prototype.addEventListener, eventRemove = EventTarget.prototype.removeEventListener;
const promiseThen = Promise.prototype.then;
const failures = new WeakMap();
function fail(code) { const value = Object.freeze({}); failures.set(value, code); throw value; }
function codeOf(error) {
    return error !== null && (typeof error === 'object' || typeof error === 'function') ? failures.get(error) : undefined;
}
function expose(error, fallback) {
    return new PcPhoneBackupArchiveError(codeOf(error) ?? fallback);
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function own(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor)
        return;
    if (!Object.hasOwn(descriptor, 'value'))
        fail('invalid-input');
    return descriptor.value;
}
function record(value, keys) {
    if (!object(value))
        fail('invalid-state');
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key)))
        fail('invalid-state');
    return value;
}
function integer(value, minimum, maximum, code) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
        fail(code);
    return value;
}
function pathValue(value, code) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || value.includes('\0')
        || !isAbsolute(value) || resolve(value) !== value || !basename(value))
        fail(code);
    return value;
}
function digestValue(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    fail('invalid-state'); return value; }
function decimal(value, signed = false, positive = false) {
    if (typeof value !== 'string' || value.length > 41 || !(signed ? /^-?(0|[1-9][0-9]{0,39})$/ : /^(0|[1-9][0-9]{0,39})$/).test(value)
        || (positive && value === '0'))
        fail('invalid-state');
    return value;
}
function signalValue(signal) {
    if (signal === undefined)
        return;
    try {
        Reflect.apply(abortGetter, signal, []);
    }
    catch {
        fail('invalid-input');
    }
    return signal;
}
function check(signal, lifetime) {
    if (lifetime && Reflect.apply(abortGetter, lifetime, []))
        fail('closed');
    if (signal && Reflect.apply(abortGetter, signal, []))
        fail('aborted');
}
function wait(promise, signal) {
    return new Promise((resolvePromise, reject) => {
        let settled = false;
        const finish = (error, value, rejected = false) => {
            if (settled)
                return;
            settled = true;
            try {
                if (signal)
                    Reflect.apply(eventRemove, signal, ['abort', cancel]);
            }
            catch { }
            rejected ? reject(error) : resolvePromise(value);
        };
        const cancel = () => { try {
            check(signal);
        }
        catch (error) {
            finish(error, undefined, true);
        } };
        Reflect.apply(promiseThen, promise, [(value) => finish(undefined, value), (error) => finish(error, undefined, true)]);
        // Observe the source promise even if its callback just aborted synchronously;
        // a simultaneous rejection must not become an unhandled private exception.
        try {
            if (signal)
                Reflect.apply(eventAdd, signal, ['abort', cancel, { once: true }]);
            cancel();
        }
        catch (error) {
            finish(error, undefined, true);
        }
    });
}
function bytes(value) {
    let length;
    try {
        if (!ArrayBuffer.isView(value) || Reflect.apply(typedTag, value, []) !== 'Uint8Array')
            fail('invalid-batch');
        length = Reflect.apply(typedLength, value, []);
    }
    catch {
        fail('invalid-batch');
    }
    if (length < 1 || length > MAX_PROTO)
        fail('limit-exceeded');
    const result = Buffer.alloc(length);
    try {
        Reflect.apply(typedSet, result, [value]);
        return result;
    }
    catch {
        result.fill(0);
        fail('invalid-batch');
    }
}
/** @internal Pure bounded snapshot, shared with the authenticated checkpoint codec; no filesystem access. */
export function snapshotPcPhoneBackupArchiveState(value) {
    try {
        const raw = record(value, ['version', 'metadata', 'identity', 'batchCount', 'chunks']);
        if (own(raw, 'version') !== 1)
            fail('invalid-state');
        const batchCount = integer(own(raw, 'batchCount'), 1, MAX_BATCHES, 'invalid-state');
        const m = record(own(raw, 'metadata'), ['filePath', 'sizeBytes', 'originalSizeBytes', 'messageCount', 'threadCount', 'checksum', 'chunkSize', 'totalChunks']);
        const chunkSize = integer(own(m, 'chunkSize'), 1, MAX_CHUNK, 'invalid-state');
        const sizeBytes = integer(own(m, 'sizeBytes'), 32 * batchCount, MAX_FILE, 'invalid-state');
        const totalChunks = integer(own(m, 'totalChunks'), 1, MAX_CHUNKS, 'invalid-state');
        if (Math.ceil(sizeBytes / chunkSize) !== totalChunks)
            fail('invalid-state');
        const metadata = Object.freeze({ filePath: pathValue(own(m, 'filePath'), 'invalid-state'), sizeBytes,
            originalSizeBytes: integer(own(m, 'originalSizeBytes'), batchCount, MAX_PROTO * batchCount, 'invalid-state'),
            messageCount: integer(own(m, 'messageCount'), 1, 5000 * batchCount, 'invalid-state'),
            threadCount: integer(own(m, 'threadCount'), 1, batchCount, 'invalid-state'), checksum: digestValue(own(m, 'checksum')), chunkSize, totalChunks });
        const i = record(own(raw, 'identity'), ['device', 'inode', 'uid', 'mode', 'links', 'mtimeNs', 'ctimeNs']);
        if (own(i, 'mode') !== 0o600 || own(i, 'links') !== 1)
            fail('invalid-state');
        const identity = Object.freeze({ device: decimal(own(i, 'device')), inode: decimal(own(i, 'inode'), false, true),
            uid: decimal(own(i, 'uid')), mode: 0o600, links: 1, mtimeNs: decimal(own(i, 'mtimeNs'), true), ctimeNs: decimal(own(i, 'ctimeNs'), true) });
        const list = own(raw, 'chunks');
        if (!Array.isArray(list) || own(list, 'length') !== totalChunks)
            fail('invalid-state');
        const chunks = [];
        for (let index = 0; index < totalChunks; index++) {
            const c = record(own(list, String(index)), ['index', 'offset', 'sizeBytes', 'checksum']);
            const expectedSize = Math.min(chunkSize, sizeBytes - index * chunkSize);
            if (own(c, 'index') !== index + 1 || own(c, 'offset') !== index * chunkSize || own(c, 'sizeBytes') !== expectedSize)
                fail('invalid-state');
            chunks.push(Object.freeze({ index: index + 1, offset: index * chunkSize, sizeBytes: expectedSize, checksum: digestValue(own(c, 'checksum')) }));
        }
        return Object.freeze({ version: 1, metadata, identity, batchCount, chunks: Object.freeze(chunks) });
    }
    catch {
        throw new PcPhoneBackupArchiveError('invalid-state');
    }
}
function owner() { if (typeof process.geteuid !== 'function' || !constants.O_NOFOLLOW)
    fail('file-invalid'); return BigInt(process.geteuid()); }
function owned(info, code, mode = true) {
    if (!info.isFile() || info.uid !== owner() || info.nlink !== 1n || (mode && (info.mode & 4095n) !== 384n))
        fail(code);
}
function fileIdentity(info) {
    return Object.freeze({ device: String(info.dev), inode: String(info.ino), uid: String(info.uid), mode: 0o600, links: 1,
        mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) });
}
function match(info, state) {
    owned(info, 'file-changed');
    const identity = fileIdentity(info);
    for (const key of ['device', 'inode', 'uid', 'mtimeNs', 'ctimeNs'])
        if (identity[key] !== state.identity[key])
            fail('file-changed');
    if (info.size !== BigInt(state.metadata.sizeBytes))
        fail('file-changed');
}
async function canonicalParent(path) {
    try {
        const parent = await realpath(dirname(path));
        const info = await lstat(parent);
        if (!info.isDirectory())
            fail('file-invalid');
        return parent;
    }
    catch (error) {
        if (codeOf(error))
            throw error;
        fail('io-failed');
    }
}
async function validateFile(file, state) {
    if (await canonicalParent(state.metadata.filePath) !== dirname(state.metadata.filePath))
        fail('file-changed');
    const fd = await file.stat({ bigint: true }), path = await lstat(state.metadata.filePath, { bigint: true });
    match(fd, state);
    match(path, state);
}
async function openRead(state) {
    if (await canonicalParent(state.metadata.filePath) !== dirname(state.metadata.filePath))
        fail('file-changed');
    let file;
    try {
        file = await open(state.metadata.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        await validateFile(file, state);
        return file;
    }
    catch (error) {
        try {
            await file?.close();
        }
        catch { }
        if (codeOf(error))
            throw error;
        fail('file-changed');
    }
}
class Digests {
    chunkSize;
    chunks = [];
    whole = createHash('sha256');
    current = createHash('sha256');
    used = 0;
    size = 0;
    constructor(chunkSize) {
        this.chunkSize = chunkSize;
    }
    update(value) {
        this.whole.update(value);
        let offset = 0;
        while (offset < value.length) {
            const count = Math.min(this.chunkSize - this.used, value.length - offset);
            this.current.update(value.subarray(offset, offset + count));
            this.used += count;
            this.size += count;
            offset += count;
            if (this.used === this.chunkSize)
                this.push();
        }
    }
    push() {
        this.chunks.push(Object.freeze({ index: this.chunks.length + 1, offset: this.size - this.used, sizeBytes: this.used, checksum: this.current.digest('hex') }));
        this.used = 0;
        this.current = createHash('sha256');
    }
    finish() { if (this.used)
        this.push(); return this.whole.digest('hex'); }
}
class Framing {
    header = Buffer.alloc(4);
    used = 0;
    remaining = 0;
    blocks = 0;
    update(value) {
        let offset = 0;
        while (offset < value.length) {
            if (this.remaining) {
                const count = Math.min(this.remaining, value.length - offset);
                this.remaining -= count;
                offset += count;
                continue;
            }
            const count = Math.min(4 - this.used, value.length - offset);
            this.header.set(value.subarray(offset, offset + count), this.used);
            this.used += count;
            offset += count;
            if (this.used === 4) {
                this.remaining = this.header.readUInt32LE(0);
                this.used = 0;
                if (this.remaining < 28 || this.remaining > MAX_PROTO + 28 || ++this.blocks > MAX_BATCHES)
                    fail('file-changed');
            }
        }
    }
    finish(expected) { if (this.used || this.remaining || this.blocks !== expected)
        fail('file-changed'); }
}
const handles = new WeakMap();
async function verifyFile(state, signal, lifetime) {
    let file;
    const buffer = Buffer.alloc(65_536);
    const active = () => check(signalValue(signal), lifetime);
    try {
        active();
        file = await openRead(state);
        active();
        const digests = new Digests(state.metadata.chunkSize), framing = new Framing();
        while (digests.size < state.metadata.sizeBytes) {
            active();
            const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, state.metadata.sizeBytes - digests.size), digests.size);
            active();
            if (!bytesRead)
                fail('file-changed');
            const part = buffer.subarray(0, bytesRead);
            framing.update(part);
            digests.update(part);
        }
        framing.finish(state.batchCount);
        if (digests.finish() !== state.metadata.checksum || digests.chunks.length !== state.chunks.length)
            fail('file-changed');
        for (let i = 0; i < state.chunks.length; i++)
            if (digests.chunks[i].checksum !== state.chunks[i].checksum)
                fail('file-changed');
        await validateFile(file, state);
        active();
    }
    finally {
        buffer.fill(0);
        try {
            await file?.close();
        }
        catch { }
    }
}
function archive(state) {
    const lifetime = new AbortController(), entry = { state, closed: false };
    const active = (signal) => { if (entry.closed)
        fail('closed'); check(signalValue(signal), lifetime.signal); };
    const handle = Object.freeze({ metadata: state.metadata,
        async verify(signal) {
            try {
                active(signal);
                await verifyFile(state, signal, lifetime.signal);
                active(signal);
            }
            catch (error) {
                throw expose(error, 'io-failed');
            }
        },
        async readChunk(index, signal) {
            let file, output, returned = false;
            try {
                active(signal);
                integer(index, 1, state.metadata.totalChunks, 'invalid-input');
                const chunk = state.chunks[index - 1];
                output = Buffer.alloc(chunk.sizeBytes);
                file = await openRead(state);
                active(signal);
                let offset = 0;
                while (offset < output.length) {
                    const { bytesRead } = await file.read(output, offset, output.length - offset, chunk.offset + offset);
                    active(signal);
                    if (!bytesRead)
                        fail('file-changed');
                    offset += bytesRead;
                }
                if (createHash('sha256').update(output).digest('hex') !== chunk.checksum)
                    fail('file-changed');
                await validateFile(file, state);
                active(signal);
                await file.close();
                file = undefined;
                active(signal);
                returned = true;
                return output;
            }
            catch (error) {
                throw expose(error, 'io-failed');
            }
            finally {
                if (!returned)
                    output?.fill(0);
                try {
                    if (file)
                        await file.close();
                }
                catch { }
            }
        },
        close() { if (entry.closed)
            return; entry.closed = true; lifetime.abort(); },
    });
    handles.set(handle, entry);
    return handle;
}
/** @internal Copies validated private checkpoint state; never exports key material. */
export function pcPhoneBackupArchiveState(handle) {
    const entry = handles.get(handle);
    if (!entry)
        throw new PcPhoneBackupArchiveError('invalid-input');
    if (entry.closed)
        throw new PcPhoneBackupArchiveError('closed');
    return snapshotPcPhoneBackupArchiveState(entry.state);
}
/** @internal State must come from the workflow's authenticated checkpoint. Performs a full file verification. */
export async function restorePcPhoneBackupArchive(value, signal) {
    const state = snapshotPcPhoneBackupArchiveState(value);
    try {
        await verifyFile(state, signal);
        check(signalValue(signal));
        return archive(state);
    }
    catch (error) {
        throw expose(error, 'io-failed');
    }
}
function source(value) {
    try {
        if (!object(value))
            fail('invalid-input');
        const factory = Reflect.get(value, Symbol.asyncIterator);
        if (typeof factory !== 'function')
            fail('invalid-input');
        const iterator = Reflect.apply(factory, value, []);
        if (!object(iterator))
            fail('invalid-input');
        const next = Reflect.get(iterator, 'next'), end = Reflect.get(iterator, 'return');
        if (typeof next !== 'function' || (end !== undefined && typeof end !== 'function'))
            fail('invalid-input');
        return { next: () => Reflect.apply(next, iterator, []), close() {
                try {
                    if (end)
                        Reflect.apply(promiseThen, Promise.resolve(Reflect.apply(end, iterator, [])), [undefined, () => { }]);
                }
                catch { }
            } };
    }
    catch (error) {
        if (codeOf(error))
            throw error;
        fail('source-failed');
    }
}
async function write(file, value, digests, signal) {
    let offset = 0;
    while (offset < value.length) {
        check(signal);
        let bytesWritten;
        try {
            ({ bytesWritten } = await file.write(value, offset, value.length - offset, digests.size));
        }
        catch {
            fail('io-failed');
        }
        check(signal);
        if (!bytesWritten)
            fail('io-failed');
        digests.update(value.subarray(offset, offset + bytesWritten));
        offset += bytesWritten;
    }
}
/** Creates one exclusive private file from caller-supplied message batches; preserves partial files on every failure. */
export async function createPcPhoneBackupArchive(options) {
    let file, cipher, iterator, ended = false;
    try {
        if (!object(options))
            fail('invalid-input');
        const requestedPath = pathValue(own(options, 'filePath'), 'invalid-input');
        const rawChunkSize = own(options, 'chunkSize'), rawMaxFile = own(options, 'maxFileBytes');
        const chunkSize = integer(rawChunkSize === undefined ? DEFAULT_CHUNK : rawChunkSize, 1, MAX_CHUNK, 'invalid-input');
        const maxFile = integer(rawMaxFile === undefined ? 1024 * 1024 * 1024 : rawMaxFile, 1, MAX_FILE, 'invalid-input');
        const signal = signalValue(own(options, 'signal'));
        check(signal);
        owner();
        try {
            cipher = createPcPhoneBackupCipher(own(options, 'serverKey'), own(options, 'clientSalt'));
        }
        catch {
            fail('invalid-input');
        }
        iterator = source(own(options, 'batches'));
        if (typeof zlib.zstdCompressSync !== 'function')
            fail('compression-unavailable');
        const parent = await canonicalParent(requestedPath), filePath = pathValue(join(parent, basename(requestedPath)), 'invalid-input');
        check(signal);
        try {
            file = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        }
        catch (error) {
            try {
                if (object(error) && own(error, 'code') === 'EEXIST')
                    fail('file-exists');
            }
            catch (failure) {
                if (codeOf(failure))
                    throw failure;
            }
            fail('io-failed');
        }
        check(signal);
        const initial = await file.stat({ bigint: true });
        owned(initial, 'file-invalid', false);
        await file.chmod(0o600);
        owned(await file.stat({ bigint: true }), 'file-invalid');
        check(signal);
        const digests = new Digests(chunkSize), partitions = new Set();
        let originalSizeBytes = 0, messageCount = 0, batchCount = 0, partitionText = 0;
        while (true) {
            check(signal);
            let item;
            try {
                item = await wait(Promise.resolve(iterator.next()), signal);
            }
            catch (error) {
                if (codeOf(error))
                    throw error;
                fail('source-failed');
            }
            check(signal);
            if (!object(item))
                fail('source-failed');
            const done = own(item, 'done');
            if (done !== undefined && typeof done !== 'boolean')
                fail('source-failed');
            if (done === true) {
                ended = true;
                break;
            }
            if (++batchCount > MAX_BATCHES)
                fail('limit-exceeded');
            const batch = own(item, 'value');
            if (!object(batch))
                fail('invalid-batch');
            let protobuf, compressed, encrypted;
            try {
                protobuf = bytes(own(batch, 'protobuf'));
                const count = integer(own(batch, 'messageCount'), 0, 5000, 'invalid-batch'), declared = own(batch, 'partitionId');
                const decoded = decodeMobileSyncSnapshotBlock(protobuf, { kind: 'message', encoding: 'protobuf', maxOutputBytes: MAX_PROTO });
                if (decoded.platform !== 3 || decoded.partitionsList.length !== 1)
                    fail('invalid-batch');
                const partition = decoded.partitionsList[0];
                if (typeof declared !== 'string' || !/^(oneone|group)\/.+/.test(declared) || /[\x00-\x1f\x7f]/.test(declared)
                    || Buffer.byteLength(declared) > 4103 || partition.id !== declared || partition.messagesList.length !== count)
                    fail('invalid-batch');
                if (!partitions.has(declared)) {
                    partitions.add(declared);
                    partitionText += Buffer.byteLength(declared);
                }
                if (partitions.size > MAX_BATCHES || partitionText > MAX_PARTITION_TEXT)
                    fail('limit-exceeded');
                originalSizeBytes += protobuf.length;
                messageCount += count;
                if (!Number.isSafeInteger(originalSizeBytes) || !Number.isSafeInteger(messageCount))
                    fail('limit-exceeded');
                try {
                    compressed = zlib.zstdCompressSync(protobuf, { maxOutputLength: MAX_PROTO, params: {
                            [zlib.constants.ZSTD_c_compressionLevel]: 3, [zlib.constants.ZSTD_c_checksumFlag]: 0, [zlib.constants.ZSTD_c_nbWorkers]: 4,
                        } });
                }
                catch {
                    fail('compression-failed');
                }
                if (compressed.length > MAX_PROTO)
                    fail('limit-exceeded');
                try {
                    encrypted = Buffer.from(cipher.encrypt(compressed));
                }
                catch {
                    fail('crypto-failed');
                }
                if (digests.size + 4 + encrypted.length > maxFile || Math.ceil((digests.size + 4 + encrypted.length) / chunkSize) > MAX_CHUNKS)
                    fail('limit-exceeded');
                const header = Buffer.alloc(4);
                header.writeUInt32LE(encrypted.length);
                await write(file, header, digests, signal);
                await write(file, encrypted, digests, signal);
            }
            catch (error) {
                if (codeOf(error))
                    throw error;
                fail('invalid-batch');
            }
            finally {
                protobuf?.fill(0);
                compressed?.fill(0);
                encrypted?.fill(0);
            }
        }
        if (!batchCount || !messageCount)
            fail('invalid-batch');
        check(signal);
        await file.sync();
        check(signal);
        const fdInfo = await file.stat({ bigint: true });
        owned(fdInfo, 'file-invalid');
        if (fdInfo.dev !== initial.dev || fdInfo.ino !== initial.ino || fdInfo.size !== BigInt(digests.size))
            fail('file-changed');
        await file.close();
        file = undefined;
        const finalInfo = await lstat(filePath, { bigint: true });
        owned(finalInfo, 'file-invalid');
        if (finalInfo.dev !== fdInfo.dev || finalInfo.ino !== fdInfo.ino || finalInfo.size !== fdInfo.size
            || await canonicalParent(filePath) !== parent)
            fail('file-changed');
        check(signal);
        const state = snapshotPcPhoneBackupArchiveState({ version: 1, metadata: { filePath, sizeBytes: digests.size, originalSizeBytes,
                messageCount, threadCount: partitions.size, checksum: digests.finish(), chunkSize, totalChunks: digests.chunks.length },
            identity: fileIdentity(finalInfo), batchCount, chunks: digests.chunks });
        await verifyFile(state, signal);
        check(signal);
        cipher.dispose();
        cipher = undefined;
        return archive(state);
    }
    catch (error) {
        throw expose(error, 'io-failed');
    }
    finally {
        if (!ended)
            iterator?.close();
        cipher?.dispose();
        try {
            if (file)
                await file.close();
        }
        catch { }
    }
}
