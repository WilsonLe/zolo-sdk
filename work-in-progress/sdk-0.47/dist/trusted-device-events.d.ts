import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';
import type { RawTrustedDeviceCompanion, RawTrustedDeviceList } from './trusted-devices.js';
/** Wire qualification only. This does not authenticate a companion or its signatures. */
export type QualifiedTrustedDeviceCompanion = Readonly<RawTrustedDeviceCompanion>;
export interface QualifiedTrustedDeviceList {
    readonly devices: Readonly<Omit<RawTrustedDeviceList['devices'], 'companions'>> & {
        readonly companions: readonly QualifiedTrustedDeviceCompanion[];
    };
}
export interface TrustedDeviceListEvent {
    readonly controlIndex: number;
    /** Captured raw action. Unknown actions are retained without a qualified list. */
    readonly act: unknown;
    /** Original wrapper references, including raw data/unknown fields; neither is cloned or mutated. */
    readonly rawControl: Readonly<ProtocolData>;
    readonly rawContent: Readonly<ProtocolData>;
    /** Owned frozen scalar snapshot, present only for a qualified update_user_devices payload. */
    readonly list?: QualifiedTrustedDeviceList;
}
/** Pure ordered raw device controls. Explicitly verify a qualified list against independently trusted pins. */
export declare function extractTrustedDeviceListEvents(frame: RealtimeFrame): readonly TrustedDeviceListEvent[];
