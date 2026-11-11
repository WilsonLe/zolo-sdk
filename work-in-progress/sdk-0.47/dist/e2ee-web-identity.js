import { createHash, createPrivateKey } from 'node:crypto';
import { getE2eeX25519PublicKey } from './e2ee-key-agreement.js';
export const x25519Pkcs8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
export const ed25519Pkcs8 = Buffer.from('302e020100300506032b657004220420', 'hex');
export function useE2eePrivateBytes(key, prefix, use) {
    const der = key.export({ format: 'der', type: 'pkcs8' });
    try {
        if (der.length !== prefix.length + 32 || !der.subarray(0, prefix.length).equals(prefix))
            throw new Error();
        return use(der.subarray(prefix.length));
    }
    finally {
        der.fill(0);
    }
}
export function importE2eePrivateBytes(prefix, secret) {
    const der = Buffer.concat([prefix, secret]);
    try {
        return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    }
    finally {
        der.fill(0);
    }
}
export function deriveE2eeWebIdentity(signer) {
    // Ed25519 and X25519 clamp the same first 32 bytes of the expanded Ed25519 seed.
    return useE2eePrivateBytes(signer, ed25519Pkcs8, (seed) => {
        const expanded = createHash('sha512').update(seed).digest();
        try {
            const privateKey = importE2eePrivateBytes(x25519Pkcs8, expanded.subarray(0, 32));
            return { privateKey, publicKey: getE2eeX25519PublicKey(privateKey) };
        }
        finally {
            expanded.fill(0);
        }
    });
}
