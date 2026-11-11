import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { advanceE2eeChain, decodeE2eeFrame, deriveE2eeDirectKeys, deriveE2eeRatchet, encodeE2eeFrame } from './e2ee.js';
import { calculateE2eeX25519Agreement, generateE2eeX25519KeyPair, getE2eeX25519PublicKey } from './e2ee-key-agreement.js';
import { encodeE2eeDirectBody, isE2eePublicKey, readE2eeDirectBody } from './e2ee-protobuf.js';
import { directMaxCounter as maxCounter, directMaxRetired as maxRetiredRatchets, directMaxSkipped as defaultMaxSkipped, openDirectSessionState, sealDirectSessionState, } from './e2ee-session-state.js';
export { E2eeDirectSessionStateError } from './e2ee-session-state.js';
const errorMessages = {
    'invalid-frame': 'Invalid Zalo E2EE direct frame.',
    'authentication-failed': 'Zalo E2EE message authentication failed.',
    'missing-receive-chain': 'This Zalo E2EE session has no established receiving chain.',
    'unknown-ratchet': 'The message uses a ratchet key outside this established Zalo E2EE chain.',
    'replayed': 'The Zalo E2EE message key was consumed or is no longer available.',
    'counter-too-far': 'The Zalo E2EE message counter exceeds the receive limit.',
    'counter-exhausted': 'The Zalo E2EE sending counter is exhausted.',
};
export class E2eeDirectSessionError extends Error {
    code;
    constructor(code) {
        super(errorMessages[code]);
        this.code = code;
        this.name = 'E2eeDirectSessionError';
    }
}
let receiveOwned;
let hasReceiveOwned;
let receiveFailureOwned;
function uint32(value) {
    if (!Number.isInteger(value) || value < 0 || value > maxCounter) {
        throw new TypeError('Zalo E2EE counters must be uint32 values.');
    }
    return value;
}
function publicKey(value) {
    if (!isE2eePublicKey(value))
        throw new TypeError('Zalo E2EE public keys require the 33-byte Curve25519 encoding.');
    return Buffer.from(value);
}
function chainState(input) {
    if (!(input.chainKey instanceof Uint8Array) || input.chainKey.length !== 32) {
        throw new TypeError('Zalo E2EE chain keys must contain 32 bytes.');
    }
    const nextCounter = input.nextCounter ?? 0;
    if (!Number.isInteger(nextCounter) || nextCounter < 0 || nextCounter > maxCounter + 1) {
        throw new TypeError('A Zalo E2EE chain needs a uint32 counter or its exhausted successor.');
    }
    return {
        ratchetPublicKey: publicKey(input.ratchetPublicKey),
        chainKey: Buffer.from(input.chainKey),
        nextCounter,
    };
}
function directBody(value) {
    try {
        const frame = decodeE2eeFrame(value);
        if (frame.kind === 'direct')
            return readE2eeDirectBody(frame.body);
    }
    catch {
        // Report the same error for malformed base64 and malformed protobuf.
    }
    throw new E2eeDirectSessionError('invalid-frame');
}
function stageReceiveKeys(chain, lastCounter) {
    let nextChainKey = chain.chainKey;
    const seeds = new Map();
    try {
        for (let counter = chain.nextCounter; counter <= lastCounter; counter++) {
            const step = advanceE2eeChain(nextChainKey);
            if (nextChainKey !== chain.chainKey)
                nextChainKey.fill(0);
            nextChainKey = step.nextChainKey;
            seeds.set(counter, step.messageSeed);
        }
        return { nextChainKey, seeds };
    }
    catch (error) {
        if (nextChainKey !== chain.chainKey)
            nextChainKey.fill(0);
        for (const seed of seeds.values())
            seed.fill(0);
        throw error;
    }
}
function discardStagedKeys(keys) {
    if (!keys)
        return;
    keys.nextChainKey.fill(0);
    for (const seed of keys.seeds.values())
        seed.fill(0);
}
function chainIdentifier(publicKeyBytes) {
    return Buffer.from(publicKeyBytes).toString('base64');
}
function directMac(macKey, sender, receiver, body) {
    return createHmac('sha256', macKey).update(sender).update(receiver).update(body).digest().subarray(0, 8);
}
function clearMessageKeys(keys) {
    keys.cipherKey.fill(0);
    keys.macKey.fill(0);
    keys.iv.fill(0);
}
/**
 * Experimental version-3 direct session. Supply ratchet state to follow later DH turns.
 * Use each sending chain in a single instance.
 */
export class E2eeDirectSession {
    #localIdentityKey;
    #remoteIdentityKey;
    #send;
    #receive;
    #ratchet;
    #previousCounter;
    #maxSkipped;
    #skipped = new Map();
    #retired = new Set();
    #receiveFailures = new WeakMap();
    constructor(options) {
        const maxSkipped = options.maxSkippedMessages ?? defaultMaxSkipped;
        if (!Number.isInteger(maxSkipped) || maxSkipped < 0 || maxSkipped > defaultMaxSkipped) {
            throw new TypeError('maxSkippedMessages must be an integer between 0 and 2000.');
        }
        this.#localIdentityKey = publicKey(options.localIdentityKey);
        this.#remoteIdentityKey = publicKey(options.remoteIdentityKey);
        this.#previousCounter = uint32(options.sendChain.previousCounter ?? 0);
        this.#send = chainState(options.sendChain);
        this.#receive = options.receiveChain === undefined ? undefined : chainState(options.receiveChain);
        if (this.#receive && this.#send.chainKey.equals(this.#receive.chainKey)) {
            throw new TypeError('Zalo E2EE sending and receiving chains require distinct keys.');
        }
        if (options.ratchet) {
            const { localPrivateKey, rootKey } = options.ratchet;
            if (!(rootKey instanceof Uint8Array) || rootKey.length !== 32 ||
                !getE2eeX25519PublicKey(localPrivateKey).equals(this.#send.ratchetPublicKey)) {
                throw new TypeError('Zalo E2EE ratchet state must match the sending chain.');
            }
            this.#ratchet = { rootKey: Buffer.from(rootKey), localPrivateKey };
        }
        this.#maxSkipped = maxSkipped;
    }
    /** The sending chain's last counter, or -1 before the first message. */
    get lastSentCounter() { return this.#send.nextCounter - 1; }
    get localIdentityKey() { return Buffer.from(this.#localIdentityKey); }
    get remoteIdentityKey() { return Buffer.from(this.#remoteIdentityKey); }
    /**
     * Seals the current state with a caller-held 32-byte key. Save the state
     * after encrypting and before sending. Restore only the latest checkpoint.
     */
    sealState(wrappingKey) {
        const retired = Array.from(this.#retired, (id) => Buffer.from(id, 'base64'));
        const skipped = Array.from(this.#skipped, ([slot, seed]) => {
            const separator = slot.indexOf(':');
            return {
                ratchetPublicKey: Buffer.from(slot.slice(0, separator), 'base64'),
                counter: Number(slot.slice(separator + 1)),
                seed,
            };
        });
        return sealDirectSessionState({
            localIdentityKey: this.#localIdentityKey,
            remoteIdentityKey: this.#remoteIdentityKey,
            send: this.#send,
            receive: this.#receive,
            ratchet: this.#ratchet,
            previousCounter: this.#previousCounter,
            maxSkipped: this.#maxSkipped,
            retired,
            skipped,
        }, wrappingKey);
    }
    /** Restores one trusted checkpoint for exclusive use by a single writer. */
    static restoreSealedState(sealed, wrappingKey) {
        return openDirectSessionState(sealed, wrappingKey, (state) => {
            const session = new E2eeDirectSession({
                localIdentityKey: state.localIdentityKey,
                remoteIdentityKey: state.remoteIdentityKey,
                sendChain: { ...state.send, previousCounter: state.previousCounter },
                receiveChain: state.receive,
                ratchet: state.ratchet,
                maxSkippedMessages: state.maxSkipped,
            });
            for (const key of state.retired)
                session.#retired.add(chainIdentifier(key));
            for (const { ratchetPublicKey, counter, seed } of state.skipped) {
                session.#skipped.set(`${chainIdentifier(ratchetPublicKey)}:${counter}`, Buffer.from(seed));
            }
            return session;
        });
    }
    encrypt(plaintext) {
        const counter = this.#send.nextCounter;
        if (counter > maxCounter)
            throw new E2eeDirectSessionError('counter-exhausted');
        if (typeof plaintext !== 'string' && !(plaintext instanceof Uint8Array)) {
            throw new TypeError('Supply a Zalo E2EE plaintext string or byte array.');
        }
        const { messageSeed, nextChainKey } = advanceE2eeChain(this.#send.chainKey);
        const keys = deriveE2eeDirectKeys(messageSeed);
        let committed = false;
        try {
            const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
            const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
            const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
            const body = encodeE2eeDirectBody(this.#send.ratchetPublicKey, counter, this.#previousCounter, ciphertext);
            const mac = directMac(keys.macKey, this.#localIdentityKey, this.#remoteIdentityKey, body);
            const frame = encodeE2eeFrame({ kind: 'direct', body: Buffer.concat([body, mac]) });
            this.#send.chainKey.fill(0);
            this.#send.chainKey = nextChainKey;
            this.#send.nextCounter++;
            committed = true;
            return frame;
        }
        finally {
            clearMessageKeys(keys);
            messageSeed.fill(0);
            if (!committed)
                nextChainKey.fill(0);
        }
    }
    static {
        receiveOwned = (session, ciphertext) => session.#decrypt(ciphertext);
        hasReceiveOwned = session => session.#receive !== undefined;
        receiveFailureOwned = (session, error) => session.#receiveFailures.get(error);
    }
    #receiveFailure(code) {
        const error = new E2eeDirectSessionError(code);
        this.#receiveFailures.set(error, code);
        return error;
    }
    decrypt(ciphertext) { return this.#decrypt(ciphertext); }
    #decrypt(ciphertext) {
        const receive = this.#receive;
        if (!receive && !this.#ratchet)
            throw this.#receiveFailure('missing-receive-chain');
        const body = directBody(ciphertext);
        const id = chainIdentifier(body.ratchetPublicKey);
        if (receive?.ratchetPublicKey.equals(body.ratchetPublicKey)) {
            if (body.counter < receive.nextCounter)
                return this.#openSkipped(body, id);
            return this.#decryptAndAdvance(body, receive, id);
        }
        if (this.#retired.has(id))
            return this.#openSkipped(body, id);
        const ratchet = this.#ratchet;
        // A peer can only ratchet against the current local key after we have sent it.
        if (!ratchet || this.#send.nextCounter === 0)
            throw this.#receiveFailure('unknown-ratchet');
        return this.#decryptWithNewRatchet(body, id, ratchet);
    }
    #openSkipped(body, id) {
        const cacheKey = `${id}:${body.counter}`;
        const seed = this.#skipped.get(cacheKey);
        if (!seed)
            throw this.#receiveFailure('replayed');
        const plaintext = this.#open(body, seed);
        this.#skipped.delete(cacheKey);
        seed.fill(0);
        return plaintext;
    }
    #authenticateNext(body, receive) {
        const distance = body.counter - receive.nextCounter + 1;
        if (distance > Math.min(this.#maxSkipped + 1, defaultMaxSkipped)) {
            throw this.#receiveFailure('counter-too-far');
        }
        const staged = stageReceiveKeys(receive, body.counter);
        const targetSeed = staged.seeds.get(body.counter);
        try {
            const plaintext = this.#open(body, targetSeed);
            staged.seeds.delete(body.counter);
            return { staged, plaintext };
        }
        catch (error) {
            discardStagedKeys(staged);
            throw error;
        }
        finally {
            targetSeed.fill(0);
        }
    }
    #cacheSkipped(id, seeds) {
        for (const [counter, seed] of seeds)
            this.#skipped.set(`${id}:${counter}`, seed);
        while (this.#skipped.size > this.#maxSkipped) {
            const oldest = this.#skipped.keys().next().value;
            this.#skipped.get(oldest).fill(0);
            this.#skipped.delete(oldest);
        }
    }
    #decryptAndAdvance(body, receive, id) {
        const { plaintext, staged } = this.#authenticateNext(body, receive);
        receive.chainKey.fill(0);
        receive.chainKey = staged.nextChainKey;
        receive.nextCounter = body.counter + 1;
        this.#cacheSkipped(id, staged.seeds);
        return plaintext;
    }
    #retireReceive(id, tail) {
        this.#retired.add(id);
        if (tail) {
            tail.nextChainKey.fill(0);
            this.#cacheSkipped(id, tail.seeds);
        }
        if (this.#retired.size <= maxRetiredRatchets)
            return;
        const oldest = this.#retired.keys().next().value;
        this.#retired.delete(oldest);
        for (const [key, seed] of this.#skipped) {
            if (key.startsWith(`${oldest}:`)) {
                seed.fill(0);
                this.#skipped.delete(key);
            }
        }
    }
    #decryptWithNewRatchet(body, id, ratchet) {
        const oldReceive = this.#receive;
        const skippedTailCount = oldReceive ? body.previousCounter - oldReceive.nextCounter + 1 : 0;
        if (skippedTailCount > this.#maxSkipped)
            throw this.#receiveFailure('counter-too-far');
        const previousCounter = this.#send.nextCounter - 1;
        const secrets = [];
        let tail;
        let opened;
        let committed = false;
        try {
            const incomingDh = calculateE2eeX25519Agreement(ratchet.localPrivateKey, body.ratchetPublicKey);
            secrets.push(incomingDh);
            const incoming = deriveE2eeRatchet(ratchet.rootKey, incomingDh);
            secrets.push(incoming.rootKey, incoming.chainKey);
            const receive = {
                ratchetPublicKey: Buffer.from(body.ratchetPublicKey), chainKey: incoming.chainKey, nextCounter: 0,
            };
            opened = this.#authenticateNext(body, receive);
            if (oldReceive && skippedTailCount > 0)
                tail = stageReceiveKeys(oldReceive, body.previousCounter);
            const local = generateE2eeX25519KeyPair();
            const outgoingDh = calculateE2eeX25519Agreement(local.privateKey, body.ratchetPublicKey);
            secrets.push(outgoingDh);
            const outgoing = deriveE2eeRatchet(incoming.rootKey, outgoingDh);
            if (oldReceive) {
                oldReceive.chainKey.fill(0);
                this.#retireReceive(chainIdentifier(oldReceive.ratchetPublicKey), tail);
            }
            ratchet.rootKey.fill(0);
            this.#send.chainKey.fill(0);
            this.#send = { ratchetPublicKey: local.publicKey, chainKey: outgoing.chainKey, nextCounter: 0 };
            this.#receive = { ...receive, chainKey: opened.staged.nextChainKey, nextCounter: body.counter + 1 };
            this.#previousCounter = previousCounter;
            this.#ratchet = { rootKey: outgoing.rootKey, localPrivateKey: local.privateKey };
            this.#cacheSkipped(id, opened.staged.seeds);
            committed = true;
            return opened.plaintext;
        }
        finally {
            for (const secret of secrets)
                secret.fill(0);
            if (!committed) {
                discardStagedKeys(tail);
                discardStagedKeys(opened?.staged);
                opened?.plaintext.fill(0);
            }
        }
    }
    #open(body, seed) {
        const keys = deriveE2eeDirectKeys(seed);
        try {
            const expected = directMac(keys.macKey, this.#remoteIdentityKey, this.#localIdentityKey, body.authenticatedBody);
            if (!timingSafeEqual(expected, body.mac))
                throw this.#receiveFailure('authentication-failed');
            const decipher = createDecipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
            return Buffer.concat([decipher.update(body.ciphertext), decipher.final()]);
        }
        catch {
            throw this.#receiveFailure('authentication-failed');
        }
        finally {
            clearMessageKeys(keys);
        }
    }
}
const sessionSeal = E2eeDirectSession.prototype.sealState;
const sessionEncrypt = E2eeDirectSession.prototype.encrypt;
const localIdentity = Object.getOwnPropertyDescriptor(E2eeDirectSession.prototype, 'localIdentityKey').get;
const remoteIdentity = Object.getOwnPropertyDescriptor(E2eeDirectSession.prototype, 'remoteIdentityKey').get;
/** @internal Exact private-field receivers; public errors do not authorize another candidate. */
export const ownedDirectSession = Object.freeze({
    restore: E2eeDirectSession.restoreSealedState,
    encrypt: (session, plaintext) => Reflect.apply(sessionEncrypt, session, [plaintext]),
    decrypt: (session, ciphertext) => receiveOwned(session, ciphertext),
    hasReceiveChain: (session) => hasReceiveOwned(session),
    seal: (session, key) => Reflect.apply(sessionSeal, session, [key]),
    localIdentity: (session) => Reflect.apply(localIdentity, session, []),
    remoteIdentity: (session) => Reflect.apply(remoteIdentity, session, []),
    failure: (session, error) => {
        if (!error || (typeof error !== 'object' && typeof error !== 'function'))
            return;
        return receiveFailureOwned(session, error);
    },
});
