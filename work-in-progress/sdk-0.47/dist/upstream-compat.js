import { ZaloApiError } from '#zca';
const factoryName = '__zaloPersonalSdkStickerCompatibility';
const installed = new WeakSet();
/** Internal pinned-2.2.0 correction. Preserve the advertised map and all unaffected API methods. */
export function installUpstreamCompatibility(api) {
    if (installed.has(api) || api.zpwServiceMap.sticker.length < 2)
        return api;
    const firstHost = api.zpwServiceMap.sticker[0];
    api.custom(factoryName, ({ ctx, utils }) => {
        const suggestionsURL = utils.makeURL(`${firstHost}/api/message/sticker`);
        const detailURL = utils.makeURL(`${firstHost}/api/message/sticker/sticker_detail`);
        const getStickers = async function getStickers(keyword) {
            if (!keyword)
                throw new ZaloApiError('Missing keyword');
            const encrypted = utils.encodeAES(JSON.stringify({ keyword, gif: 1, guggy: 0, imei: ctx.imei }));
            if (!encrypted)
                throw new ZaloApiError('Failed to encrypt message');
            const endpoint = new URL(suggestionsURL);
            endpoint.pathname += '/suggest/stickers';
            const response = await utils.request(utils.makeURL(endpoint.toString(), { params: encrypted }));
            return await utils.resolve(response, result => {
                const suggestions = result.data;
                const ids = [];
                if (suggestions.sugg_sticker)
                    suggestions.sugg_sticker.forEach(sticker => ids.push(sticker.sticker_id));
                return ids;
            });
        };
        async function detail(stickerId) {
            const encrypted = utils.encodeAES(JSON.stringify({ sid: stickerId }));
            if (!encrypted)
                throw new ZaloApiError('Failed to encrypt message');
            const response = await utils.request(utils.makeURL(detailURL, { params: encrypted }));
            return await utils.resolve(response);
        }
        const getStickersDetail = async function getStickersDetail(stickerIds) {
            if (!stickerIds)
                throw new ZaloApiError('Missing sticker id');
            if (!Array.isArray(stickerIds))
                stickerIds = [stickerIds];
            if (!stickerIds.length)
                throw new ZaloApiError('Missing sticker id');
            const stickers = [];
            const results = await Promise.allSettled(stickerIds.map(stickerId => detail(stickerId)));
            results.forEach(result => { if (result.status === 'fulfilled')
                stickers.push(result.value); });
            return stickers;
        };
        return { getStickers, getStickersDetail };
    });
    const operations = api[factoryName]();
    api.getStickers = operations.getStickers;
    api.getStickersDetail = operations.getStickersDetail;
    installed.add(api);
    return api;
}
