import { ZaloApiError } from '#zca';
import type { API } from '#zca';

type StickerOperations = Pick<API, 'getStickers' | 'getStickersDetail'>;
type StickerDetail = Awaited<ReturnType<API['getStickersDetail']>>[number];
const factoryName = '__zaloPersonalSdkStickerCompatibility';
const installed = new WeakSet<API>();

/** Internal pinned-2.2.0 correction. Preserve the advertised map and all unaffected API methods. */
export function installUpstreamCompatibility(api: API): API {
  if (installed.has(api) || api.zpwServiceMap.sticker.length < 2) return api;
  const firstHost = api.zpwServiceMap.sticker[0];
  api.custom<unknown, void>(factoryName, ({ ctx, utils }) => {
    const suggestionsURL = utils.makeURL(`${firstHost}/api/message/sticker`);
    const detailURL = utils.makeURL(`${firstHost}/api/message/sticker/sticker_detail`);
    const getStickers: API['getStickers'] = async function getStickers(keyword) {
      if (!keyword) throw new ZaloApiError('Missing keyword');
      const encrypted = utils.encodeAES(JSON.stringify({ keyword, gif: 1, guggy: 0, imei: ctx.imei }));
      if (!encrypted) throw new ZaloApiError('Failed to encrypt message');
      const endpoint = new URL(suggestionsURL);
      endpoint.pathname += '/suggest/stickers';
      const response = await utils.request(utils.makeURL(endpoint.toString(), { params: encrypted }));
      return await utils.resolve(response, result => {
        const suggestions = result.data as { sugg_sticker?: { sticker_id: number }[] };
        const ids: number[] = [];
        if (suggestions.sugg_sticker) suggestions.sugg_sticker.forEach(sticker => ids.push(sticker.sticker_id));
        return ids;
      }) as number[];
    };
    async function detail(stickerId: number): Promise<StickerDetail> {
      const encrypted = utils.encodeAES(JSON.stringify({ sid: stickerId }));
      if (!encrypted) throw new ZaloApiError('Failed to encrypt message');
      const response = await utils.request(utils.makeURL(detailURL, { params: encrypted }));
      return await utils.resolve(response) as StickerDetail;
    }
    const getStickersDetail: API['getStickersDetail'] = async function getStickersDetail(stickerIds) {
      if (!stickerIds) throw new ZaloApiError('Missing sticker id');
      if (!Array.isArray(stickerIds)) stickerIds = [stickerIds];
      if (!stickerIds.length) throw new ZaloApiError('Missing sticker id');
      const stickers: StickerDetail[] = [];
      const results = await Promise.allSettled(stickerIds.map(stickerId => detail(stickerId)));
      results.forEach(result => { if (result.status === 'fulfilled') stickers.push(result.value); });
      return stickers;
    };
    return { getStickers, getStickersDetail } satisfies StickerOperations;
  });
  const operations = (api as API & Record<typeof factoryName, () => StickerOperations>)[factoryName]();
  api.getStickers = operations.getStickers;
  api.getStickersDetail = operations.getStickersDetail;
  installed.add(api);
  return api;
}
