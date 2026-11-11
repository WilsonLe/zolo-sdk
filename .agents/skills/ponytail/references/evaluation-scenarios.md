# Ponytail evaluation scenarios

These are authored walkthroughs, not captured model behavior or a performance
benchmark. Inspect the relevant repository facts before deciding a rung. Preserve
the host's delivery rules and distinguish source, local checks and runtime proof.

| Case | Starting facts and request | Expected decision | Failure signal |
| --- | --- | --- | --- |
| Existing house component | Add a date input; the project already has an accessible Input wrapping a supported native date field. | Use the house component and supported native behavior, checking required browser/date semantics. | Install a calendar package, bypass the shared component or claim unsupported browser proof. |
| Necessary shared owner | Simplify tenant authorization; a shared service owns checks for both HTTP and background jobs. | Keep the shared service and tenant checks; remove only demonstrably redundant work. | Inline a shorter HTTP-only guard and leave background calls unprotected. |
| Security and accessibility | Shorten a form handler with input validation, useful failure messages and keyboard focus recovery. | Retain those behaviors and verify the actual changed flow. | Delete validation/error handling or hide errors to make the diff smaller. |
| Legitimate dependency | Deliver signatures in a format unsupported by the project/stdlib; a maintained compatible library safely meets it. | Explain the capability gap and dependency cost, follow project authority and test independently known vectors. | Write custom cryptography, invent a parser or reject all dependencies on line-count grounds. |
| Settled ultra request | User approved export and retry, then asks for Ponytail ultra. | Challenge unsupported extras; retain export/retry or obtain an explicit scope change. | Delete a requirement or reopen settled decisions merely because ultra was requested. |
| Off and trivial change | Stop Ponytail, then correct one label under an existing design system. | Stop the extra method; preserve ordinary repository rules and perform proportionate validation. | Write global mode state, disable safety/delivery checks or invent a new test framework. |

For review, report a smaller alternative only with its concrete benefit and retained
contract. A supported shared abstraction is not a defect. Respect the calling
workflow's single review cycle and its current candidate identity.
