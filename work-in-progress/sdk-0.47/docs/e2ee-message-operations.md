# Encrypted message recall and deletion

The E2EE entry point exposes `recallE2eeMessage`, `recallE2eeMessages`, `deleteE2eeMessages`, and `deleteE2eeConversation` for direct and group conversations. They issue one explicit request on the installed encrypted service routes. Zalo determines recall eligibility, author permissions, and account support.

```ts
import { recallE2eeMessages, deleteE2eeMessages } from 'zalo-personal-sdk/e2ee';

await recallE2eeMessages(api, {
  threadType: 'direct', threadId: peerId,
  messages: [{
    clientId: freshActionId,
    originalClientId: originalClientMessageId,
    globalMessageId: confirmedGlobalMessageId,
  }],
});

await deleteE2eeMessages(api, {
  threadType: 'direct', threadId: peerId, clientId: anotherActionId,
  messages: [{
    ownerId: originalSenderId,
    clientMessageId: originalClientMessageId,
    globalMessageId: confirmedGlobalMessageId,
  }],
});
```

Use `threadType:'group'` and the group ID for a group. The optional `visibility` field applies only to single-message group recall and defaults to zero, matching the installed fallback. Batch recall needs a distinct fresh action ID for each message. Message deletion uses one action ID for its request. The SDK accepts one through 100 references per batch; this is an SDK bound.

Supply confirmed positive decimal global message IDs as strings. A local message ID with a leading dot or index suffix is rejected. Client IDs accept positive safe integers or positive decimal strings. Pass the author's actual user ID in `ownerId`, replacing a client-local `0` self marker with `api.getOwnId()`. For direct deletion, the author must be this account or its peer. The SDK derives the original wire recipient as the peer for sent messages and this account for received messages. Group rows use the group ID.

`deleteE2eeMessages` sends `onlyMe:1`, which is the desktop's account deletion synchronization operation. It does not recall the message for other conversation members. Application-owned message stores and media caches need their own explicit update.

## Conversation boundary

```ts
await deleteE2eeConversation(api, {
  threadType: 'group', threadId: groupId, clientId: freshActionId,
  lastMessage: {
    ownerId: lastMessageSenderId,
    clientMessageId: lastClientMessageId,
    globalMessageId: lastConfirmedGlobalMessageId,
  },
});
```

The `lastMessage` reference supplies the installed `conver` deletion boundary. The SDK does not fetch or select it. Messages arriving after that boundary remain outside the request. This operation also uses `onlyMe:1`; it does not leave or dissolve a group, delete local E2EE keys, or revoke a device.

## Encryption and outcomes

These endpoints carry message references under the account AES envelope. The shipped builders do not ratchet-encrypt the IDs, attach `e2eeExt`, or supply a ciphertext-version field. Direct requests use the observed `destType:3`. Calling these helpers does not consume message-chain state. Select the encrypted route only for confirmed encrypted messages; ordinary-message mutations have their own operations.

Successful calls resolve `void`, following the installed consumers that treat the decoded response as an acknowledgment. An acknowledgment does not independently prove that another device has processed the resulting recall or deletion event.

`E2eeMessageOperationError` records its operation and one of these outcomes:

| Code | Meaning |
| --- | --- |
| `aborted` | The supplied signal was already cancelled before submission. |
| `unsupported-service` | The API session does not advertise the required encrypted service. |
| `rejected` | The outer or decrypted provider envelope explicitly rejected the request. `providerCode` retains its numeric code. |
| `submission-unknown` | Transport failure, malformed acknowledgment, HTTP failure, or cancellation after submission began leaves the result uncertain. `status` retains an available HTTP status. |

There are no automatic retries, clear-service fallbacks, or followed redirects. Persist the exact action IDs and references before submission, and reconcile an uncertain result before retrying. Error messages omit IDs, message bodies, URLs, and provider error text.

## Installed evidence

Offsets are zero-based bytes in the integrity-checked Desktop 26.11.10 SHARED member, SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. [Artifact identity](desktop-evidence.md)

| Operation | Direct `chat_e2e` | Group `group_e2e` | Observed parameters |
| --- | --- | --- | --- |
| Single recall | `/api/e2ee/pc/message/undo`, command 16007 | `/api/e2ee/pc/group/undoMsg`, command 16107 | `msgId`, fresh `clientId`, `cliMsgIdUndo`, and `toid` plus `destType:3` or `grid` plus `visibility` and `imei`. Builder bytes 12,513,232–12,513,888. |
| Batch recall | `/api/e2ee/pc/message/multi_undo`, command 16008 | `/api/e2ee/pc/group/multiUndoMsg`, command 16108 | `msgs` array of `{cliMsgId,cliMsgIdUndo,globalMsgId}`, plus direct `toid`/`destType:3` or group `grid`. Builder bytes 12,514,256–12,514,763; row construction 2,886,800–2,887,700. |
| Message deletion | `/api/e2ee/pc/message/delete`, command 16009 | `/api/e2ee/pc/group/deleteMsg`, command 16109 | Fresh `cliMsgId`, `msgs`, `onlyMe:1`, direct `toid`/`destType:3`/`imei` or group `grid`. Builders 12,509,914–12,510,372 and 12,510,694–12,511,139. |
| Conversation deletion | `/api/e2ee/pc/message/deleteconver`, command 16010 | `/api/e2ee/pc/group/deleteConv`, command 16110 | Fresh `cliMsgId`, `conver:{ownerId,cliMsgId,globalMsgId}`, `onlyMe:1`, and `imei`, direct `toid`/`destType:3` or group `grid`. Builders 12,511,469–12,511,937 and 12,512,285–12,512,735. |

Message deletion reference construction is at 15,808,478 and owner/recipient normalization at 12,112,161–12,113,150. Conversation boundary construction is at 17,597,847–17,598,720. The shared response handler at 13,736,118 unwraps account AES and rejects nonzero outer and inner error codes. Message ID normalization at 8,289,537–8,290,255 rejects indexed local IDs. These builders pass references directly to account encryption without invoking the E2EE message encryptor.

Synthetic fixtures decrypt and verify all eight exact request records, direct received-message routing, empty acknowledgments, permission rejection, cancellation, invalid references, and uncertain failures. No live recall or deletion was performed. Provider acceptance and resulting cross-device events remain unmeasured for these helpers.
