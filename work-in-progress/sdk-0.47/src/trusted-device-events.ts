import { parseAccountControlData, readAccountControlRows } from './account-controls.js';
import type { ProtocolData } from './protocol-request.js';
import type { RealtimeFrame } from './realtime-feed.js';
import { parseRawTrustedDeviceList } from './trusted-devices.js';
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

function qualify(value: unknown): QualifiedTrustedDeviceList | undefined {
  try {
    const data = parseAccountControlData(value);
    // Prevent the raw HTTP parser's liberal string form from adding a second
    // passive JSON layer or accepting leading whitespace by analogy.
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const list = parseRawTrustedDeviceList(data), devices = list.devices;
    for (let index = 0; index < devices.companions.length; index++) Object.freeze(devices.companions[index]);
    Object.freeze(devices.companions); Object.freeze(devices); return Object.freeze(list);
  } catch { return; }
}

/** Pure ordered raw device controls. Explicitly verify a qualified list against independently trusted pins. */
export function extractTrustedDeviceListEvents(frame: RealtimeFrame): readonly TrustedDeviceListEvent[] {
  try {
    const rows = readAccountControlRows(frame, ['user_devices']);
    if (!rows) return Object.freeze([]);
    const events: TrustedDeviceListEvent[] = [];
    let remainingQualifications = 64;
    for (const row of rows) {
      let list: QualifiedTrustedDeviceList | undefined;
      if (row.act === 'update_user_devices' && remainingQualifications > 0) {
        remainingQualifications--;
        list = qualify(row.data);
      }
      events.push(Object.freeze({ controlIndex: row.controlIndex, act: row.act, rawControl: row.rawControl,
        rawContent: row.rawContent, ...(list === undefined ? {} : { list }) }));
    }
    return Object.freeze(events);
  } catch { return Object.freeze([]); }
}
