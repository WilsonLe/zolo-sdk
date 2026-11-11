import { createCipheriv, randomBytes } from 'node:crypto';
import type { API } from '#zca';
import { openOwnedMediaResource } from './media-resource-crypto.js';
import { preparedE2eeCiphertext, preparedE2eeInteger, sendPreparedDirect, sendPreparedGroup } from './e2ee-prepared-delivery.js';
import type {
  PreparedE2eeAddress, PreparedE2eeDeliveryResult, PreparedE2eeDirectSubmission, PreparedE2eeGroupSubmission,
} from './e2ee-prepared-delivery.js';

interface GifCiphertext {
  /** Independently encrypted original media URL. */
  url: string;
  /** Independently encrypted preview URL. Omit for a blank preview. */
  thumbnail?: string;
  /** Independently encrypted JSON containing the original width and height. */
  parameters: string;
}

interface GifPresentation {
  width: number;
  height: number;
  /** Zalo recommendation source. Defaults to the observed unknown source, -1. */
  source?: number;
}

interface PhotoByUrlCiphertext {
  /** Independently encrypted title. Omit if no title is available. */
  title?: string;
  /** Independently encrypted original photo URL. */
  url: string;
  /** Independently encrypted preview URL. Omit if no preview is available. */
  thumbnail?: string;
  /** Independently encrypted JSON containing the photo's width, height, and optional `hd` URL. */
  parameters: string;
}

export interface PreparedE2eeDirectGifRecipient extends PreparedE2eeAddress, GifCiphertext {}
export interface PreparedE2eeDirectGif extends PreparedE2eeDirectSubmission<PreparedE2eeDirectGifRecipient>, GifPresentation {}
export interface PreparedE2eeGroupGif extends PreparedE2eeGroupSubmission, GifCiphertext, GifPresentation {
  visibility?: number;
}
export interface PreparedE2eeDirectPhotoByUrlRecipient extends PreparedE2eeAddress, PhotoByUrlCiphertext {}
export interface PreparedE2eeDirectPhotoByUrl extends PreparedE2eeDirectSubmission<PreparedE2eeDirectPhotoByUrlRecipient> {}
export interface PreparedE2eeGroupPhotoByUrl extends PreparedE2eeGroupSubmission, PhotoByUrlCiphertext {}
export interface PreparedE2eeMediaResult extends PreparedE2eeDeliveryResult {}

function optionalCiphertext(value: string | undefined, group: boolean): string | undefined {
  return value === undefined || value === '' ? value : preparedE2eeCiphertext(value, group);
}

function gifFields(value: GifCiphertext, presentation: GifPresentation, group: boolean) {
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

function photoFields(value: PhotoByUrlCiphertext, group: boolean) {
  return {
    title: optionalCiphertext(value.title, group),
    thumbUrl: optionalCiphertext(value.thumbnail, group),
    prmE2EE: preparedE2eeCiphertext(value.parameters, group),
    [group ? 'oriUrl' : 'normalUrl']: preparedE2eeCiphertext(value.url, group),
  };
}

/** Submits catalog GIF metadata encrypted for each direct recipient device. */
export async function sendPreparedE2eeDirectGif(api: API, input: PreparedE2eeDirectGif): Promise<PreparedE2eeMediaResult | undefined> {
  return sendPreparedDirect(api, 'gif', input, (recipient) => gifFields(recipient, input, false));
}

/** Submits catalog GIF metadata encrypted by an established group sender key. */
export async function sendPreparedE2eeGroupGif(api: API, input: PreparedE2eeGroupGif): Promise<PreparedE2eeMediaResult | undefined> {
  return sendPreparedGroup(api, 'gif', input, gifFields(input, input, true), input.visibility ?? 0);
}

/** Submits the URL-based photo record encrypted for each direct recipient device. */
export async function sendPreparedE2eeDirectPhotoByUrl(api: API, input: PreparedE2eeDirectPhotoByUrl): Promise<PreparedE2eeMediaResult | undefined> {
  return sendPreparedDirect(api, 'photo', input, (recipient) => photoFields(recipient, false));
}

/** Submits the URL-based photo record encrypted by an established group sender key. */
export async function sendPreparedE2eeGroupPhotoByUrl(api: API, input: PreparedE2eeGroupPhotoByUrl): Promise<PreparedE2eeMediaResult | undefined> {
  return sendPreparedGroup(api, 'photo', input, photoFields(input, true));
}

export interface SealedE2eeMediaFile {
  /** Raw encrypted file bytes. */
  readonly ciphertext: Buffer;
  /** Sensitive base64 e2esession material. Transmit it inside an authenticated ratchet frame. */
  readonly fileKey: string;
}

const maxFileBytes = 16 * 1024 * 1024;
const keySize = 32;
const ivSize = 12;
const tagSize = 16;
const mediaTypedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const mediaByteLength = Object.getOwnPropertyDescriptor(mediaTypedPrototype, 'byteLength')!.get!;
const mediaSet = Uint8Array.prototype.set;

function mediaBytes(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > maxFileBytes) {
    throw new TypeError('Supply a Zalo E2EE media byte array of 1 byte to 16 MiB.');
  }
}

/** Encrypts the installed client's linear file format with fresh AES-256-GCM key material. */
export function sealE2eeMediaFile(plaintext: Uint8Array): SealedE2eeMediaFile {
  mediaBytes(plaintext);
  const key = randomBytes(keySize);
  const iv = randomBytes(ivSize);
  let material: Buffer | undefined;
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: tagSize });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    material = Buffer.concat([key, iv, cipher.getAuthTag()]);
    return { ciphertext, fileKey: material.toString('base64') };
  } finally {
    key.fill(0);
    material?.fill(0);
  }
}

/** Opens raw linear file bytes with key material obtained from an authenticated message. */
export function openE2eeMediaFile(ciphertext: Uint8Array, fileKey: string): Buffer {
  mediaBytes(ciphertext);
  // 32-byte key, 12-byte IV, 16-byte tag, encoded with standard unpadded-by-length base64.
  if (typeof fileKey !== 'string' || !/^[A-Za-z0-9+/]{80}$/.test(fileKey)) {
    throw new TypeError('Invalid Zalo E2EE media key encoding.');
  }
  const material = Buffer.from(fileKey, 'base64');
  let input: Buffer | undefined;
  try {
    // Snapshot native byte slots, never Buffer.from's caller valueOf/coercion.
    // The public legacy admission and its TypeError messages remain above.
    const length = Reflect.apply(mediaByteLength, ciphertext, []) as number;
    if (length > maxFileBytes) throw new Error();
    input = Buffer.alloc(length); Reflect.apply(mediaSet, input, [ciphertext]);
    const result = openOwnedMediaResource(input, material, '1');
    if (result.kind !== 'plaintext') throw new Error();
    return result.plaintext;
  } catch {
    throw new Error('Zalo E2EE media authentication failed.');
  } finally {
    input?.fill(0);
    material.fill(0);
  }
}
