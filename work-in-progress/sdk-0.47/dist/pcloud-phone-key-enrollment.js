import { createPrivateKey, createPublicKey } from 'node:crypto';
import { createPCloudResourceDecoder, PCloudResourceError } from './pcloud-resource.js';
import { phoneBase64, phoneBytes, phoneDigest, phoneError, phoneFailure, phoneFields, phoneInteger, phoneText, openPhoneEnrollment, sealPhoneEnrollment, validateEnrollmentMetadata } from './pcloud-phone-key-state.js';
function rsa(key) {
    const bits = key.asymmetricKeyDetails?.modulusLength;
    if (key.asymmetricKeyType !== 'rsa' || typeof bits !== 'number' || !Number.isSafeInteger(bits) || bits < 1024 || bits > 8192)
        throw phoneError('invalid-key', 'key');
}
/** Explicit canonical PKCS1-v0 structure; Node accepts mislabeled/trailing DER. */
function pkcs1(input) {
    let offset = 0;
    const tlv = (tag, limit) => {
        if (offset + 2 > limit || input[offset++] !== tag)
            throw phoneError('invalid-key', 'key');
        let n = input[offset++];
        if (n & 0x80) {
            const count = n & 0x7f;
            if (!count || count > 4 || offset + count > limit || input[offset] === 0)
                throw phoneError('invalid-key', 'key');
            n = 0;
            for (let i = 0; i < count; i++)
                n = n * 256 + input[offset++];
            if (n < 128)
                throw phoneError('invalid-key', 'key');
        }
        const start = offset, end = start + n;
        if (end > limit)
            throw phoneError('invalid-key', 'key');
        return { start, end };
    };
    const outer = tlv(0x30, input.length);
    if (outer.end !== input.length)
        throw phoneError('invalid-key', 'key');
    for (let i = 0; i < 9; i++) {
        const v = tlv(2, outer.end), n = v.end - v.start;
        if (!n || input[v.start] & 0x80 || (n > 1 && input[v.start] === 0 && !(input[v.start + 1] & 0x80)))
            throw phoneError('invalid-key', 'key');
        if (i === 0 ? n !== 1 || input[v.start] !== 0 : n === 1 && input[v.start] === 0)
            throw phoneError('invalid-key', 'key');
        offset = v.end;
    }
    if (offset !== outer.end)
        throw phoneError('invalid-key', 'key');
}
/** @internal Standard-format conversion only; native phone interoperability is unverified. */
export function convertPCloudPhoneKey(plaintext, publicKey) {
    let textBytes, input, pub, canonical, privateDer, derived;
    try {
        textBytes = phoneBytes(plaintext, 21_848, 1);
        const text = textBytes.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(textBytes))
            throw phoneError('invalid-key', 'key');
        input = phoneBase64(text, 16 * 1024);
        pkcs1(input);
        const key = createPrivateKey({ key: input, format: 'der', type: 'pkcs1' });
        rsa(key);
        canonical = key.export({ format: 'der', type: 'pkcs1' });
        if (!canonical.equals(input))
            throw phoneError('invalid-key', 'key');
        privateDer = key.export({ format: 'der', type: 'pkcs8' });
        if (publicKey.kind === 'over-limit')
            throw phoneError('limit-exceeded', 'key');
        if (publicKey.kind !== 'text')
            throw phoneError('invalid-key', 'key');
        pub = phoneBase64(publicKey.value, 2 * 1024);
        const publicObject = createPublicKey({ key: pub, format: 'der', type: 'spki' });
        if (publicObject.asymmetricKeyType !== 'rsa')
            throw phoneError('invalid-key', 'key');
        const publicCanonical = publicObject.export({ format: 'der', type: 'spki' });
        try {
            if (!publicCanonical.equals(pub))
                throw phoneError('invalid-key', 'key');
        }
        finally {
            publicCanonical.fill(0);
        }
        derived = createPublicKey(key).export({ format: 'der', type: 'spki' });
        if (!derived.equals(pub))
            throw phoneError('key-mismatch', 'key');
        const result = { privateDer, publicDer: pub };
        privateDer = undefined;
        pub = undefined;
        return result;
    }
    catch (error) {
        const own = phoneFailure(error);
        throw phoneError(own?.code === 'limit-exceeded' ? 'limit-exceeded' : own?.code === 'key-mismatch' ? 'key-mismatch' : 'invalid-key', 'key');
    }
    finally {
        textBytes?.fill(0);
        input?.fill(0);
        pub?.fill(0);
        canonical?.fill(0);
        privateDer?.fill(0);
        derived?.fill(0);
    }
}
function validateEnrollmentRsa(privateDer, publicDer) {
    let canonical, canonicalPublic, derived, innerPkcs1;
    try {
        const key = createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' });
        rsa(key);
        canonical = key.export({ format: 'der', type: 'pkcs8' });
        if (!canonical.equals(privateDer))
            throw phoneError('invalid-key', 'key');
        // Canonical PKCS8 can contain multiprime RSA; retain the incoming two-prime subset.
        innerPkcs1 = key.export({ format: 'der', type: 'pkcs1' });
        pkcs1(innerPkcs1);
        const pub = createPublicKey({ key: publicDer, format: 'der', type: 'spki' });
        if (pub.asymmetricKeyType !== 'rsa')
            throw phoneError('invalid-key', 'key');
        const bits = pub.asymmetricKeyDetails?.modulusLength;
        if (typeof bits !== 'number' || bits < 1024 || bits > 8192)
            throw phoneError('invalid-key', 'key');
        canonicalPublic = pub.export({ format: 'der', type: 'spki' });
        if (!canonicalPublic.equals(publicDer))
            throw phoneError('invalid-key', 'key');
        derived = createPublicKey(key).export({ format: 'der', type: 'spki' });
        if (!derived.equals(publicDer))
            throw phoneError('key-mismatch', 'key');
    }
    catch (error) {
        throw phoneError(phoneFailure(error)?.code === 'key-mismatch' ? 'key-mismatch' : 'invalid-key', 'key');
    }
    finally {
        canonical?.fill(0);
        canonicalPublic?.fill(0);
        derived?.fill(0);
        innerPkcs1?.fill(0);
    }
}
const owners = new WeakMap();
function snapshot(m) {
    const version = Object.freeze({ present: m.keyVersion.present, ...(Object.hasOwn(m.keyVersion, 'known') ? { known: m.keyVersion.known } : {}) });
    return Object.freeze({ enrollmentId: m.enrollmentId, identityBinding: m.identityBinding, localDeviceId: 2, phoneDeviceId: 0,
        phoneIdentityFingerprint: phoneDigest(Buffer.from(m.phoneIdentityKey, 'base64')), keyVersion: version, publicSpkiSha256: m.publicSpkiSha256, nativeInteroperability: 'unverified' });
}
/** @internal Receives owned standard DER only; does not obtain or publish a key. */
export function createOwnedPCloudPhoneEnrollment(value) {
    let privateDer, publicDer;
    try {
        const metadata = validateEnrollmentMetadata(value.metadata);
        privateDer = phoneBytes(value.privateDer, 16 * 1024, 1);
        publicDer = phoneBytes(value.publicDer, 2 * 1024, 1);
        if (phoneDigest(publicDer) !== metadata.publicSpkiSha256)
            throw phoneError('invalid-state');
        validateEnrollmentRsa(privateDer, publicDer);
        const decoder = createPCloudResourceDecoder(privateDer, { publicSpkiDer: publicDer });
        const owner = { metadata, privateDer, publicDer, decoder, disposed: false, metadataSnapshot: snapshot(metadata) };
        const handle = {
            get metadata() { const state = owners.get(this); if (!state)
                throw phoneError('invalid-input'); return state.metadataSnapshot; },
            openResource(ciphertext, capsule, algorithm) {
                const state = owners.get(this);
                if (!state)
                    throw new PCloudResourceError('invalid-decoder', 'resource');
                if (state.disposed)
                    throw new PCloudResourceError('disposed', 'resource');
                return state.decoder.openResource(ciphertext, capsule, algorithm);
            },
            openMetadata(info, capsule) {
                const state = owners.get(this);
                if (!state)
                    throw new PCloudResourceError('invalid-decoder', 'metadata');
                if (state.disposed)
                    throw new PCloudResourceError('disposed', 'metadata');
                return state.decoder.openMetadata(info, capsule);
            },
            sealState(key) {
                const state = owners.get(this);
                if (!state)
                    throw phoneError('invalid-input');
                if (state.disposed)
                    throw phoneError('disposed');
                let captured;
                try {
                    captured = phoneBytes(key, 32, 32);
                }
                catch {
                    throw phoneError('invalid-input');
                }
                try {
                    return sealPhoneEnrollment(state, captured);
                }
                finally {
                    captured.fill(0);
                }
            },
            dispose() {
                const state = owners.get(this);
                if (!state)
                    throw phoneError('invalid-input');
                if (state.disposed)
                    return;
                state.disposed = true;
                state.privateDer.fill(0);
                state.publicDer.fill(0);
                state.decoder.dispose();
            },
        };
        owners.set(handle, owner);
        privateDer = undefined;
        publicDer = undefined;
        return Object.freeze(handle);
    }
    catch (error) {
        const own = phoneFailure(error);
        if (own?.stage === 'key' && (own.code === 'invalid-key' || own.code === 'key-mismatch'))
            throw phoneError(own.code, 'key');
        throw phoneError('invalid-state');
    }
    finally {
        privateDer?.fill(0);
        publicDer?.fill(0);
    }
}
export function restorePCloudPhoneKeyEnrollment(sealed, wrappingKey, expected) {
    let key, pin, opened;
    let accountId, binding, registration;
    try {
        try {
            key = phoneBytes(wrappingKey, 32, 32);
            const row = phoneFields(expected, ['accountId', 'identityBinding', 'trustedPhoneIdentityKey', 'trustedPhoneRegistrationId'], ['accountId', 'identityBinding', 'trustedPhoneIdentityKey']);
            accountId = phoneText(row.accountId, 32, 1);
            binding = phoneText(row.identityBinding, 64, 64);
            if (!/^\d+$/.test(accountId) || !/^[0-9a-f]{64}$/.test(binding))
                throw 0;
            pin = phoneBytes(row.trustedPhoneIdentityKey, 33, 33);
            if (pin[0] !== 5)
                throw 0;
            registration = row.trustedPhoneRegistrationId === undefined ? undefined : phoneInteger(row.trustedPhoneRegistrationId, 0xffff_ffff, 1);
        }
        catch {
            throw phoneError('invalid-input');
        }
        opened = openPhoneEnrollment(sealed, key);
        const m = opened.metadata;
        if (m.accountId !== accountId || m.identityBinding !== binding || m.phoneIdentityKey !== pin.toString('base64') || m.phoneRegistrationId !== registration)
            throw phoneError('identity-mismatch');
        return createOwnedPCloudPhoneEnrollment(opened);
    }
    finally {
        key?.fill(0);
        pin?.fill(0);
        opened?.privateDer.fill(0);
        opened?.publicDer.fill(0);
    }
}
