---
name: zalo-reverse-engineering
description: Use when tracing installed Zalo artifacts or implementing a missing personal-account SDK operation from source evidence.
---

Read [project handoff](../../../docs/project-handoff.md) and [roadmap](../../../docs/project-roadmap.md). Read the existing operation guide and owner before adding abstractions. Use the local engineering-exploration, engineering-diagnosis and engineering-review skills for their applicable stages.

1. Establish the exact installed app/archive and member SHA-256 identities. Reuse matching cached evidence. Do not assume the historical app is still installed unchanged.
2. Trace a concrete caller through feature/default gates, request serialization, transport, response/control correlation, projection and final consumer. Record UTF-8 byte offsets and hashes; route names and enums alone are discovery evidence.
3. Separate observations, inferences and unknowns. Preserve large decimal IDs as strings. Keep crypto UID, display thread, action ID and message ID distinct. Never infer current account eligibility or delivery from static code.
4. Extend existing input, transport, realtime, action/receipt and error owners. Keep input snapshots, cancellation, total deadlines, partial progress and uncertain outcomes explicit. Never automatically replay an uncertain mutation.
5. Validate with synthetic identities and local fixtures first. Independent consumer expectations should come from the contract. Run focused checks, strict installed declarations, package/export checks and independent review appropriate to the change.
6. Live account calls, phone approval, trusted-device/key publication, credential rotation, message sends and target-controlled native/WASM execution require their own concrete scope and necessary user action. Historical one-shot approvals are not reusable grants. Keep credentials and message contents out of source, reports and logs.
7. Finish by updating the operation status, source evidence and remaining gaps. A local pass is not native/provider interoperability. Preserve an unintegrated candidate rather than silently promoting it.

Optional REA: discover the available tools and bind an exact artifact before analysis. Do not require REA to read cached JavaScript. If unavailable, use format-aware archive inspection and bounded text searches; label inference limits. Do not execute extracted app code just to inspect it.
