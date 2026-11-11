# Group sender keys and encrypted events

`E2eeGroupSender` maintains one sender key for one device in one group. `distribution()` exports the current iteration, chain secret, and signing public key. Encrypt these bytes with an authenticated pairwise session for each eligible recipient device. `encrypt()` creates the signed group frame accepted by `sendPreparedE2eeGroupText()`.

```ts
import {
  attachE2eeControl, E2eeGroupSender,
} from 'zalo-personal-sdk/e2ee';

const control = attachE2eeControl(feed);
const sender = new E2eeGroupSender();
const distribution = authenticatedDirectSession.encrypt(sender.distribution());
await control.sendGroupDistribution({
  groupId, recipientId, recipientDevice: 1, mode: 'create',
  ciphertext: distribution, timestamp: Date.now(),
});
```

The snippet sends one distribution to an established recipient. Your application decides which devices need distribution, when to rotate a sender key, and how to persist state and retry submissions. The caller manages membership changes and device identity pins.

`extractE2eeGroupDistributionEvents(frame)` returns the sender, group, device, message ID, mode, and pairwise ciphertext from a group session push or a supplied offline session page. Open the pairwise frame with the pinned sender's direct session or initial prekey handler before creating `E2eeGroupReceiver` from the authenticated distribution bytes. Save the resulting state before calling `control.acknowledgeGroupDistribution(event)`. The acknowledgment is an explicit operation and can clear the server's queued distribution.

`extractE2eeTextEvents(frame)` normalizes direct, group, and page ciphertext records from encrypted online and missed-message commands. For group messages, use the thread, sender, device, and `groupSenderKeyId` to select the receiver. Routing fields and structure checks do not authenticate ciphertext. `receiver.decrypt(event.ciphertext)` verifies the signature before opening a frame and rejects replayed iterations. Rich text can carry a separately encrypted `stylesCiphertext`.

## Sealed group checkpoints

`sender.sealState(wrappingKey)` and `receiver.sealState(wrappingKey)` return versioned checkpoints. Restore with `E2eeGroupSender.restoreSealedState(checkpoint, wrappingKey)` or `E2eeGroupReceiver.restoreSealedState(checkpoint, wrappingKey)`. Use a caller-held random 32-byte key. The checkpoint uses AES-256-GCM with a fresh nonce and a purpose and version authenticated for each role. Sender restoration verifies that its private signing key derives the stored public key. Receiver restoration preserves the current iteration, skip limit, and unconsumed delayed-message keys.

Bind each checkpoint to its group, sender device, key ID, and role. Use a separate wrapping key per record or have your store authenticate the record identifier. Keep one writer per record and restore the most recent committed checkpoint. An older checkpoint can still authenticate. Before sending, atomically persist the advanced sender checkpoint and the exact prepared ciphertext with its submission ID. Retry those bytes and ID. Before acknowledging or committing an application-visible effect, persist the advanced receiver checkpoint. For a new distribution, persist the new receiver and the advanced pairwise receive state together before acknowledging the distribution.

## Installed evidence and tests

Offsets refer to `SHARED` in the installed Zalo Desktop **26.11.10** archive. [Desktop artifact identity](desktop-evidence.md)

| Part | Shipped contract |
| --- | --- |
| Sender key | The app samples a 16-bit sender key ID. Distribution uses a `0x33` version byte and protobuf fields 1–4 for key ID, iteration, 32-byte chain key, and 33-byte signing key. The group frame has outer type `4`, version `0x33`, a protobuf with ID, iteration, and ciphertext, then a 64-byte signature over the version and protobuf. SHARED 5,045,700–5,045,970, 5,054,290–5,056,620, and `MessageProtocol.proto`. |
| Ratchet and authentication | HMAC advances the sender chain. The `ZaloGroup` KDF produces an IV followed by the AES-256-CBC key. The receiver selects by sender key ID, verifies the signature, and caps derivation and skipped keys at 2,000. SHARED 5,057,000–5,064,890. |
| Distribution | Request command `561` subcommand `0` carries `{reqId,data:{type,uidTo,data:[{deviceId,data,ts}],tId}}`. A push uses subcommand `1` and `data.eesession` rows. Commands `516` and `517` can carry offline rows tagged with command `561`. Mode codes are `0` create, `1` reinit, and `2` response. Acknowledgment command `545` uses subcommand `1` and `{reqId,data:{queueName:"",info:[{gid,cmd:561,subCmd:0,sid,deviceId}]}}`. SHARED 3,269,300–3,275,100, 5,106,030–5,110,600, 5,129,200–5,130,250, 12,570,364–12,572,400, and 12,592,000–12,593,630. |
| Text events | Commands `513`–`515`, `535`, `551`, `552`, `713`, and `715` use message lists `msgs`, `groupMsgs`, or `pageMsgs`. Rich text uses `content.action = 'rtf'` and may carry ciphertext in `title` and `params`. Self-originated records use sender ID `0`. SHARED 1,529,746, 5,147,549, 5,299,028–5,307,106, and 12,581,459–12,593,630. |

An independently composed group frame exercises the KDF, protobuf, and legacy signing format. Round-trip fixtures exercise pairwise distribution, group text and styles, signature failures, delayed messages, replay rejection, and exact socket request envelopes. The SDK verifies the bytes covered by the shipped sender. The desktop verifier's slice at SHARED 5,056,650 appears to include one additional byte. The desktop build forces group E2EE deactivation during configuration merge at SHARED 10,592,643. Group transport and feature availability remain unverified on a live account. The extractor accepts offline queue frames supplied to it. Key lifecycle orchestration remains application work.
