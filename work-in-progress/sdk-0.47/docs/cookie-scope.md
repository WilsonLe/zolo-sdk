# Cookie URL scope

SDK 0.37 extends the 0.36 correction to the pinned HTTP request helper used before Web API construction and by ordinary upstream/default/direct-utils operations. SDK 0.38 adds current full-URL cookie selection for each new Listener WebSocket connection. It ships a local zca-js 2.2.0 patch; the API class, declarations, operation bodies and MIT attribution remain unchanged. [Dependency provenance](../vendor/README.md).

| HTTP owner | Cookie behavior |
| --- | --- |
| Pinned Web QR/bootstrap, ordinary methods and SDK default/direct-utils calls | Select automatic cookies for the complete current URL. Store response cookies against nonempty response.url, otherwise that complete request URL. |
| Helper-visible Location continuation | Import permitted response cookies, then select applicable cookies for the next full URL. Keep generated defaults separate from caller header intent. |
| SDK strict/multipart and signed-photo owners | Retain their 0.36 complete-URL selection/storage and stronger admission guards. |
| Private Desktop authentication/bootstrap/account GET, cloud and phone-key owners | Retain existing full-URL scope and owned-origin/lifecycle guards. |

A matching /tenant cookie can accompany a request beneath that prefix, while wrong-path/foreign-host cookies are excluded. A Path-absent response cookie defaults to its supplying URL's directory and stays host-only without Domain. The jar validates Domain against that URL; a valid explicit different Path remains valid. Saved jar entries are not migrated.

## Redirect policy

Normal cookie-managed requests default to RequestInit redirect:error, including Web QR/bootstrap and an empty jar. A conforming fetch adapter rejects an automatic 3xx redirect before making a hidden request with the previously selected Cookie header. Normal redirect input must be omitted/undefined or the primitive string manual or error. Every other value, including follow, arrays, boxed strings and other coercible values, is rejected before adapter dispatch with TypeError: Cookie-managed requests require manual or error redirects. Admission does not coerce the input. This is an intentional compatibility change. Normal requests that depended on automatic redirects now fail instead of silently continuing.

Explicit redirect:manual and redirect:error keep their values. The legacy helper still follows a truthy Location returned to it, including HTTP 200 Location, with method GET, the existing body/other options and Referer on normal requests https://id.zalo.me/. That continuation requires an absolute URL; there is no new relative-URL support, retry or hop limit. redirect:error alone is not the SDK strict owner's separate rule rejecting every Location header. Existing strict/multipart/Desktop guards retain their stronger behavior.

Caller headers support records, Headers and tuple lists, with case-insensitive overrides and a fresh outgoing container. Same-origin explicit Cookie overrides, including empty Cookie, remain effective. On every visible origin change, Cookie, Authorization and Proxy-Authorization are removed from the owned continuation snapshot. Normal destination cookies are then selected from that destination's jar scope. Scheme, host and port define origin; removed caller credentials are not resurrected if the chain returns. Empty Cookie is an override for that origin, not a global no-cookie mode. Original caller options/headers remain unchanged; bodies, signals and agents keep their existing identities.

The upstream sendVoice/sendVideo size probes are raw requests. They dispatch no automatic account/default headers and import no response cookies, including on visible continuation. Raw keeps its existing redirect option/default and may explicitly use follow; visible origin changes still remove supplied sensitive headers. The existing unused default-header lookup and user-agent prerequisite remain in raw mode.

## WebSocket connections

Each new Listener connection synchronously selects cookies from its current account jar for the complete current socket URL. This includes the first start, explicit stop/start, same-endpoint native retries and endpoint rotation. Host, path, expiry and Secure matching remain the jar's responsibility. Cookie changes affect the next connection; they do not reauthenticate an already-open socket.

The original constructor chat-root lookup remains for compatibility, but its cached value is replaced before a new socket is allocated. An already-started call still fails before another lookup. If a synchronous custom jar callback has already started this listener, the outer call also fails with the existing Already started error instead of creating a second socket. A synchronous lookup failure escapes without a new allocation or stale-cookie fallback. Start remains synchronous for SDK feed ownership.

The existing agent, fixed handshake headers, retry/rotation limits and stop/reset behavior remain unchanged. No Upgrade Set-Cookie is imported and no new retry cancellation, timeout, active-socket refresh or endpoint admission policy is added. Desktop retains its existing approved-WSS checks. The installed jar treats wss/https as secure and ws/http as nonsecure; local wire checks cover ws, wss and the http alias. The https alias is source-derived; ws+unix IPC cookie-path semantics remain unverified.

## Cookie values across installations

The SDK bundles its transport/supporting packages; an application may have another tough-cookie installation. Response storage passes the original Set-Cookie string after the existing parse guard, allowing the receiving jar to construct its own Cookie. Move cookies between installations as strings or serialized records. Direct foreign Cookie objects and instanceof checks can still fail across physical copies. getCookie() returns the actual upstream jar; this patch does not replace its methods.

## Validation and limits

Local synthetic QR/resume and actual public methods exercise the owner. Real 127.0.0.1 HTTP and Node native fetch checks cover redirect refusal and cookie scope; fake adapters cover finite visible hops and header ownership. Local WebSocket/TLS Upgrade checks cover current cookies, reconnect/rotation, isolation, synchronous failures and single-socket ownership with synthetic data and an explicitly trusted local certificate. They are not provider acceptance. Earlier live QR/bootstrap results used earlier transport snapshots and do not verify this changed policy.

A custom fetch must honor the supplied RequestInit redirect policy; the helper cannot contain hidden requests made by an adapter that ignores it. Existing Set-Cookie fallback parsing/error handling and the retained raw prerequisite remain unchanged. This is not complete browser-engine or whole SDK cookie parity. [Group pages](group-pages.md) · [Signed uploads](signed-photo-upload.md)
