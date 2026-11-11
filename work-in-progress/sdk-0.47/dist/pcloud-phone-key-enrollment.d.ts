import type { PhoneEnrollment, PublicKeyObservation, PCloudPhoneKeyEnrollment, PCloudPhoneKeyEnrollmentBinding } from './pcloud-phone-key-state.js';
export type { PCloudPhoneKeyEnrollment, PCloudPhoneKeyEnrollmentBinding, PCloudPhoneKeyEnrollmentMetadata } from './pcloud-phone-key-state.js';
/** @internal Standard-format conversion only; native phone interoperability is unverified. */
export declare function convertPCloudPhoneKey(plaintext: Uint8Array, publicKey: PublicKeyObservation): {
    privateDer: Buffer;
    publicDer: Buffer;
};
/** @internal Receives owned standard DER only; does not obtain or publish a key. */
export declare function createOwnedPCloudPhoneEnrollment(value: PhoneEnrollment): PCloudPhoneKeyEnrollment;
export declare function restorePCloudPhoneKeyEnrollment(sealed: string, wrappingKey: Uint8Array, expected: PCloudPhoneKeyEnrollmentBinding): PCloudPhoneKeyEnrollment;
