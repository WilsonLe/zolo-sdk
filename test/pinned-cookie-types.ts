import { Agent } from 'node:https';
import { CookieJar } from 'tough-cookie';
import { API, PersonalZalo, ThreadType } from 'zalo-personal-sdk';
import * as Main from 'zalo-personal-sdk';

type Context = ConstructorParameters<typeof API>[0];
type Services = ConstructorParameters<typeof API>[1];
type ContextAgent = NonNullable<Context['options']['agent']>;

// Compile-only. The function is never invoked and makes no real request.
async function pinnedSurface(api: API, ctx: Context, services: Services, signal: AbortSignal): Promise<void> {
  const nodeAgent: ContextAgent = new Agent({ keepAlive: false });
  ctx.options.agent = nodeAgent;
  const callerJar = new CookieJar();
  ctx.cookie = callerJar;
  const record: HeadersInit = { Cookie: 'explicit=owned', 'X-Example': 'record' };
  const standard: HeadersInit = new Headers([['Cookie', ''], ['X-Example', 'Headers']]);
  const tuples: HeadersInit = [['Cookie', 'explicit=owned'], ['X-Example', 'tuples']];
  const body = new URLSearchParams([['synthetic', 'body']]);
  const request: RequestInit = { method: 'POST', headers: standard, body, signal, redirect: 'manual' };
  api.custom<Response, { url: string; options?: RequestInit; raw?: boolean }>('__typedCookie037', ({ ctx: ownedContext, utils, props }) => {
    const selectedAgent: Context['options']['agent'] = ownedContext.options.agent;
    const response: Promise<Response> = utils.request(props.url, props.options, props.raw);
    void selectedAgent; return response;
  });
  api.custom<Response, { url: string }>('__negativeTypedCookie037', ({ utils, props }) => {
    // @ts-expect-error Raw is a Boolean selector, not a string mode.
    return utils.request(props.url, request, 'raw');
  });
  const constructed: API = new API(ctx, services, ['wss://unused.fixture.invalid']);
  const profile = await constructed.fetchAccountInfo();
  const voice: Promise<{ msgId: string }> = api.sendVoice({ voiceUrl: 'https://media.fixture.invalid/voice.mp3', ttl: 0 }, '37', ThreadType.User);
  const video: Promise<{ msgId: number }> = api.sendVideo({ videoUrl: 'https://media.fixture.invalid/video.mp4',
    thumbnailUrl: 'https://media.fixture.invalid/thumb.jpg', width: 400, height: 300, duration: 1000, ttl: 0 }, '37', ThreadType.User);
  const client = new PersonalZalo({ fetch: async () => new Response('{}') });
  const resumed: Promise<API> = client.resume();
  const qr: Promise<API> = client.loginWithQR({ onEvent() {}, signal });
  // @ts-expect-error Voice URL must remain text.
  api.sendVoice({ voiceUrl: 37 }, '37');
  // @ts-expect-error The existing video surface still requires thumbnailUrl.
  api.sendVideo({ videoUrl: 'https://media.fixture.invalid/video.mp4' }, '37');
  // @ts-expect-error The cookie correction adds no public low-level helper.
  Main.getDefaultHeaders(ctx, 'https://account.fixture.invalid/path');
  // @ts-expect-error No request helper is exported from the SDK root.
  Main.request(ctx, 'https://account.fixture.invalid/path', request);
  void [record, standard, tuples, request, profile, voice, video, resumed, qr];
}
void pinnedSurface;
