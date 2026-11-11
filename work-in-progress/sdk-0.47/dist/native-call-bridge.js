import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseProtocolJson } from './protocol-request.js';
const errors = {
    'unsupported-helper': 'The installed Zalo call helper build is unsupported.',
    'invalid-message': 'Invalid Zalo native call message.',
    'invalid-frame': 'Invalid Zalo native call transport frame.',
    'startup-failed': 'The Zalo call helper could not start.',
    'startup-timeout': 'The Zalo call helper did not become ready.',
    'ack-timeout': 'The Zalo call helper did not acknowledge a frame.',
    'response-timeout': 'The Zalo call helper did not reply to the request.',
    'request-pending': 'A Zalo call helper request with this response name is already pending.',
    'invalid-response': 'The Zalo call helper returned an unexpected response.',
    'disconnected': 'The Zalo call helper disconnected.',
    'handler-failed': 'The Zalo call helper event handler failed.',
    'closed': 'The Zalo call bridge is closed.',
    'aborted': 'The Zalo call bridge was cancelled.',
};
export class NativeCallBridgeError extends Error {
    code;
    constructor(code) {
        super(errors[code]);
        this.code = code;
        this.name = 'NativeCallBridgeError';
    }
}
const types = new Set(['update', 'request', 'response', 'control', 'recvSignal', 'sendSignal']);
const fragmentSize = 4_000;
const maxCiphertext = 2 * 1024 * 1024;
const hex = /^[a-f0-9]+$/i;
const zeroIv = Buffer.alloc(16);
function isMessage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const { type, command, id } = value;
    return typeof type === 'string' && types.has(type) &&
        (command === undefined || typeof command === 'string' || Number.isSafeInteger(command)) &&
        (id === undefined || typeof id === 'string' || Number.isSafeInteger(id));
}
/** Encode host writes and decode a stream of local ZaloCall transport frames. */
export function createNativeCallCodec(transportKey) {
    if (!(transportKey instanceof Uint8Array) || transportKey.byteLength !== 16) {
        throw new TypeError('The Zalo native call transport needs a 16-byte key.');
    }
    const key = Buffer.from(transportKey);
    let messageId = 0;
    let pending = '';
    let multipart;
    let closed = false;
    function encode(message) {
        if (closed)
            throw new NativeCallBridgeError('closed');
        if (!isMessage(message))
            throw new NativeCallBridgeError('invalid-message');
        let plaintext;
        try {
            plaintext = JSON.stringify(message);
        }
        catch {
            throw new NativeCallBridgeError('invalid-message');
        }
        if (Buffer.byteLength(plaintext) >= maxCiphertext / 2)
            throw new NativeCallBridgeError('invalid-message');
        const cipher = createCipheriv('aes-128-cbc', key, zeroIv);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('hex');
        const count = Math.ceil(ciphertext.length / fragmentSize);
        if (count === 1)
            return [`${ciphertext}$`];
        messageId = Math.max(messageId + 1, Date.now());
        return Array.from({ length: count }, (_, index) => `${ciphertext.slice(index * fragmentSize, (index + 1) * fragmentSize)}#${messageId}#${count}#${index}#$`);
    }
    function decrypt(ciphertext) {
        if (ciphertext.length === 0 || ciphertext.length > maxCiphertext || ciphertext.length % 32 || !hex.test(ciphertext)) {
            throw new NativeCallBridgeError('invalid-frame');
        }
        try {
            const decipher = createDecipheriv('aes-128-cbc', key, zeroIv);
            const cleartext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]);
            const message = parseProtocolJson(new TextDecoder('utf-8', { fatal: true }).decode(cleartext).replace(/\0/g, ''));
            if (!isMessage(message))
                throw new Error();
            return message;
        }
        catch {
            throw new NativeCallBridgeError('invalid-frame');
        }
    }
    function fragment(frame) {
        const parts = /^([a-f0-9]+)#(\d{1,16})#(\d{1,3})#(\d{1,3})#$/i.exec(frame);
        if (!parts)
            throw new NativeCallBridgeError('invalid-frame');
        const [, ciphertext, id, countValue, indexValue] = parts;
        const count = Number(countValue);
        const index = Number(indexValue);
        if (count < 2 || count > Math.ceil(maxCiphertext / fragmentSize) || index >= count ||
            ciphertext.length > fragmentSize || (index < count - 1 && ciphertext.length !== fragmentSize)) {
            throw new NativeCallBridgeError('invalid-frame');
        }
        if (!multipart && index === 0)
            multipart = { id, count, chunks: [] };
        if (!multipart || multipart.id !== id || multipart.count !== count || multipart.chunks.length !== index) {
            throw new NativeCallBridgeError('invalid-frame');
        }
        multipart.chunks.push(ciphertext);
        if (index + 1 !== count)
            return;
        const combined = multipart.chunks.join('');
        multipart = undefined;
        return decrypt(combined);
    }
    function push(chunk) {
        if (closed)
            throw new NativeCallBridgeError('closed');
        pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('latin1');
        const messages = [];
        let offset = 0;
        let delimiter;
        while ((delimiter = pending.indexOf('$', offset)) !== -1) {
            const frame = pending.slice(offset, delimiter);
            offset = delimiter + 1;
            const message = frame.includes('#') ? fragment(frame) : decrypt(frame);
            if (message)
                messages.push(message);
        }
        pending = pending.slice(offset);
        if (pending.length > maxCiphertext)
            throw new NativeCallBridgeError('invalid-frame');
        return messages;
    }
    function close() {
        closed = true;
        pending = '';
        multipart = undefined;
        key.fill(0);
    }
    return { encode, push, close };
}
const desktopMainDigest = '328f2d2c12101b965a738559f6e7c3e48d2e1fd0e956bef4e44fde84e2019c43';
const helperDigest = 'ad1c7b44ab149c9f7697e19c5484072f6facb6edcec4ef9b1cf580ddf80e6101';
async function readExactly(file, size, position) {
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
        const { bytesRead } = await file.read(buffer, offset, size - offset, position + offset);
        if (!bytesRead)
            throw new Error();
        offset += bytesRead;
    }
    return buffer;
}
async function installedSource(appPath = '/Applications/Zalo.app') {
    if (process.platform !== 'darwin' || !isAbsolute(appPath))
        throw new NativeCallBridgeError('unsupported-helper');
    try {
        const executable = join(appPath, 'Contents/ZaloHelper.app/Contents/MacOS/ZaloCall');
        const helperHash = createHash('sha256');
        for await (const chunk of createReadStream(executable))
            helperHash.update(chunk);
        if (helperHash.digest('hex') !== helperDigest)
            throw new Error();
        const file = await open(join(appPath, 'Contents/Resources/app.asar'), 'r');
        try {
            const header = await readExactly(file, 16, 0);
            const headerSize = header.readUInt32LE(4);
            const jsonSize = header.readUInt32LE(12);
            if (jsonSize > 16 * 1024 * 1024 || jsonSize + 8 > headerSize)
                throw new Error();
            const archive = JSON.parse((await readExactly(file, jsonSize, 16)).toString('utf-8'));
            const member = archive.files['main-dist'].files['main.js'];
            const offset = Number(member.offset);
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(member.size) || member.size < 1 ||
                member.size > 16 * 1024 * 1024 || member.integrity?.hash !== desktopMainDigest)
                throw new Error();
            const main = await readExactly(file, member.size, 8 + headerSize + offset);
            if (createHash('sha256').update(main).digest('hex') !== desktopMainDigest)
                throw new Error();
            const matches = [...main.toString('utf-8').matchAll(/\bcallV2TransportAesKey:"([A-Za-z0-9+/]{22}==)"/g)];
            if (matches.length !== 1)
                throw new Error();
            const transportKey = Buffer.from(matches[0][1], 'base64');
            return { executable, args: [], transportKey };
        }
        finally {
            await file.close();
        }
    }
    catch {
        throw new NativeCallBridgeError('unsupported-helper');
    }
}
function listen(server, path) {
    return new Promise((resolve, reject) => {
        const fail = () => reject(new NativeCallBridgeError('startup-failed'));
        server.once('error', fail);
        server.listen(path, () => { server.removeListener('error', fail); resolve(); });
    });
}
function closeServer(server) {
    return new Promise((resolve) => { server.close(() => resolve()); });
}
function boundedTimeout(value, fallback) {
    const timeout = value ?? fallback;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
        throw new RangeError('Invalid native call bridge timeout.');
    return timeout;
}
const responseCommands = { makeCall: 'show', hide: 'hide' };
function responseCommand(message) {
    if (message.type === 'request' && typeof message.command === 'string' && Object.hasOwn(responseCommands, message.command)) {
        return responseCommands[message.command];
    }
}
function responseData(data) {
    if (data && typeof data === 'object') {
        const { error, extendData } = data;
        if (typeof error === 'number' && Number.isSafeInteger(error) && typeof extendData === 'string')
            return { error, extendData };
    }
    throw new NativeCallBridgeError('invalid-response');
}
function validContact(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const { id, name, avatar } = value;
    return typeof id === 'string' && id.length > 0 &&
        (name === undefined || typeof name === 'string') && (avatar === undefined || typeof avatar === 'string');
}
function validRequestData(command, value) {
    if (command !== 'makeCall')
        return value === null;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const { type, partner, groupInfo, isFirstCall } = value;
    if (!Array.isArray(partner) || partner.length === 0 || !Array.from(partner).every(validContact) ||
        (isFirstCall !== undefined && typeof isFirstCall !== 'boolean'))
        return false;
    if (type === 1 || type === 3)
        return partner.length === 1 && groupInfo === undefined;
    return (type === 5 || type === 6) && validContact(groupInfo);
}
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
/** Starts the helper on two new private Unix sockets. This does not send any call or media commands. */
export async function startNativeCallBridge(options = {}) {
    const { signal, onMessage, source } = options;
    const startupTimeout = boundedTimeout(options.startupTimeoutMs, 5_000);
    const ackTimeout = boundedTimeout(options.ackTimeoutMs, 5_000);
    if (signal?.aborted)
        throw new NativeCallBridgeError('aborted');
    if (process.platform === 'win32')
        throw new NativeCallBridgeError('unsupported-helper');
    const helper = source?.kind === 'external' ? source : await installedSource(source?.appPath);
    if (!isAbsolute(helper.executable))
        throw new TypeError('Supply an absolute native helper executable path.');
    const codec = createNativeCallCodec(helper.transportKey);
    if (source?.kind !== 'external')
        helper.transportKey.fill(0);
    let directory;
    try {
        directory = await mkdtemp(join(tmpdir(), 'zcb-'));
    }
    catch {
        codec.close();
        throw new NativeCallBridgeError('startup-failed');
    }
    const incomingPath = join(directory, 'in');
    const outgoingPath = join(directory, 'out');
    let incoming;
    let outgoing;
    let child;
    let nativeReady = false;
    let stopped = false;
    let sendQueue = Promise.resolve();
    let startupTimer;
    let pendingAck;
    const pendingReplies = new Map();
    const uncorrelated = new Map();
    const startup = deferred();
    const closed = deferred();
    const childExited = deferred();
    // A socket error can happen before both binds are ready.
    void startup.promise.catch(() => { });
    function shutdown(reason) {
        if (stopped)
            return closed.promise;
        stopped = true;
        signal?.removeEventListener('abort', abort);
        clearTimeout(startupTimer);
        startup.reject(reason ?? new NativeCallBridgeError('closed'));
        pendingAck?.finish(reason ?? new NativeCallBridgeError('closed'));
        for (const reply of pendingReplies.values())
            reply?.fail(reason ?? new NativeCallBridgeError('closed'));
        pendingReplies.clear();
        uncorrelated.clear();
        codec.close();
        incoming?.destroy();
        outgoing?.destroy();
        const timer = child && setTimeout(() => { child?.kill('SIGKILL'); }, 500);
        child?.kill('SIGTERM');
        void Promise.all([closeServer(reader), closeServer(writer), child ? childExited.promise : Promise.resolve()])
            .then(() => rm(directory, { recursive: true, force: true }))
            .then(() => closed.resolve(reason), () => closed.resolve(reason ?? new NativeCallBridgeError('disconnected')))
            .finally(() => clearTimeout(timer));
        return closed.promise;
    }
    const abort = () => { void shutdown(new NativeCallBridgeError('aborted')); };
    const disconnected = () => { void shutdown(new NativeCallBridgeError('disconnected')); };
    function maybeReady() {
        if (nativeReady && outgoing) {
            clearTimeout(startupTimer);
            startup.resolve();
        }
    }
    function forgetUncorrelated(command) {
        const count = uncorrelated.get(command) ?? 0;
        if (count <= 1)
            uncorrelated.delete(command);
        else
            uncorrelated.set(command, count - 1);
    }
    function receiveResponse(message) {
        const command = message.command;
        if (message.type !== 'response' || (command !== 'show' && command !== 'hide'))
            return;
        if (!pendingReplies.has(command)) {
            forgetUncorrelated(command);
            return;
        }
        const reply = pendingReplies.get(command);
        pendingReplies.delete(command);
        reply?.receive(message.data);
    }
    const reader = createServer((socket) => {
        if (stopped || incoming) {
            socket.destroy();
            return;
        }
        incoming = socket;
        socket.once('error', disconnected);
        socket.once('close', disconnected);
        socket.on('data', (chunk) => {
            let messages;
            try {
                messages = codec.push(chunk);
            }
            catch {
                void shutdown(new NativeCallBridgeError('invalid-frame'));
                return;
            }
            for (const message of messages) {
                receiveResponse(message);
                if (message.type === 'update' && message.command === 'native-ready') {
                    nativeReady = true;
                    maybeReady();
                }
                if (onMessage) {
                    const fail = () => { void shutdown(new NativeCallBridgeError('handler-failed')); };
                    try {
                        void Promise.resolve(onMessage(message)).catch(fail);
                    }
                    catch {
                        fail();
                        break;
                    }
                }
            }
        });
    });
    const writer = createServer((socket) => {
        if (stopped || outgoing) {
            socket.destroy();
            return;
        }
        outgoing = socket;
        socket.once('error', disconnected);
        socket.once('close', disconnected);
        socket.on('data', (chunk) => {
            const ack = pendingAck;
            if (!ack) {
                void shutdown(new NativeCallBridgeError('invalid-frame'));
                return;
            }
            ack.bytes += chunk.toString('latin1');
            if (!'ack'.startsWith(ack.bytes)) {
                void shutdown(new NativeCallBridgeError('invalid-frame'));
                return;
            }
            if (ack.bytes === 'ack')
                ack.finish();
        });
        maybeReady();
    });
    async function write(message) {
        if (stopped || !outgoing)
            throw new NativeCallBridgeError('closed');
        for (const frame of codec.encode(message)) {
            if (stopped || outgoing.destroyed)
                throw new NativeCallBridgeError('closed');
            const socket = outgoing;
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => { void shutdown(new NativeCallBridgeError('ack-timeout')); }, ackTimeout);
                pendingAck = {
                    bytes: '',
                    finish(error) {
                        clearTimeout(timer);
                        pendingAck = undefined;
                        if (error)
                            reject(error);
                        else
                            resolve();
                    },
                };
                socket.write(frame, (error) => { if (error)
                    disconnected(); });
            });
        }
    }
    function enqueue(message) {
        const pending = sendQueue.then(() => write(message));
        sendQueue = pending.catch(() => { });
        return pending;
    }
    async function request(command, data, requestOptions = {}) {
        if (stopped)
            throw new NativeCallBridgeError('closed');
        if (!Object.hasOwn(responseCommands, command) || !validRequestData(command, data))
            throw new NativeCallBridgeError('invalid-message');
        const expected = responseCommands[command];
        if (pendingReplies.has(expected) || uncorrelated.has(expected))
            throw new NativeCallBridgeError('request-pending');
        const { signal: requestSignal } = requestOptions;
        if (requestSignal?.aborted)
            throw new NativeCallBridgeError('aborted');
        const timeout = boundedTimeout(requestOptions.timeoutMs, 10_000);
        const result = deferred();
        const expire = (code) => {
            // Native replies have no correlation ID. Consume an eventual late reply before reusing this name.
            pendingReplies.set(expected, undefined);
            settle(new NativeCallBridgeError(code));
        };
        const cancel = () => expire('aborted');
        const timer = setTimeout(() => expire('response-timeout'), timeout);
        function settle(error, value) {
            clearTimeout(timer);
            requestSignal?.removeEventListener('abort', cancel);
            if (error)
                result.reject(error);
            else
                result.resolve(value);
        }
        const reply = {
            receive(value) {
                try {
                    settle(undefined, responseData(value));
                }
                catch (error) {
                    settle(error);
                }
            },
            fail(error) { settle(error); },
        };
        pendingReplies.set(expected, reply);
        requestSignal?.addEventListener('abort', cancel, { once: true });
        void enqueue({ type: 'request', command, data }).catch((error) => {
            if (pendingReplies.get(expected) === reply) {
                pendingReplies.delete(expected);
                reply.fail(error);
            }
        });
        return result.promise;
    }
    try {
        if (signal?.aborted)
            throw new NativeCallBridgeError('aborted');
        // macOS sockaddr_un leaves 103 bytes for a path plus its terminator.
        if (Buffer.byteLength(outgoingPath) > 103)
            throw new NativeCallBridgeError('startup-failed');
        await listen(reader, incomingPath);
        await listen(writer, outgoingPath);
        reader.on('error', disconnected);
        writer.on('error', disconnected);
        if (signal?.aborted)
            throw new NativeCallBridgeError('aborted');
        signal?.addEventListener('abort', abort, { once: true });
        startupTimer = setTimeout(() => { void shutdown(new NativeCallBridgeError('startup-timeout')); }, startupTimeout);
        child = spawn(helper.executable, [...helper.args ?? [], incomingPath, outgoingPath], { cwd: directory, stdio: 'ignore' });
        child.once('error', () => { void shutdown(new NativeCallBridgeError('startup-failed')); });
        child.once('close', () => { childExited.resolve(); disconnected(); });
        await startup.promise;
        if (stopped)
            throw await closed.promise ?? new NativeCallBridgeError('closed');
    }
    catch (error) {
        const failure = error instanceof NativeCallBridgeError ? error : new NativeCallBridgeError('startup-failed');
        await shutdown(failure);
        throw failure;
    }
    return {
        async send(message) {
            const expected = responseCommand(message);
            if (!expected)
                return enqueue(message);
            if (pendingReplies.has(expected))
                throw new NativeCallBridgeError('request-pending');
            uncorrelated.set(expected, (uncorrelated.get(expected) ?? 0) + 1);
            try {
                await enqueue(message);
            }
            catch (error) {
                forgetUncorrelated(expected);
                throw error;
            }
        },
        request,
        async close() { await shutdown(); },
        closed: closed.promise,
    };
}
