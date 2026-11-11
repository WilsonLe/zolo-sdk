import { Buffer } from 'node:buffer';
import { constants, createPrivateKey, createPublicKey, privateDecrypt } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { openOwnedMediaResource } from './media-resource-crypto.js';
const messages = Object.freeze({
    'invalid-input': 'Supply supported PCloud resource decoder input.',
    'limit-exceeded': 'The PCloud resource decoder input exceeds its size limit.',
    'invalid-key': 'Supply a supported canonical PKCS8 RSA key and optional SPKI key.',
    'key-mismatch': 'The supplied PCloud RSA public and private keys do not match.',
    'invalid-decoder': 'Use the original owned PCloud resource decoder receiver.',
    'invalid-capsule': 'The PCloud encrypted capsule was not recognized.',
    'decryption-failed': 'The PCloud capsule could not be decrypted.',
    'authentication-failed': 'The PCloud resource failed GCM authentication.',
    'invalid-metadata': 'The authenticated PCloud metadata is not valid UTF-8.',
    disposed: 'The PCloud resource decoder is disposed.',
    'crypto-failed': 'PCloud resource cryptography could not be completed.',
});
export class PCloudResourceError extends Error {
    code;
    stage;
    constructor(code, stage) {
        super(messages[code]);
        this.code = code;
        this.stage = stage;
        this.name = 'PCloudResourceError';
    }
}
const privateFailures = new WeakMap();
function fail(code) {
    const marker = Object.freeze({});
    privateFailures.set(marker, code);
    throw marker;
}
function outward(error, stage) {
    const code = error !== null && (typeof error === 'object' || typeof error === 'function')
        ? privateFailures.get(error) : undefined;
    return new PCloudResourceError(code ?? 'crypto-failed', stage);
}
const maxPrivateDer = 16 * 1024, maxPublicDer = 2 * 1024, maxResource = 16 * 1024 * 1024;
const maxMetadata = 2 * 1024 * 1024, maxRsaCiphertext = 1024;
const isView = ArrayBuffer.isView;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag).get;
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength').get;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer').get;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const typedSet = Uint8Array.prototype.set;
const oaepPadding = constants.RSA_PKCS1_OAEP_PADDING;
function snapshot(value, maximum, minimum = 0) {
    let length;
    try {
        if (!isView(value) || Reflect.apply(typedTag, value, []) !== 'Uint8Array')
            return fail('invalid-input');
        length = Reflect.apply(typedLength, value, []);
        // The ArrayBuffer intrinsic rejects SharedArrayBuffer, including cross-realm
        // buffers, without walking a caller-controlled prototype or property.
        Reflect.apply(arrayBufferLength, Reflect.apply(typedBuffer, value, []), []);
    }
    catch {
        return fail('invalid-input');
    }
    if (length > maximum)
        return fail('limit-exceeded');
    if (length < minimum)
        return fail('invalid-input');
    let copied;
    try {
        copied = Buffer.alloc(length);
        Reflect.apply(typedSet, copied, [value]);
        return copied;
    }
    catch {
        copied?.fill(0);
        return fail('invalid-input');
    }
}
function publicInput(settings) {
    try {
        if (!settings || typeof settings !== 'object' || isProxy(settings) || Array.isArray(settings))
            return fail('invalid-input');
        const proto = Object.getPrototypeOf(settings);
        if (proto !== Object.prototype && proto !== null)
            return fail('invalid-input');
        const keys = Reflect.ownKeys(settings);
        if (keys.some((key) => key !== 'publicSpkiDer'))
            return fail('invalid-input');
        const descriptor = Object.getOwnPropertyDescriptor(settings, 'publicSpkiDer');
        if (!descriptor)
            return;
        if (!Object.hasOwn(descriptor, 'value'))
            return fail('invalid-input');
        return descriptor.value;
    }
    catch {
        return fail('invalid-input');
    }
}
function modulusWidth(key) {
    if (key.asymmetricKeyType !== 'rsa')
        return fail('invalid-key');
    const bits = key.asymmetricKeyDetails?.modulusLength;
    if (typeof bits !== 'number' || !Number.isSafeInteger(bits) || bits < 1024 || bits > 8192)
        return fail('invalid-key');
    return Math.ceil(bits / 8);
}
function importPrivate(input) {
    let canonical;
    try {
        const key = createPrivateKey({ key: input, format: 'der', type: 'pkcs8' });
        const width = modulusWidth(key);
        canonical = key.export({ format: 'der', type: 'pkcs8' });
        if (!canonical.equals(input))
            return fail('invalid-key');
        return { key, width };
    }
    catch {
        return fail('invalid-key');
    }
    finally {
        canonical?.fill(0);
    }
}
function matchPublic(input, privateKey) {
    let canonical, derived;
    let equal = false;
    try {
        try {
            const key = createPublicKey({ key: input, format: 'der', type: 'spki' });
            modulusWidth(key);
            canonical = key.export({ format: 'der', type: 'spki' });
            if (!canonical.equals(input))
                return fail('invalid-key');
            derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
            equal = canonical.equals(derived);
        }
        catch {
            return fail('invalid-key');
        }
        if (!equal)
            return fail('key-mismatch');
    }
    finally {
        canonical?.fill(0);
        derived?.fill(0);
    }
}
function base64(value, maximum, bad, allowEmpty = false) {
    if (typeof value !== 'string')
        return fail(bad);
    if (value.length > Math.ceil(maximum / 3) * 4)
        return fail('limit-exceeded');
    if ((!value && !allowEmpty) || /^[A-Za-z0-9+/]*={0,2}$/.exec(value)?.[0] !== value)
        return fail(bad);
    let decoded, transferred = false;
    try {
        decoded = Buffer.from(value, 'base64');
        if (decoded.length > maximum)
            return fail('limit-exceeded');
        const canonical = decoded.toString('base64');
        if (value !== canonical && value !== canonical.replace(/=+$/, ''))
            return fail(bad);
        transferred = true;
        return decoded;
    }
    finally {
        if (!transferred)
            decoded?.fill(0);
    }
}
function unwrap(input, key, width, version) {
    if (input.length !== width)
        return fail('invalid-capsule');
    let capsule;
    try {
        capsule = privateDecrypt({ key, padding: oaepPadding, oaepHash: 'sha256', oaepLabel: Buffer.alloc(0) }, input);
    }
    catch {
        return fail('decryption-failed');
    }
    if (capsule.length !== (version === '1' ? 60 : 48)) {
        capsule.fill(0);
        return fail('invalid-capsule');
    }
    return capsule;
}
function metadataText(input) {
    const text = input.toString('utf8'), encoded = Buffer.from(text, 'utf8');
    try {
        if (!encoded.equals(input))
            return fail('invalid-metadata');
        return text;
    }
    finally {
        encoded.fill(0);
    }
}
function makeDecoder(privateKey, width) {
    let ownedKey = privateKey;
    privateKey = undefined; // No second retained binding bypasses disposal.
    const receiver = (value) => { if (value !== owner)
        return fail('invalid-decoder'); };
    const active = () => { if (!ownedKey)
        return fail('disposed'); return ownedKey; };
    const owner = Object.freeze({
        openResource(ciphertext, encryptedCapsuleBase64, algorithmVersion) {
            let input, encrypted, capsule, plaintext;
            let transferred = false;
            try {
                receiver(this);
                active();
                if (algorithmVersion !== '1' && algorithmVersion !== '2')
                    return fail('invalid-input');
                input = snapshot(ciphertext, maxResource);
                encrypted = base64(encryptedCapsuleBase64, maxRsaCiphertext, 'invalid-capsule');
                capsule = unwrap(encrypted, active(), width, algorithmVersion);
                const result = openOwnedMediaResource(input, capsule, algorithmVersion);
                if (result.kind === 'failure')
                    return fail(result.reason);
                plaintext = result.plaintext;
                active();
                const opened = algorithmVersion === '1'
                    ? Object.freeze({ algorithmVersion: '1', gcmAuthenticated: true, plaintext })
                    : Object.freeze({ algorithmVersion: '2', gcmAuthenticated: false, plaintext });
                transferred = true;
                return opened;
            }
            catch (error) {
                throw outward(error, 'resource');
            }
            finally {
                input?.fill(0);
                encrypted?.fill(0);
                capsule?.fill(0);
                if (!transferred)
                    plaintext?.fill(0);
            }
        },
        openMetadata(encryptedInfoBase64, encryptedCapsuleBase64) {
            let input, encrypted, capsule, plaintext;
            try {
                receiver(this);
                active();
                input = base64(encryptedInfoBase64, maxMetadata, 'invalid-input', true);
                encrypted = base64(encryptedCapsuleBase64, maxRsaCiphertext, 'invalid-capsule');
                capsule = unwrap(encrypted, active(), width, '1');
                const result = openOwnedMediaResource(input, capsule, '1');
                if (result.kind === 'failure')
                    return fail(result.reason);
                plaintext = result.plaintext;
                const text = metadataText(plaintext);
                active();
                return text;
            }
            catch (error) {
                throw outward(error, 'metadata');
            }
            finally {
                input?.fill(0);
                encrypted?.fill(0);
                capsule?.fill(0);
                plaintext?.fill(0);
            }
        },
        dispose() {
            try {
                receiver(this);
                ownedKey = undefined;
            }
            catch (error) {
                throw outward(error, 'state');
            }
        },
    });
    return owner;
}
/**
 * Imports caller-supplied canonical DER into a private offline decoder. No key
 * generation, provider key lookup, URL handling or persistence occurs. Owned
 * byte copies are wiped; physical erasure of Node KeyObjects is not promised.
 */
export function createPCloudResourceDecoder(privatePkcs8Der, settings = {}) {
    let privateDer, publicDer;
    try {
        privateDer = snapshot(privatePkcs8Der, maxPrivateDer, 1);
        const selected = publicInput(settings);
        if (selected !== undefined)
            publicDer = snapshot(selected, maxPublicDer, 1);
        const imported = importPrivate(privateDer);
        if (publicDer)
            matchPublic(publicDer, imported.key);
        return makeDecoder(imported.key, imported.width);
    }
    catch (error) {
        throw outward(error, 'key');
    }
    finally {
        privateDer?.fill(0);
        publicDer?.fill(0);
    }
}
