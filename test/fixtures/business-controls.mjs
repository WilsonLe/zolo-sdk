// Independent decoded-frame constructors only; no SDK code or projection oracle.
export const privateText = 'synthetic-private-business-field';
export function row(act_type, act, data, extra = {}) {
  return { controlId: '9340000000000000331', content: { act_type,
    ...(act === undefined ? {} : { act }), ...(data === undefined ? {} : { data }), ...extra } };
}
export function frame(controls, { cmd = 601, subCmd = 0, version = 1, code = 0, transportCode, ...extra } = {}) {
  return { version, cmd, subCmd, encrypt: 3, ...(transportCode === undefined ? {} : { errorCode: transportCode }),
    payload: { error_code: code, data: { controls, ...extra } } };
}
