import { createCipheriv, randomBytes } from 'node:crypto';
import { openOwnedMediaResource } from './media-resource-crypto.js';
import { preparedE2eeCiphertext, preparedE2eeInteger, sendPreparedDirect, sendPreparedGroup } from './e2ee-prepared-delivery.js';
function optionalCiphertext(value, group) {
    return value === undefined || value === '' ? value : preparedE2eeCiphertext(value, group);
}
function gifFields(value, presentation, group) {
    return {
        thumb: optionalCiphertext(value.thumbnail, group) ?? '',
        width: preparedE2eeInteger(presentation.width, 1),
        height: preparedE2eeInteger(presentation.height, 1),
        prmE2EE: preparedE2eeCiphertext(value.parameters, group),
        msg: '',
        type: 0,
        href: preparedE2eeCiphertext(value.url, group),
        src: preparedE2eeInteger(presentation.source ?? -1, -1),
        action: 'recommend.gif',
    };
}
function photoFields(value, group) {
    return {
        title: optionalCiphertext(value.title, group),
        thumbUrl: optionalCiphertext(value.thumbnail, group),
        prmE2EE: preparedE2eeCiphertext(value.parameters, group),
        [group ? 'oriUrl' : 'normalUrl']: preparedE2eeCiphertext(value.url, group),
    };
}
/** Submits catalog GIF metadata encrypted for each direct recipient device. */
export async function sendPreparedE2eeDirectGif(api, input) {
    return sendPreparedDirect(api, 'gif', input, (recipient) => gifFields(recipient, input, false));
}
/** Submits catalog GIF metadata encrypted by an established group sender key. */
export async function sendPreparedE2eeGroupGif(api, input) {
    return sendPreparedGroup(api, 'gif', input, gifFields(input, input, true), input.visibility ?? 0);
}
/** Submits the URL-based photo record encrypted for each direct recipient device. */
export async function sendPreparedE2eeDirectPhotoByUrl(api, input) {
    return sendPreparedDirect(api, 'photo', input, (recipient) => photoFields(recipient, false));
}
/** Submits the URL-based photo record encrypted by an established group sender key. */
export async function sendPreparedE2eeGroupPhotoByUrl(api, input) {
    return sendPreparedGroup(api, 'photo', input, photoFields(input, true));
}
const maxFileBytes = 16 * 1024 * 1024;
const keySize = 32;
const ivSize = 12;
const tagSize = 16;
const mediaTypedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const mediaByteLength = Object.getOwnPropertyDescriptor(mediaTypedPrototype, 'byteLength').get;
const mediaSet = Uint8Array.prototype.set;
function mediaBytes(value) {
    if (!(value instanceof Uint8Array) || value.length === 0 || value.length > maxFileBytes) {
        throw new TypeError('Supply a Zalo E2EE media byte array of 1 byte to 16 MiB.');
    }
}
/** Encrypts the installed client's linear file format with fresh AES-256-GCM key material. */
export function sealE2eeMediaFile(plaintext) {
    mediaBytes(plaintext);
    const key = randomBytes(keySize);
    const iv = randomBytes(ivSize);
    let material;
    try {
        const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: tagSize });
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        material = Buffer.concat([key, iv, cipher.getAuthTag()]);
        return { ciphertext, fileKey: material.toString('base64') };
    }
    finally {
        key.fill(0);
        material?.fill(0);
    }
}
/** Opens raw linear file bytes with key material obtained from an authenticated message. */
export function openE2eeMediaFile(ciphertext, fileKey) {
    mediaBytes(ciphertext);
    // 32-byte key, 12-byte IV, 16-byte tag, encoded with standard unpadded-by-length base64.
    if (typeof fileKey !== 'string' || !/^[A-Za-z0-9+/]{80}$/.test(fileKey)) {
        throw new TypeError('Invalid Zalo E2EE media key encoding.');
    }
    const material = Buffer.from(fileKey, 'base64');
    let input;
    try {
        // Snapshot native byte slots, never Buffer.from's caller valueOf/coercion.
        // The public legacy admission and its TypeError messages remain above.
        const length = Reflect.apply(mediaByteLength, ciphertext, []);
        if (length > maxFileBytes)
            throw new Error();
        input = Buffer.alloc(length);
        Reflect.apply(mediaSet, input, [ciphertext]);
        const result = openOwnedMediaResource(input, material, '1');
        if (result.kind !== 'plaintext')
            throw new Error();
        return result.plaintext;
    }
    catch {
        throw new Error('Zalo E2EE media authentication failed.');
    }
    finally {
        input?.fill(0);
        material.fill(0);
    }
}
