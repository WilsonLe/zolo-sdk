# Retained-companion Desktop login

Use `loginDesktopWithQR()` with explicit secret retention when your application needs to reuse its SDK-created companion for a later trusted-device login. The default remains fresh pairing with no returned linking secret. Relink consumes one caller-selected retained state; it never reads Zalo's native profile, reconstructs a missing secret, deletes native records or silently enrolls a fresh companion.

The CLI remains default-fresh. There are no new relink CLI commands. These helpers do not approve on the phone, publish message E2EE keys or automatically start a socket. [Desktop sign-in](desktop-login.md) · [Pairing codec](trusted-device-pairing.md) · [Storage](desktop-session-store.md)

## Select retention or relink explicitly

- Fresh `retainLinkingSecret:true` returns an owned 32-byte `companion.linkingSecret` only after verified trusted approval. Default/false omits it.
- Later `relink: {uid, companion}` uses `TrustedDeviceRelinkState`. The companion must contain the original secret, matching X25519 private/public identity and verified historical metadata. Explicit relink always returns that secret with the newly accepted history.
- A relink input conflicts with fresh `identitySigningKey` or fresh `linkingSecret` overrides and with `retainLinkingSecret:false`. The chosen pairing platform must match the historical companion.
- High-level retention/relink sets omitted `trustedDeviceQr` and `selfGeneratedQr` to true. Explicit false rejects before requests. An ordinary challenge or ordinary replacement ends as `trusted-device-unavailable`, without fallback.

The application still supplies its device identity, exact approved origins, QR rendering and optional persistence. On restart, populate the identity fields in applicationDesktopOptions from the saved credentials for the selected device. Calling the helper is an explicit new login attempt; loading a record or importing a module does not start one.

## State and verification

The retained state is captured before the first high-level request or callback. Validation requires the actual X25519 private key to derive the saved 33-byte companion wire identity, a 32-byte secret, a uint64 previous linking timestamp, and matching historical primary/list/row/master/link/platform evidence. The saved signed list is checked at issuance time. This establishes historical consistency, not current remote authorization. Private-key capture first obtains a native structured clone; matching JavaScript prototypes/symbols alone are insufficient. Accessor metadata and string-keyed nested object decoration on a retained KeyObject are rejected without traversal, while a caller export-function shadow is ignored.

Account `uid` is exact decimal text and is separate from `masterId`. The historical list does not authenticate the UID/secret/history association: your application must preserve the original association. Neither a private key nor a signed list can recover the random linking secret.

The current scan is authenticated with the retained secret over the original scan bytes and its current primary identity. A1 verification and the selected companion binding remain required. The current primary then pins verification of the approved signed list and current companion row. The current authenticated primary or master metadata may differ from the historical values; that observation does not grant a general rotation policy or permission to adopt an unverified incoming key.

Relink's low-level `verifyApproval()` requires full approval data, including `uid` and `devices`, rather than a detached device list. The approved UID must equal the retained UID before high-level `approved`, bootstrap or persistence. Bootstrap independently requires its login-info UID to equal the qualified approval UID. No UID/masterId equality is inferred.

Retained confirmation signs through the existing raw-scalar adapter and verifies each produced signature against the retained public identity. Native proof signing is randomized; deterministic SDK signatures need not have identical bytes. A raw X25519 private scalar is not an Ed25519 seed.

### Three independent timestamps

| Time | Role |
| --- | --- |
| Previous accepted linking timestamp | Historical uint64 value used by the relink ID. It is not sampled again from the clock. |
| New QR timestamp | Current attempt's QR field 4; follows the existing nonnegative safe-integer millisecond policy. |
| Newly accepted scan timestamp | Authenticated scan/proof value saved with the new history for the next relink. It is neither the QR clock nor the signed list's update time. |

The source-derived relink ID is raw HMAC-SHA256 with the original secret as key and `LE64(previousAcceptedTime) || companionWire33 || historicalPrimaryWire33` as input, including both wire type prefixes. The relink QR omits fresh secret field 3 and places the derived bytes in field 6, retaining the `Z1@` Base91 wrapper. Treat relink QR material as credentials too.

Fresh replacements create fresh keys and secrets. Explicit relink replacements keep the same selected identity, original secret and old history/MAC, with a new challenge/token and QR time. Existing retry, replacement and lifetime bounds apply. Polling retries and replacements do not advance the SDK's locally accepted history; unobserved remote approval may still require reconciliation. After a verified approval, later failure may require saving the accepted new history described below.

## Accepted state and persistence recovery

Phone approval can advance accepted linking history before bootstrap, an application event or local saving fails. For retention/relink, the helper privately captures qualified `{session,companion}` after trusted proof/list, matching retained UID when relinking, and complete credential validation, before `approved` and bootstrap. A successful bootstrap updates its session snapshot. Later errors, including cancellation/expiry, retain that accepted candidate through `DesktopLoginError.recoveryState()`.

Every recovery accessor returns an independent secret-bearing copy. Persist, result and recovery copies do not share mutable secret/public/list/cookie data; the immutable private KeyObject handle is shared. The candidate is absent from JSON, ordinary error inspection and causes. Protect accessor results as credentials.

| Error `persistenceState` | Observed application-save state |
| --- | --- |
| `not-started` | The persist callback was not invoked. This says nothing about remote approval. |
| `unknown` | The callback was invoked without observed fulfillment before the terminal boundary. Rejection, commit-then-throw and a pending callback all remain unknown. |
| `saved` | Fulfillment was observed: the application declared the complete candidate committed. A later abort does not downgrade that fact. |

These observations use the `DesktopLoginPersistenceState` type. The SDK keeps its bounded callback lifetime. A pending application write can complete after login returns an error. Later fulfillment does not revise that returned `unknown` observation. Keep one credential writer, let an outstanding write settle or otherwise quiesce it, then reload/reconcile before an explicit recovery save. Do not race a new login or write against it. AbortSignal cannot undo a file operation already underway.

Undefined recovery means no qualified accepted candidate. It never proves that remote state stayed unchanged or authorizes replay of old history. A recoverable bootstrap failure carries qualified approval credentials, not invented bootstrapped state. Saving a known candidate and reconnecting is separate from repeating QR/phone approval.

`persist` remains optional. Without it, the application owns the returned state and pre-save crash window. No in-memory recovery accessor survives a process crash between remote approval and durable local commit; provider approval and local storage are not one transaction. There is no automatic rollback, retry or record deletion.

## Complete application and store example

The following uses the same existing runtime entrypoints. Rendering, paths, identity/origins and the two explicit user actions belong to the application. In a restart, load the record and use the second action; do not repeat fresh enrollment automatically.

```ts
import {
  DesktopLoginError, FileDesktopSessionStore, loginDesktopWithQR,
  type DesktopLoginOptions, type DesktopLoginPersistence,
} from 'zalo-personal-sdk';

const store = new FileDesktopSessionStore(applicationDesktopRecordPath);
// Use one application writer for this selected record.
let pendingSave: Promise<void> | undefined;
let acceptedForRepair: DesktopLoginPersistence | undefined;

const persist = ({ session, companion }: DesktopLoginPersistence) => {
  const write = store.save({
    credentials: session, ...(companion ? { companion } : {}),
  });
  pendingSave = write;
  return write;
};

async function signIn(
  selected: Pick<DesktopLoginOptions, 'retainLinkingSecret' | 'relink'>,
) {
  try {
    return await loginDesktopWithQR({
      ...applicationDesktopOptions,
      ...selected,
      onEvent: applicationRendersQrAndStatus,
      persist,
    });
  } catch (error) {
    if (error instanceof DesktopLoginError) {
      const accepted = error.recoveryState();
      if (accepted && error.persistenceState !== 'saved') {
        acceptedForRepair = accepted; // Keep this copy if storage fails/stalls.
        await pendingSave?.catch(() => undefined);
        // Explicit storage repair of the known candidate; no login is replayed.
        await store.save({
          credentials: accepted.session, companion: accepted.companion,
        });
        acceptedForRepair = undefined;
      }
    }
    throw error;
  }
}

// First explicit action: create a fresh companion and retain its original secret.
const first = await signIn({ retainLinkingSecret: true });
first.connection.close();
first.companion?.linkingSecret?.fill(0); // Only this returned copy, after saving.

// Later explicit action, normally in a new process after loading the same record.
const saved = await store.load();
if (!saved?.companion?.linkingSecret) {
  throw new Error('The original linking secret is unavailable; select another action.');
}
const retainedCompanion = {
  ...saved.companion, linkingSecret: saved.companion.linkingSecret,
};
const next = await signIn({
  relink: { uid: saved.credentials.uid, companion: retainedCompanion },
});
try {
  await applicationUsesConnection(next.connection);
} finally {
  next.connection.close();
}
```

The example waits for its own pending store write before repairing. If that write cannot settle, keep the accepted copy and reconcile storage; do not hide an indefinite application-storage wait behind another login. A recovery-save failure must preserve `acceptedForRepair`. The original error's persistence observation does not become a receipt for a later repair.

## File format, default compatibility and ownership

`FileDesktopSessionStore` remains **owner-only plaintext**. Its file can contain cookies, renewal token, companion private key and original linking secret. Private permissions are not encryption. Use an application-selected encrypted store if required; the SDK does not create a vault.

- Secret-absent records retain version 1 and the existing default shape.
- Secret-bearing records use version 2 with a verified companion and canonical Base64 secret.
- New readers accept both, reject a secret extension in version 1, and reject version 2 without a valid secret/companion.
- Old SDK readers reject version 2 instead of silently rewriting it without its secret.
- Invalid saves preserve the previous file. There is no implicit migration, secret reconstruction or native-record import.

A legacy record without the original secret cannot be relinked automatically. Saved-cookie bootstrap remains usable independently when the provider accepts it. A caller who retained the original secret elsewhere may explicitly supply that association; the historical list alone cannot prove it.

Save credentials and the newly accepted complete companion/history/secret in one atomic application record. For credential-only updates, including renewal recovery, preserve the whole companion:

```ts
await store.save({ ...savedRecord, credentials: nextCredentials });
```

Existing file saving syncs the temporary file's contents and atomically renames it. It does not serialize independent writers or make remote/local commits atomic. Keep the approval-before-commit crash window explicit. Closing an SDK attempt wipes owned working secret/scalar buffers, not returned application copies, stored files, Node key objects or all GC-owned memory.

## Evidence and limits

The shipped Desktop 26.11.10 trust WASM is SHA256 `716f0a0637e5b64168010899f4ad380be7d0c6a67778137c88ecb2ff9d9e49da`. Focused static dataflow closes function 75's old-history MAC, function 72's optional relink QR field and function 70's normal HMAC/A1/D2/current-primary/raw-scalar roles. The proof audit does not reprove every malformed-protobuf branch or every curve/scalar arithmetic limb.

An earlier REA macOS ownership-helper compilation failure was recovered for a task-local CLI static inspection. Global MCP/configuration settings remained unchanged. Valid static WASM/interface inspection is not target WASM execution or phone approval.

All 45 controlled SDK 0.43 runtime groups pass locally: 39 independently authored groups cover standard MAC/QR vectors, arbitrary retained raw signatures, current proof/list/UID guards, replacements, accepted-state recovery, late-save observations, copy isolation and complete v1/v2 save/reload/relink/restart; six additional key-capture regressions cover genuine native clones versus shaped objects and caller metadata hooks. Three of those key regressions failed on the original draft before the shared capture fix. All 91 selected existing affected checks also pass. This is synthetic local evidence; full workspace and hosted CI were not run.

Earlier ordinary Desktop QR/bootstrap/profile reads and initial socket-key-frame results remain separate. They do not establish trusted enrollment, retained relink phone acceptance, complete key rotation, provider eligibility or all account operations. No new live/stock/phone action is implied by this guide.
