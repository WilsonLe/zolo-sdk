/** Concealed, origin-scoped Codex CDP -> Python stdin transport. No cookie logs. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute } from 'node:path';

const helper = fileURLToPath(new URL('./youtube_yt_dlp.py', import.meta.url));

/**
 * Call inside cua_repl with an already navigated Codex in-app tab.
 * Python owns request/cookie validation, temporary storage and yt-dlp execution.
 * This function owns only the host capability and concealed subprocess channel.
 */
export async function runWithCodexCookies({ tab, requestPath, resultFile, python = 'python3', ytDlp = 'yt-dlp' }) {
  let request;
  try {
    if (!isAbsolute(requestPath) || (resultFile !== undefined && !isAbsolute(resultFile))) throw new Error();
    const text = await readFile(requestPath, 'utf8');
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error();
    request = JSON.parse(text);
    if (request.auth_mode !== 'codex_browser'
      || !['inspect', 'download', 'sync'].includes(request.operation)
      || !Array.isArray(request.urls) || request.urls.length < 1 || request.urls.length > 20) {
      throw new Error();
    }
    const urls = request.urls.map(value => new URL(value));
    if (urls.some(url => url.protocol !== 'https:' || url.username || url.password)
      || new Set(urls.map(url => url.origin)).size !== 1) throw new Error();
  } catch {
    throw new Error('Codex cookie bridge requires a request with one HTTPS origin and auth_mode=codex_browser');
  }

  let payload;
  try {
    const cdp = await tab.capabilities.get('cdp');
    const response = await cdp.send('Network.getCookies', { urls: request.urls });
    payload = JSON.stringify(response);
    if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error();
  } catch {
    throw new Error('Codex origin-scoped cookie transfer is unavailable; do not switch browsers or extract native storage');
  }

  const args = [helper, '--yt-dlp', ytDlp, request.operation, requestPath, '--codex-cookie-stdin'];
  if (resultFile !== undefined) args.push('--result-file', resultFile);
  const seconds = Number.isInteger(request.timeout) && request.timeout >= 30 && request.timeout <= 86400
    ? request.timeout : 300;
  return await new Promise((resolve, reject) => {
    const child = execFile(python, args, {
      cwd: dirname(requestPath), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      // Python enforces the operation timeout and must get time to clean up.
      timeout: (seconds + 30) * 1000,
    }, (_error, stdout) => {
      try {
        const result = JSON.parse(stdout);
        if (typeof result?.ok !== 'boolean') throw new Error();
        resolve(result); // Only the Python helper's sanitized result crosses back.
      } catch {
        reject(new Error('Codex cookie consumer failed without a sanitized result'));
      }
    });
    child.stdin.on('error', () => {}); // Early consumer failure must not print input.
    child.stdin.end(payload);
    payload = undefined;
  });
}
