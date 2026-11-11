import type { DesktopSessionConnection } from './desktop-session.js';
import type { ProtocolData } from './protocol-request.js';
export interface DesktopPasswordStatus {
    /** True only for the installed numeric has_password:1 result. No password is returned. */
    hasPassword: boolean;
    raw: ProtocolData;
}
/** Reads password presence through this branded Desktop connection's owned auth origin; does not set or change it. */
export declare function getDesktopPasswordStatus(connection: DesktopSessionConnection, signal?: AbortSignal): Promise<DesktopPasswordStatus>;
