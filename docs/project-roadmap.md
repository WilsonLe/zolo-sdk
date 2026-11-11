# Remaining work and continuation order

The full goal is an authenticated personal-account SDK with all installed-client operations for custom clients/bots. The current root SDK is 0.46; operation parity is not complete. [Operation status](operation-status.md) remains the detailed family inventory. This plan records future work; it does not authorize live mutations or start them.

## First: finish or explicitly discard the interrupted 0.47 candidate

1. Read the [handoff](project-handoff.md), [frozen design](project-evidence/zalo-sdk-0.47-plan.md), [candidate guide](../work-in-progress/sdk-0.47/docs/saved-video-thumbnail-upload.md), manifests and retained check records. Verify hashes and current root drift. Historical absolute paths must be mapped to the portable local copy.
2. Install candidate dependencies separately with its lockfile, build, and refresh only evidence invalidated by code/toolchain changes. Keep source and installed-package consumer scopes distinct. The saved archive already has historical 95-public/41-strict evidence; do not present it as fresh execution.
3. Complete offline production installation/import and relocation using a copy of the exact archive while the candidate source path is unavailable. Verify every payload at both locations and disclose whether an existing cache was used. Preserve the original archive and logs.
4. Freeze the complete root-to-candidate diff, contracts, generated outputs and evidence. Run independent whole-change review under the local workflow. No 0.47 review pass was started before interruption. Apply its bounded review cycle; do not reset a spent review budget by renaming a candidate.
5. Resolve supported findings, preserve before/after evidence, and refresh affected checks. Integrate only after final clearance and a fresh root/dependency/conflict check; keep the 0.46 rollback. Then build and verify the integrated surface. Record exact package/review identity.
6. Native account eligibility, upload acceptance, IDs/control correlation, resource lifetime, rendering and delivery still need separately scoped evidence even after local integration. A failed/unsupported account path must not trigger automatic fallback or replay.

## Then: close the source and interoperability gaps

| Workstream | Next concrete investigation or implementation | Evidence required to finish |
| --- | --- | --- |
| Signed voice | Reconcile the connected voice forward path with AMR/AAC upload completion, identifier and control-event order. Read the [static follow-up](project-evidence/zalo-sdk-next-signed-voice-carrier-followup.md). | Exact caller-to-consumer chain and honest unresolved edges before API design; synthetic contract/receipt tests and separately scoped provider/recipient evidence. An enum or terminal URL alone is insufficient for native completion parity. |
| Trusted devices/auth | Approved native enrollment/relink with explicitly retained material; expiry/overflow/revoke; resolve password 18070/18071 continuation. | User-controlled phone/secret steps, durable accepted-state recovery, restart and provider acceptance. Historical signed lists cannot reconstruct a missing linking secret. |
| E2EE/history | Remaining content kinds, active recovery lifecycle, peer/session import, complete history/retention and reboot/reconnect behavior. | Native peer interoperability, durable atomic/replay/budget proofs and controlled end-to-end history reconciliation. Keep crypto identities and display threads distinct. |
| Phone/PC backup | Complete phone transfer, archive import, create/upload/restore/restart and key/credential rotation. | Explicitly authorized complete transfers with counts, partial-failure recovery and durable readback; synthetic encoding vectors alone do not prove restore. |
| Cloud/resource recovery | Establish phone key/self-session/resource interoperability and encrypted locator lifetime/renewal behavior. | Separately scoped credential/key actions, matching-account ownership and actual resource verification. Consumed stock/resource probe grants must not be reused. |
| Calls | Complete native signaling/media integration, consent, start/answer/end/error/reconnect lifecycle. | Supported native bridge/platform setup and controlled two-party call evidence. Source routes are discovery only. |
| Forwarding/account surface | Album and remaining media batches, native encrypted partitions/large-group fallback, clone/expired-source orchestration and unimplemented controls. | Per-kind producer/projection/correlation evidence, explicit action ownership, truthful partial/unknown outcomes, then recipient validation. |

## Definition of eventual SDK completion

Choose and record the installed app/version/platform scope; maintain an exhaustive operation/workflow inventory including socket controls, background recovery and defaults, not just HTTP paths. For every family, record implemented, intentionally excluded with rationale, or unresolved, and map public behavior to static evidence, meaningful local checks and required native/provider outcomes. Close authentication, session/trust/key lifecycles, history, media, calls and reconnect/restart paths at their consumer boundaries. Document unsupported platforms and server gates explicitly. A route count, API export count, green local suite or one release cannot substitute for this audit.

Repository hosting, CI, release packaging/versioning, credential-safe onboarding, compatibility policy and operational recovery also need explicit decisions before a public release. Keep publishing/merge/deployment authority separate. Current work ends with a developer handoff, not this eventual parity claim.
