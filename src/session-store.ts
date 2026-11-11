import { resolve } from "node:path";
import { clearPrivateFile, readPrivateFile, writePrivateFile } from './private-file.js';

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

const formatVersion = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): boolean {
  return typeof value === "boolean";
}

function nonempty(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function nullableString(value: unknown): boolean {
  return value === null || isString(value);
}

function nullableBoolean(value: unknown): boolean {
  return value === null || isBoolean(value);
}

const cookieAttributes = {
  value: isString,
  expires: nullableString,
  maxAge: (value: unknown) =>
    (typeof value === "number" && Number.isFinite(value)) || value === "Infinity" || value === "-Infinity",
  domain: nullableString,
  path: nullableString,
  secure: isBoolean,
  httpOnly: isBoolean,
  extensions: (value: unknown) => Array.isArray(value) && Array.from(value).every(isString),
  hostOnly: nullableBoolean,
  pathIsDefault: nullableBoolean,
  creation: nullableString,
  lastAccessed: nullableString,
  sameSite: isString,
};

function invalidSession(): Error {
  return new Error("Invalid Zalo session format.");
}

function parseCookie(value: unknown): SessionCookie {
  if (!isRecord(value) || !nonempty(value.key)) throw invalidSession();

  const cookie: SessionCookie = { key: value.key };
  for (const [name, validate] of Object.entries(cookieAttributes)) {
    if (!Object.hasOwn(value, name)) continue;
    const attribute = value[name];
    if (attribute === undefined) continue;
    if (!validate(attribute)) throw invalidSession();
    cookie[name] = Array.isArray(attribute) ? [...attribute] : attribute;
  }
  return cookie;
}

export { parseCookie as parseSessionCookie };

function parseSession(value: unknown): PersonalSession {
  if (!isRecord(value)) throw invalidSession();
  const { imei, userAgent, cookie, language } = value;
  if (!nonempty(imei) || !nonempty(userAgent) || !Array.isArray(cookie) || cookie.length === 0) {
    throw invalidSession();
  }
  if (language !== undefined && !nonempty(language)) throw invalidSession();

  return {
    imei,
    userAgent,
    cookie: Array.from(cookie, parseCookie),
    ...(language === undefined ? {} : { language }),
  };
}

/** Stores one personal login in a private file. The caller chooses the path. */
export class FileSessionStore implements SessionStore {
  readonly #path: string;

  constructor(path: string) {
    if (!nonempty(path)) throw new TypeError("A Zalo session file path is required.");
    this.#path = resolve(path);
  }

  async load(): Promise<PersonalSession | null> {
    const content = await readPrivateFile(this.#path, 'Zalo session');
    if (content === null) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(content);
    } catch {
      // JSON parser errors can contain fragments of the credentials.
      throw invalidSession();
    }
    if (!isRecord(decoded) || decoded.version !== formatVersion) throw invalidSession();
    return parseSession(decoded.session);
  }

  async save(session: PersonalSession): Promise<void> {
    const content = JSON.stringify({ version: formatVersion, session: parseSession(session) }) + "\n";
    await writePrivateFile(this.#path, content, 'Zalo session');
  }

  async clear(): Promise<void> {
    await clearPrivateFile(this.#path, 'Zalo session');
  }
}
