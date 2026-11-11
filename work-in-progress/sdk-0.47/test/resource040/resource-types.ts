// Strict installed-public-consumer fixture. These functions are never invoked.
import { Buffer } from 'node:buffer';
import { fetchCloudResourceCiphertext, getCloudDownloadUrls } from 'zalo-personal-sdk';
import type { CloudResourceFetchOptions, CloudMediaOptions, CloudMediaStage, CloudMediaFailure,
  CloudMediaViewer, FamilyMediaViewer, DesktopSessionConnection, PCloudResourceDecoder,
  PCloudPhoneKeyEnrollment } from 'zalo-personal-sdk';

export async function explicitResourceRead(connection: DesktopSessionConnection, viewer: CloudMediaViewer,
  family: FamilyMediaViewer, decoder: PCloudResourceDecoder, enrollment: PCloudPhoneKeyEnrollment,
  locator: string, capsule: string, signal: AbortSignal): Promise<Buffer> {
  const allowedOrigins = ['https://resource.fixture.invalid'] as const;
  const settings: CloudResourceFetchOptions = { allowedOrigins, maxBytes: 1024, timeoutMs: 500, signal };
  const base: CloudMediaOptions = settings; void base;
  const stage: CloudMediaStage = 'resource'; const code: CloudMediaFailure = 'response-limit'; void stage; void code;
  const ciphertext: Buffer = await fetchCloudResourceCiphertext(connection, viewer, locator, settings);
  const opened = decoder.openResource(ciphertext, capsule, '1');
  const enrolled = enrollment.openResource(ciphertext, capsule, '2');
  const authenticated: true = opened.algorithmVersion === '1' ? opened.gcmAuthenticated : true;
  void enrolled; void authenticated;
  // @ts-expect-error A family handle cannot authorize a cloud resource request.
  await fetchCloudResourceCiphertext(connection, family, locator, settings);
  // @ts-expect-error Settings and independent origins are required.
  await fetchCloudResourceCiphertext(connection, viewer, locator);
  // @ts-expect-error Independent origins cannot be omitted from settings.
  await fetchCloudResourceCiphertext(connection, viewer, locator, { signal });
  // @ts-expect-error No caller fetch adapter is admitted on the resource operation.
  await fetchCloudResourceCiphertext(connection, viewer, locator, { allowedOrigins, fetch: globalThis.fetch });
  // @ts-expect-error No arbitrary header/cookie injection option.
  await fetchCloudResourceCiphertext(connection, viewer, locator, { allowedOrigins, headers: { Cookie: 'x' } });
  // @ts-expect-error A capsule is selected only for explicit subsequent decoder use.
  await fetchCloudResourceCiphertext(connection, viewer, locator, { allowedOrigins, capsule });
  // @ts-expect-error Existing locator options remain signal-only.
  await getCloudDownloadUrls(connection, viewer, ['noise-id'], { allowedOrigins });
  // @ts-expect-error Readonly options cannot be overwritten.
  settings.allowedOrigins = [];
  return ciphertext;
}
