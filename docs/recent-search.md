# Revisioned recent search

`getRecentSearch(api, knownVersion?, signal?)` reads synchronized conversation and keyword search history. The default version is 1, matching the initial-client read state. `updateRecentSearch(api, input)` explicitly submits the caller's complete lists and known revision once.

```ts
const current = await getRecentSearch(api);
if (current.version === undefined) throw new Error('The provider supplied no search-history revision.');
const updated = await updateRecentSearch(api, {
  version: current.version,
  conversations: applicationRecentConversations,
  keywords: applicationRecentKeywords,
});
```

Each conversation has `id`, numeric `type`, and optional `lastUpdateTime`. Group type 1 accepts the Desktop `g` ID prefix as input and sends the decimal ID. Ordinary profile entries use type 0. Other provider type values are preserved without inferred meaning. Keywords have `keyword` and optional `lastUpdateTime`; exact text, Unicode and whitespace are preserved. Conversations with timestamp zero omit it on submission, matching the installed serializer. Legacy negative timestamps are retained.

Read responses expose optional `version`, `conversations`, and `keywords`, plus `raw` provider fields. Omitted arrays carry no replacement from that response. An empty returned array is an explicit empty list. Updates can return an empty acknowledgment. Provider refusal codes, including the installed conflict/reload cases 160, 266 and 212, remain visible through `ZaloProtocolError.providerCode`. The application reconciles a fresh revision before deciding on another explicit update. Requests receive no automatic retries. A transport failure after submission leaves the outcome uncertain.

The SDK bounds each list at 1,000 entries and each keyword at 4,096 UTF-8 bytes. These are SDK bounds. Treat returned search terms and conversation IDs as private account data.

The installed 26.11.10 SHARED member builds GET `/api/recentsearch/list` on service `recent_search` at byte 12,524,047, using account-encrypted `{version,imei}`. POST `/api/recentsearch/update` at 12,524,283 uses `{list_recent,version,list_keyword,imei}`. The active serializer near 15,845,000 maps conversation entries to `{id,type,last_update_time?}` and leaves keywords as `{key,last_update_time?}`. Read/update consumers near 15,846,300 use provider versions and optional replacement arrays. Initial read revision 1 comes from `getVersionRecentGlobalSearch` at 10,189,823. Fixtures cover exact encryption and wire fields, version and ID precision, private text preservation, empty responses, conflicts and invalid input. [Desktop artifact identity](desktop-evidence.md)

On 6 November 2026, the saved Web account's read with initial revision 1 returned provider code 212. The earlier revision -1 probe returned 114. Successful provider records and update acceptance remain unverified.

A subsequent saved-Desktop-session recent-search read also returned provider code 212 on 6 November 2026 after successful account bootstrap. No recent-search update was submitted.
