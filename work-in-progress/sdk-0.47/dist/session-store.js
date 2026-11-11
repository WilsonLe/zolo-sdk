import { resolve } from "node:path";
import { clearPrivateFile, readPrivateFile, writePrivateFile } from './private-file.js';
const formatVersion = 1;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString(value) {
    return typeof value === "string";
}
function isBoolean(value) {
    return typeof value === "boolean";
}
function nonempty(value) {
    return isString(value) && value.trim().length > 0;
}
function nullableString(value) {
    return value === null || isString(value);
}
function nullableBoolean(value) {
    return value === null || isBoolean(value);
}
const cookieAttributes = {
    value: isString,
    expires: nullableString,
    maxAge: (value) => (typeof value === "number" && Number.isFinite(value)) || value === "Infinity" || value === "-Infinity",
    domain: nullableString,
    path: nullableString,
    secure: isBoolean,
    httpOnly: isBoolean,
    extensions: (value) => Array.isArray(value) && Array.from(value).every(isString),
    hostOnly: nullableBoolean,
    pathIsDefault: nullableBoolean,
    creation: nullableString,
    lastAccessed: nullableString,
    sameSite: isString,
};
function invalidSession() {
    return new Error("Invalid Zalo session format.");
}
function parseCookie(value) {
    if (!isRecord(value) || !nonempty(value.key))
        throw invalidSession();
    const cookie = { key: value.key };
    for (const [name, validate] of Object.entries(cookieAttributes)) {
        if (!Object.hasOwn(value, name))
            continue;
        const attribute = value[name];
        if (attribute === undefined)
            continue;
        if (!validate(attribute))
            throw invalidSession();
        cookie[name] = Array.isArray(attribute) ? [...attribute] : attribute;
    }
    return cookie;
}
export { parseCookie as parseSessionCookie };
function parseSession(value) {
    if (!isRecord(value))
        throw invalidSession();
    const { imei, userAgent, cookie, language } = value;
    if (!nonempty(imei) || !nonempty(userAgent) || !Array.isArray(cookie) || cookie.length === 0) {
        throw invalidSession();
    }
    if (language !== undefined && !nonempty(language))
        throw invalidSession();
    return {
        imei,
        userAgent,
        cookie: Array.from(cookie, parseCookie),
        ...(language === undefined ? {} : { language }),
    };
}
/** Stores one personal login in a private file. The caller chooses the path. */
export class FileSessionStore {
    #path;
    constructor(path) {
        if (!nonempty(path))
            throw new TypeError("A Zalo session file path is required.");
        this.#path = resolve(path);
    }
    async load() {
        const content = await readPrivateFile(this.#path, 'Zalo session');
        if (content === null)
            return null;
        let decoded;
        try {
            decoded = JSON.parse(content);
        }
        catch {
            // JSON parser errors can contain fragments of the credentials.
            throw invalidSession();
        }
        if (!isRecord(decoded) || decoded.version !== formatVersion)
            throw invalidSession();
        return parseSession(decoded.session);
    }
    async save(session) {
        const content = JSON.stringify({ version: formatVersion, session: parseSession(session) }) + "\n";
        await writePrivateFile(this.#path, content, 'Zalo session');
    }
    async clear() {
        await clearPrivateFile(this.#path, 'Zalo session');
    }
}
