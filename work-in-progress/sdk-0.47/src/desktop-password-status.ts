import { createHash } from 'node:crypto';
import type { API } from '#zca';
import { DesktopAuthError, readDesktopAuthResponse } from './desktop-auth.js';
import { desktopSessionAccountAccess, DesktopSessionError } from './desktop-session.js';
import type { DesktopSessionConnection } from './desktop-session.js';
import { parseProtocolJson, readProtocolResponse, requireProtocolObject, ZaloProtocolError } from './protocol-request.js';
import type { ProtocolData } from './protocol-request.js';

export interface DesktopPasswordStatus {
  /** True only for the installed numeric has_password:1 result. No password is returned. */
  hasPassword: boolean;
  raw: ProtocolData;
}
type Request = { origin: string; clientType: number; clientVersion: number; maxBytes: number; signal?: AbortSignal };
const bound = new WeakMap<API, (input: Request) => Promise<DesktopPasswordStatus>>();
const methodName = '__zaloPersonalSdkDesktopPasswordStatus';

function statusCode(value: unknown): number | undefined {
  if (typeof value === 'string' && /^-?\d{1,40}$/.test(value)) value = Number(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
}
function passwordStatus(raw: ProtocolData): DesktopPasswordStatus {
  if (!Object.hasOwn(raw, 'has_password') || (raw.has_password !== 0 && raw.has_password !== 1)) {
    throw new ZaloProtocolError('invalid-response');
  }
  return { hasPassword: raw.has_password === 1, raw };
}
async function decodeStatus(text: string, secretKey: string, signal?: AbortSignal): Promise<DesktopPasswordStatus> {
  let outer: ProtocolData;
  try { outer = requireProtocolObject(parseProtocolJson(text)); }
  catch { throw new ZaloProtocolError('invalid-response'); }
  const outerCode = statusCode(outer.error_code);
  if (outerCode === undefined) throw new ZaloProtocolError('invalid-response');
  if (outerCode !== 0) {
    // kCOK rejects this outer object; both installed UI consumers inspect only
    // its own has_password member, never a flag nested inside rejected data.
    if (Object.hasOwn(outer, 'has_password')) return passwordStatus(outer);
    throw new ZaloProtocolError('request-failed', undefined, outerCode);
  }
  const inner = requireProtocolObject(await readProtocolResponse(
    new Response(JSON.stringify({ error_code: 0, data: outer.data })), secretKey, 'encrypted-envelope', signal,
  ));
  // A live-shaped decrypted flat record has no status/data envelope. kCOK
  // rejects it and the same UI catch path consumes its root flag.
  if (!Object.hasOwn(inner, 'error_code')) return passwordStatus(inner);
  const innerCode = statusCode(inner.error_code);
  if (innerCode === undefined) throw new ZaloProtocolError('invalid-response');
  if (innerCode === 0) return passwordStatus(requireProtocolObject(inner.data));
  if (Object.hasOwn(inner, 'has_password')) return passwordStatus(inner);
  throw new ZaloProtocolError('request-failed', undefined, innerCode);
}

function request(api: API): (input: Request) => Promise<DesktopPasswordStatus> {
  const existing = bound.get(api);
  if (existing) return existing;
  api.custom<DesktopPasswordStatus, Request>(methodName, async ({ ctx, utils, props }) => {
    if (props.signal?.aborted) throw new ZaloProtocolError('aborted');
    const fields = { type: props.clientType, client_version: props.clientVersion };
    const values = Object.keys(fields).sort().map(key => String(fields[key as keyof typeof fields])).join('');
    const signkey = createHash('md5').update(`zsecurecheckhaspassword${values}`).digest('hex');
    const query = new URLSearchParams({ type: String(fields.type), client_version: String(fields.client_version), signkey });
    try {
      const response = await utils.request(`${props.origin}/api/update/checkHasPassword?${query}`, {
        method: 'GET', signal: props.signal, redirect: 'error',
      });
      if (response.status !== 200) {
        if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
        throw new ZaloProtocolError('request-failed', response.status);
      }
      const text = await readDesktopAuthResponse(response, props.signal ?? new AbortController().signal, props.maxBytes);
      return await decodeStatus(text, ctx.secretKey, props.signal);
    } catch (error) {
      if (props.signal?.aborted) throw new ZaloProtocolError('aborted');
      if (error instanceof ZaloProtocolError || error instanceof DesktopSessionError || error instanceof DesktopAuthError) throw error;
      throw new ZaloProtocolError('request-failed');
    }
  });
  const operation = (api as API & Record<typeof methodName, (input: Request) => Promise<DesktopPasswordStatus>>)[methodName];
  bound.set(api, operation);
  return operation;
}

/** Reads password presence through this branded Desktop connection's owned auth origin; does not set or change it. */
export async function getDesktopPasswordStatus(connection: DesktopSessionConnection, signal?: AbortSignal): Promise<DesktopPasswordStatus> {
  if (signal?.aborted) throw new ZaloProtocolError('aborted');
  const access = desktopSessionAccountAccess(connection);
  const credentials = connection.snapshot();
  return request(access.api)({ origin: access.authOrigin, clientType: credentials.clientType,
    clientVersion: credentials.clientVersion, maxBytes: access.maxResponseBytes, signal });
}
