import { createCipheriv, createDecipheriv, createPrivateKey, generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { generateE2eeCurveSigner, verifyE2eeCurveSignature } from './e2ee-key-agreement.js';
import { encodeE2eeGroupBody, encodeE2eeGroupDistribution, isE2eePublicKey, readE2eeGroupBody, readE2eeGroupDistribution, } from './e2ee-protobuf.js';
import { createE2eeStateCodec } from './e2ee-sealed-state.js';
import { advanceE2eeChain, decodeE2eeFrame, deriveE2eeGroupKeys, encodeE2eeFrame } from './e2ee.js';
const errors = {
    'invalid-distribution': 'Invalid Zalo group sender-key distribution.',
    'invalid-frame': 'Invalid Zalo group ciphertext frame.',
    'key-mismatch': 'The Zalo group frame uses a different sender key.',
    'authentication-failed': 'The Zalo group signature did not verify.',
    replay: 'The Zalo group message was already opened or its key is unavailable.',
    'too-far-ahead': 'The Zalo group message exceeds the skipped-key limit.',
    'counter-exhausted': 'Rotate the Zalo group sender key before sending again.',
    'invalid-state': 'Invalid sealed Zalo E2EE group state.',
    'invalid-wrapping-key': 'The Zalo E2EE state wrapping key must contain 32 bytes.',
};
export class E2eeGroupError extends Error {
    code;
    constructor(code) {
        super(errors[code]);
        this.code = code;
        this.name = 'E2eeGroupError';
    }
}
const maxCounter = 0xffff_ffff;
const maxSenderKeyId = 0xffff;
const maxSkippedKeys = 2_000;
const chainKeyOffset = 4 + 5;
const signingKeyOffset = chainKeyOffset + 32;
const chainStateSize = signingKeyOffset + 33;
const signerDerPrefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const senderStateSize = chainStateSize + signerDerPrefix.length + 32;
const receiverStateSize = chainStateSize + 2 + 2;
const skippedStateSize = 4 + 32;
const senderCheckpoint = createE2eeStateCodec('zalo-e2ee-group-sender.v1.', senderStateSize, senderStateSize, (code) => new E2eeGroupError(code));
const receiverCheckpoint = createE2eeStateCodec('zalo-e2ee-group-receiver.v1.', receiverStateSize, receiverStateSize + maxSkippedKeys * skippedStateSize, (code) => new E2eeGroupError(code));
const restoreSender = Symbol('restore group sender');
function invalidState() { throw new E2eeGroupError('invalid-state'); }
function writeGroupChainState(plaintext, keyId, nextIteration, chainKey, signingKey) {
    plaintext.writeUInt32BE(keyId, 0);
    // The exhausted sentinel is one higher than the largest wire iteration.
    plaintext.writeUIntBE(nextIteration, 4, 5);
    plaintext.set(chainKey, chainKeyOffset);
    plaintext.set(signingKey, signingKeyOffset);
}
function readGroupChainState(plaintext) {
    const keyId = plaintext.readUInt32BE(0);
    const nextIteration = plaintext.readUIntBE(4, 5);
    const chainKey = plaintext.subarray(chainKeyOffset, signingKeyOffset);
    const signingKey = plaintext.subarray(signingKeyOffset, chainStateSize);
    if (nextIteration > maxCounter + 1 || !isE2eePublicKey(signingKey))
        invalidState();
    return { keyId, nextIteration, chainKey, signingKey };
}
function checkSignerDer(der) {
    if (der.length !== signerDerPrefix.length + 32 || !der.subarray(0, signerDerPrefix.length).equals(signerDerPrefix)) {
        invalidState();
    }
}
function readGroupFrame(value) {
    try {
        const frame = decodeE2eeFrame(value);
        if (frame.kind === 'group')
            return readE2eeGroupBody(frame.body);
    }
    catch { /* Report a stable error without copying input. */ }
    throw new E2eeGroupError('invalid-frame');
}
function decryptCiphertext(ciphertext, seed) {
    const { iv, cipherKey } = deriveE2eeGroupKeys(seed);
    try {
        const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }
    catch {
        throw new E2eeGroupError('invalid-frame');
    }
    finally {
        iv.fill(0);
        cipherKey.fill(0);
    }
}
/** Sender key for one sender device in one group. */
export class E2eeGroupSender {
    keyId;
    #signingPrivateKey;
    #signer;
    #chainKey;
    #iteration;
    constructor(restore, snapshot) {
        const state = restore === restoreSender ? snapshot : undefined;
        this.keyId = state?.keyId ?? randomInt(0, maxSenderKeyId + 1);
        this.#signingPrivateKey = state?.privateKey ?? generateKeyPairSync('ed25519').privateKey;
        this.#signer = state?.signer ?? generateE2eeCurveSigner(this.#signingPrivateKey);
        this.#chainKey = state ? Buffer.from(state.chainKey) : randomBytes(32);
        this.#iteration = state?.nextIteration ?? 0;
    }
    /** Seal the latest sender state before publishing ciphertext derived from it. */
    sealState(wrappingKey) {
        return senderCheckpoint.seal(senderStateSize, wrappingKey, (plaintext) => {
            writeGroupChainState(plaintext, this.keyId, this.#iteration, this.#chainKey, this.#signer.publicKey);
            const der = this.#signingPrivateKey.export({ format: 'der', type: 'pkcs8' });
            try {
                checkSignerDer(der);
                plaintext.set(der, chainStateSize);
            }
            finally {
                der.fill(0);
            }
        });
    }
    /** Restore the most recent sender checkpoint from the application's single-writer store. */
    static restoreSealedState(sealed, wrappingKey) {
        return senderCheckpoint.open(sealed, wrappingKey, (plaintext) => {
            const { keyId, nextIteration, chainKey, signingKey } = readGroupChainState(plaintext);
            if (keyId > maxSenderKeyId)
                invalidState();
            const der = plaintext.subarray(chainStateSize);
            checkSignerDer(der);
            const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
            const signer = generateE2eeCurveSigner(privateKey);
            if (!signer.publicKey.equals(signingKey))
                invalidState();
            return new E2eeGroupSender(restoreSender, { keyId, nextIteration, chainKey, privateKey, signer });
        });
    }
    /** Secret distribution bytes. Deliver through an authenticated pairwise session to each recipient. */
    distribution() {
        this.#requireIteration();
        return encodeE2eeGroupDistribution(this.keyId, this.#iteration, this.#chainKey, this.#signer.publicKey);
    }
    encrypt(plaintext) {
        this.#requireIteration();
        if (typeof plaintext !== 'string' && !(plaintext instanceof Uint8Array)) {
            throw new TypeError('Supply a Zalo E2EE plaintext string or byte array.');
        }
        const { messageSeed, nextChainKey } = advanceE2eeChain(this.#chainKey);
        const { iv, cipherKey } = deriveE2eeGroupKeys(messageSeed);
        let committed = false;
        try {
            const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
            const bytes = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
            const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
            const body = encodeE2eeGroupBody(this.keyId, this.#iteration, ciphertext);
            const value = encodeE2eeFrame({ kind: 'group', body: Buffer.concat([body, this.#signer.sign(body)]) });
            this.#chainKey.fill(0);
            this.#chainKey = nextChainKey;
            this.#iteration++;
            committed = true;
            return value;
        }
        finally {
            messageSeed.fill(0);
            iv.fill(0);
            cipherKey.fill(0);
            if (!committed)
                nextChainKey.fill(0);
        }
    }
    #requireIteration() {
        if (this.#iteration > maxCounter)
            throw new E2eeGroupError('counter-exhausted');
    }
}
/** Opens group messages from a previously authenticated pairwise distribution. */
export class E2eeGroupReceiver {
    keyId;
    #signingKey;
    #maxSkipped;
    #skipped = new Map();
    #chainKey;
    #nextIteration;
    constructor(distribution, options = {}) {
        const limit = options.maxSkippedMessages ?? maxSkippedKeys;
        if (!Number.isInteger(limit) || limit < 0 || limit > maxSkippedKeys)
            throw new RangeError('Invalid Zalo group skipped-key limit.');
        let parsed;
        try {
            parsed = readE2eeGroupDistribution(distribution);
        }
        catch {
            throw new E2eeGroupError('invalid-distribution');
        }
        this.keyId = parsed.keyId;
        this.#signingKey = Buffer.from(parsed.signingKey);
        this.#chainKey = Buffer.from(parsed.chainKey);
        this.#nextIteration = parsed.iteration;
        this.#maxSkipped = limit;
    }
    /** Seal the current receiver and its remaining skipped keys before acknowledging messages. */
    sealState(wrappingKey) {
        return receiverCheckpoint.seal(receiverStateSize + this.#skipped.size * skippedStateSize, wrappingKey, (plaintext) => {
            writeGroupChainState(plaintext, this.keyId, this.#nextIteration, this.#chainKey, this.#signingKey);
            plaintext.writeUInt16BE(this.#maxSkipped, chainStateSize);
            plaintext.writeUInt16BE(this.#skipped.size, chainStateSize + 2);
            let offset = receiverStateSize;
            for (const [iteration, seed] of this.#skipped) {
                plaintext.writeUInt32BE(iteration, offset);
                plaintext.set(seed, offset + 4);
                offset += skippedStateSize;
            }
        });
    }
    /** Restore one receiver for one authenticated sender key and group. */
    static restoreSealedState(sealed, wrappingKey) {
        return receiverCheckpoint.open(sealed, wrappingKey, (plaintext) => {
            const { keyId, nextIteration, chainKey, signingKey } = readGroupChainState(plaintext);
            const maxSkippedMessages = plaintext.readUInt16BE(chainStateSize);
            const count = plaintext.readUInt16BE(chainStateSize + 2);
            if (maxSkippedMessages > maxSkippedKeys || count > maxSkippedMessages ||
                plaintext.length !== receiverStateSize + count * skippedStateSize)
                invalidState();
            const skipped = new Map();
            let previous = -1;
            for (let offset = receiverStateSize; offset < plaintext.length; offset += skippedStateSize) {
                const iteration = plaintext.readUInt32BE(offset);
                if (iteration <= previous || iteration >= nextIteration)
                    invalidState();
                skipped.set(iteration, plaintext.subarray(offset + 4, offset + skippedStateSize));
                previous = iteration;
            }
            const distribution = encodeE2eeGroupDistribution(keyId, Math.min(nextIteration, maxCounter), chainKey, signingKey);
            try {
                const receiver = new E2eeGroupReceiver(distribution, { maxSkippedMessages });
                receiver.#nextIteration = nextIteration;
                for (const [iteration, seed] of skipped)
                    receiver.#skipped.set(iteration, Buffer.from(seed));
                return receiver;
            }
            finally {
                distribution.fill(0);
            }
        });
    }
    decrypt(value) {
        const frame = readGroupFrame(value);
        if (frame.keyId !== this.keyId)
            throw new E2eeGroupError('key-mismatch');
        if (!verifyE2eeCurveSignature(this.#signingKey, frame.authenticatedBody, frame.signature)) {
            throw new E2eeGroupError('authentication-failed');
        }
        if (frame.iteration < this.#nextIteration) {
            const seed = this.#skipped.get(frame.iteration);
            if (!seed)
                throw new E2eeGroupError('replay');
            const plaintext = decryptCiphertext(frame.ciphertext, seed);
            this.#skipped.delete(frame.iteration);
            seed.fill(0);
            return plaintext;
        }
        if (frame.iteration - this.#nextIteration > this.#maxSkipped)
            throw new E2eeGroupError('too-far-ahead');
        return this.#decryptAhead(frame);
    }
    #decryptAhead(frame) {
        const missed = new Map();
        let chain = Buffer.from(this.#chainKey);
        let seed;
        let committed = false;
        try {
            for (let index = this.#nextIteration; index <= frame.iteration; index++) {
                const step = advanceE2eeChain(chain);
                chain.fill(0);
                chain = step.nextChainKey;
                if (index === frame.iteration)
                    seed = step.messageSeed;
                else
                    missed.set(index, step.messageSeed);
            }
            if (!seed)
                throw new E2eeGroupError('invalid-frame');
            const plaintext = decryptCiphertext(frame.ciphertext, seed);
            this.#chainKey.fill(0);
            this.#chainKey = chain;
            this.#nextIteration = frame.iteration + 1;
            for (const [iteration, key] of missed)
                this.#skipped.set(iteration, key);
            while (this.#skipped.size > this.#maxSkipped) {
                const oldest = this.#skipped.keys().next().value;
                if (oldest === undefined)
                    break;
                this.#skipped.get(oldest)?.fill(0);
                this.#skipped.delete(oldest);
            }
            committed = true;
            return plaintext;
        }
        finally {
            seed?.fill(0);
            if (!committed) {
                chain.fill(0);
                for (const key of missed.values())
                    key.fill(0);
            }
        }
    }
}
