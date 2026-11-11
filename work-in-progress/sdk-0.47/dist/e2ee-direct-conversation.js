import { prepareE2eeInitiator, wrapE2eePreKeyMessage } from './e2ee-key-agreement.js';
import { isE2eePublicKey, readE2eeDirectBody, readE2eePreKeyBody } from './e2ee-protobuf.js';
import { createE2eeStateCodec } from './e2ee-sealed-state.js';
import { E2eeDirectSession, ownedDirectSession } from './e2ee-session.js';
import { decodeE2eeFrame, encodeE2eeFrame } from './e2ee.js';
const errors = {
    'invalid-frame': 'Expected an encrypted Zalo direct or prekey frame.',
    'unexpected-prekey': 'The Zalo prekey envelope belongs to another direct session.',
    'invalid-reply': 'The first Zalo E2EE reply must use the peer’s fresh sending ratchet.',
    'registration-mismatch': 'The Zalo prekey envelope registration differs from the expected peer registration.',
    'invalid-state': 'Invalid sealed Zalo E2EE conversation state.',
    'invalid-wrapping-key': 'The Zalo E2EE state wrapping key must contain 32 bytes.',
};
export class E2eeDirectConversationError extends Error {
    code;
    constructor(code) {
        super(errors[code]);
        this.code = code;
        this.name = 'E2eeDirectConversationError';
    }
}
let conversationInfo;
let conversationReceive;
let conversationEncrypt;
let conversationMatches;
const baseOffset = 9;
const publicKeySize = 33;
const receiverSize = baseOffset + publicKeySize;
const initiatorSize = receiverSize + publicKeySize + 8;
const conversationPrefix = 'zalo-e2ee-conversation.v1.';
const lineagePrefix = 'zalo-e2ee-conversation.v2.';
/** @internal Exact codec ceiling, including purpose and encoded AEAD overhead. */
export const directConversationSealedMaximum = conversationPrefix.length + Math.ceil((initiatorSize + 192 * 1024 + 28) / 3) * 4;
const codec = createE2eeStateCodec(conversationPrefix, baseOffset + 1, initiatorSize + 192 * 1024, (code) => new E2eeDirectConversationError(code));
const lineageCodec = createE2eeStateCodec(lineagePrefix, receiverSize + 1, initiatorSize + 192 * 1024, (code) => new E2eeDirectConversationError(code));
function registration(value) {
    if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff)
        throw new TypeError('Invalid Zalo registration ID.');
    return value;
}
function invalidState() { throw new E2eeDirectConversationError('invalid-state'); }
function parseFrame(ciphertext) {
    try {
        const frame = decodeE2eeFrame(ciphertext);
        if (frame.kind === 'direct')
            return { kind: frame.kind, fields: readE2eeDirectBody(frame.body) };
        if (frame.kind === 'pre-key')
            return { kind: frame.kind, fields: readE2eePreKeyBody(frame.body) };
    }
    catch { /* Keep ciphertext out of errors. */ }
    throw new E2eeDirectConversationError('invalid-frame');
}
/** Inspects the public routing fields of a prekey envelope. These fields are untrusted. */
export function inspectE2eePreKeyRouting(ciphertext) {
    const frame = parseFrame(ciphertext);
    if (frame.kind !== 'pre-key')
        return;
    const { identityKey, baseKey, registrationId } = frame.fields;
    return { identityKey: Buffer.from(identityKey), baseKey: Buffer.from(baseKey), registrationId };
}
/** A single direct ratchet for one peer device, including the prekey envelope lifecycle. */
export class E2eeDirectConversation {
    #session;
    #localRegistrationId;
    #remoteRegistrationId;
    #phase;
    #origin;
    constructor(session, localRegistrationId, remoteRegistrationId, phase, origin) {
        this.#session = session;
        this.#localRegistrationId = registration(localRegistrationId);
        this.#remoteRegistrationId = registration(remoteRegistrationId);
        this.#phase = phase;
        this.#origin = origin ?? (phase.kind === 'established' ? { kind: 'unknown' }
            : { kind: phase.kind === 'initiating' ? 'ours' : 'theirs', baseKey: Buffer.from(phase.baseKey) });
    }
    static initiate(options) {
        const localRegistrationId = registration(options.localRegistrationId);
        const remoteRegistrationId = registration(options.peerBundle.registrationId);
        const state = prepareE2eeInitiator(options);
        try {
            const session = new E2eeDirectSession({
                localIdentityKey: state.localIdentityKey, remoteIdentityKey: state.remoteIdentityKey, sendChain: state.sendChain,
                ratchet: { rootKey: state.rootKey, localPrivateKey: state.ratchetPrivateKey },
                maxSkippedMessages: options.maxSkippedMessages,
            });
            const { baseKey, signedPreKeyId, preKeyId } = state.pendingPreKey;
            return new E2eeDirectConversation(session, localRegistrationId, remoteRegistrationId, {
                kind: 'initiating', baseKey: Buffer.from(baseKey), remoteSignedKey: state.remoteSignedPreKey, signedPreKeyId, preKeyId,
            });
        }
        finally {
            state.rootKey.fill(0);
            state.sendChain.chainKey.fill(0);
        }
    }
    static accept(ciphertext, options) {
        const routing = inspectE2eePreKeyRouting(ciphertext);
        if (!routing)
            throw new E2eeDirectConversationError('invalid-frame');
        const remoteRegistrationId = registration(routing.registrationId);
        if (options.trustedRemoteRegistrationId !== undefined && remoteRegistrationId !== registration(options.trustedRemoteRegistrationId)) {
            throw new E2eeDirectConversationError('registration-mismatch');
        }
        const result = options.privateKeys.openInitialPreKeyMessage(ciphertext, options);
        result.rootKey.fill(0);
        return {
            conversation: new E2eeDirectConversation(result.session, result.localRegistrationId, remoteRegistrationId, {
                kind: 'receiving', baseKey: result.remoteBaseKey,
            }),
            plaintext: result.plaintext,
        };
    }
    get localRegistrationId() { return this.#localRegistrationId; }
    /** Peer registration for delivery routing. Inbound envelopes do not authenticate this field. */
    get remoteRegistrationId() { return this.#remoteRegistrationId; }
    get remoteIdentityKey() { return this.#session.remoteIdentityKey; }
    get pendingPreKey() { return this.#phase.kind === 'initiating'; }
    get acceptedRemoteBaseKey() {
        return this.#phase.kind === 'receiving' ? Buffer.from(this.#phase.baseKey) : undefined;
    }
    encrypt(plaintext) {
        return this.#encrypt(plaintext);
    }
    #encrypt(plaintext) {
        const direct = ownedDirectSession.encrypt(this.#session, plaintext);
        if (this.#phase.kind !== 'initiating')
            return direct;
        return wrapE2eePreKeyMessage(direct, {
            ...this.#phase, identityKey: ownedDirectSession.localIdentity(this.#session), registrationId: this.#localRegistrationId,
        });
    }
    static {
        conversationInfo = conversation => ({ localRegistrationId: conversation.#localRegistrationId,
            remoteRegistrationId: conversation.#remoteRegistrationId,
            ...(conversation.#phase.kind === 'receiving' ? { acceptedRemoteBaseKey: Buffer.from(conversation.#phase.baseKey) } : {}),
            phase: conversation.#phase.kind,
            origin: conversation.#origin.kind === 'unknown' ? { kind: 'unknown' }
                : { kind: conversation.#origin.kind, baseKey: Buffer.from(conversation.#origin.baseKey) },
            hasReceiveChain: ownedDirectSession.hasReceiveChain(conversation.#session) });
        conversationEncrypt = (conversation, plaintext) => conversation.#encrypt(plaintext);
        conversationMatches = (conversation, expected) => expected.localRegistrationIds.has(conversation.#localRegistrationId)
            && ownedDirectSession.localIdentity(conversation.#session).equals(Buffer.from(expected.localIdentityKey))
            && ownedDirectSession.remoteIdentity(conversation.#session).equals(Buffer.from(expected.remoteIdentityKey))
            && (expected.remoteRegistrationId === undefined || conversation.#remoteRegistrationId === expected.remoteRegistrationId);
        conversationReceive = (conversation, ciphertext) => {
            // This is a private candidate rejection, not public Error code authority.
            // The public decrypt operation retains its invalid-first-reply behavior.
            const frame = parseFrame(ciphertext), phase = conversation.#phase;
            if (frame.kind === 'direct' && phase.kind === 'initiating' && phase.remoteSignedKey.equals(frame.fields.ratchetPublicKey))
                return { kind: 'miss' };
            try {
                return { kind: 'opened', plaintext: conversation.#decrypt(ciphertext) };
            }
            catch (error) {
                const code = ownedDirectSession.failure(conversation.#session, error);
                if (code === 'replayed')
                    return { kind: 'replayed' };
                if (code === 'authentication-failed' || code === 'unknown-ratchet' || code === 'counter-too-far')
                    return { kind: 'miss' };
                throw error;
            }
        };
    }
    decrypt(ciphertext) { return this.#decrypt(ciphertext); }
    #decrypt(ciphertext) {
        const frame = parseFrame(ciphertext);
        const phase = this.#phase;
        if (frame.kind === 'pre-key') {
            const { baseKey, identityKey, innerBody } = frame.fields;
            if (phase.kind !== 'receiving' || !phase.baseKey.equals(baseKey) || !ownedDirectSession.remoteIdentity(this.#session).equals(identityKey)) {
                throw new E2eeDirectConversationError('unexpected-prekey');
            }
            return ownedDirectSession.decrypt(this.#session, encodeE2eeFrame({ kind: 'direct', body: innerBody }));
        }
        if (phase.kind === 'initiating' && phase.remoteSignedKey.equals(frame.fields.ratchetPublicKey)) {
            throw new E2eeDirectConversationError('invalid-reply');
        }
        const plaintext = ownedDirectSession.decrypt(this.#session, ciphertext);
        if (phase.kind === 'initiating')
            this.#phase = { kind: 'established' };
        return plaintext;
    }
    /** Save the latest conversation and its prepared ciphertext atomically before delivery. */
    sealState(wrappingKey) {
        if (!(wrappingKey instanceof Uint8Array) || wrappingKey.length !== 32)
            throw new E2eeDirectConversationError('invalid-wrapping-key');
        const phase = this.#phase;
        const inner = ownedDirectSession.seal(this.#session, wrappingKey);
        const origin = this.#origin;
        const ours = origin.kind === 'ours';
        const offset = phase.kind === 'initiating' ? initiatorSize : phase.kind === 'receiving' || ours ? receiverSize : baseOffset;
        return (ours ? lineageCodec : codec).seal(offset + inner.length, wrappingKey, (state) => {
            state[0] = phase.kind === 'initiating' ? 1 : phase.kind === 'receiving' ? 2 : ours ? 3 : 0;
            state.writeUInt32BE(this.#localRegistrationId, 1);
            state.writeUInt32BE(this.#remoteRegistrationId, 5);
            if (phase.kind !== 'established')
                state.set(phase.baseKey, baseOffset);
            else if (origin.kind === 'ours')
                state.set(origin.baseKey, baseOffset);
            if (phase.kind === 'initiating') {
                state.set(phase.remoteSignedKey, receiverSize);
                state.writeUInt32BE(phase.signedPreKeyId, initiatorSize - 8);
                state.writeUInt32BE(phase.preKeyId ?? 0, initiatorSize - 4);
            }
            state.write(inner, offset, 'ascii');
        });
    }
    static restoreSealedState(sealed, wrappingKey) {
        const version2 = typeof sealed === 'string' && sealed.startsWith(lineagePrefix);
        return (version2 ? lineageCodec : codec).open(sealed, wrappingKey, (state) => {
            const kind = state[0];
            const offset = kind === 1 ? initiatorSize : kind === 2 || kind === 3 ? receiverSize : baseOffset;
            if ((version2 ? kind !== 1 && kind !== 3 : kind > 2) || state.length <= offset)
                invalidState();
            const inner = state.subarray(offset).toString('utf8');
            const session = ownedDirectSession.restore(inner, wrappingKey);
            let phase = { kind: 'established' };
            let origin = { kind: 'unknown' };
            if (kind === 1 || kind === 2 || kind === 3) {
                const baseKey = Buffer.from(state.subarray(baseOffset, receiverSize));
                if (!isE2eePublicKey(baseKey))
                    invalidState();
                origin = { kind: kind === 2 ? 'theirs' : 'ours', baseKey: Buffer.from(baseKey) };
                if (kind === 2)
                    phase = { kind: 'receiving', baseKey };
                if (kind === 1) {
                    const remoteSignedKey = Buffer.from(state.subarray(receiverSize, initiatorSize - 8));
                    if (!isE2eePublicKey(remoteSignedKey))
                        invalidState();
                    phase = { kind: 'initiating', baseKey, remoteSignedKey,
                        signedPreKeyId: state.readUInt32BE(initiatorSize - 8), preKeyId: state.readUInt32BE(initiatorSize - 4) || undefined };
                }
            }
            return new E2eeDirectConversation(session, state.readUInt32BE(1), state.readUInt32BE(5), phase, origin);
        });
    }
}
const conversationSeal = E2eeDirectConversation.prototype.sealState;
/** @internal Fixed operations on actual owned candidates; no virtual decrypt or error-name dispatch. */
export const ownedDirectConversation = Object.freeze({
    restore: E2eeDirectConversation.restoreSealedState,
    accept: E2eeDirectConversation.accept,
    info: (conversation) => conversationInfo(conversation),
    encrypt: (conversation, plaintext) => conversationEncrypt(conversation, plaintext),
    receiveSlot: (ciphertext) => {
        const frame = parseFrame(ciphertext);
        const body = frame.kind === 'direct' ? frame.fields : readE2eeDirectBody(frame.fields.innerBody);
        return { ratchetPublicKey: Buffer.from(body.ratchetPublicKey), counter: body.counter };
    },
    receive: (conversation, ciphertext) => conversationReceive(conversation, ciphertext),
    seal: (conversation, key) => Reflect.apply(conversationSeal, conversation, [key]),
});
const boundIdentityFailures = new WeakSet();
/** @internal Only identifies this owner's validated binding mismatch. */
export function isBoundConversationIdentityFailure(value) {
    return !!value && (typeof value === 'object' || typeof value === 'function') && boundIdentityFailures.has(value);
}
/** @internal Purpose-bound import; no general public identity getter. */
export function restoreBoundE2eeDirectConversation(sealed, wrappingKey, expected) {
    const conversation = ownedDirectConversation.restore(sealed, wrappingKey);
    if (!conversationMatches(conversation, expected)) {
        const error = new E2eeDirectConversationError('invalid-state');
        boundIdentityFailures.add(error);
        throw error;
    }
    return conversation;
}
