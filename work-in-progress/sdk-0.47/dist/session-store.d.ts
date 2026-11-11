/** Serialized cookie record returned by the Zalo Web client's cookie jar. */
export type SessionCookie = {
    key?: string;
    value?: string;
    [attribute: string]: unknown;
};
export interface PersonalSession {
    imei: string;
    userAgent: string;
    cookie: SessionCookie[];
    language?: string;
}
export interface SessionStore {
    load(): Promise<PersonalSession | null>;
    save(session: PersonalSession): Promise<void>;
    clear(): Promise<void>;
}
declare function parseCookie(value: unknown): SessionCookie;
export { parseCookie as parseSessionCookie };
/** Stores one personal login in a private file. The caller chooses the path. */
export declare class FileSessionStore implements SessionStore {
    #private;
    constructor(path: string);
    load(): Promise<PersonalSession | null>;
    save(session: PersonalSession): Promise<void>;
    clear(): Promise<void>;
}
