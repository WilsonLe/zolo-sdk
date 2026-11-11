# Browser selection

Remote provider management follows [the Codex connected-app contract](service-browser-operations.md).
Browser preferences do not replace that channel or authorize local-token setup or
dashboard fallback. Browser use below covers local verification, authenticated
sources, and supported human connection steps.

In Codex, prefer the Codex in-app browser for browser-based work, including
verification, provider dashboards, account setup, sign-in/OAuth, credential
creation, and authenticated source inspection. This is a preferred default;
the user's explicit browser, profile, or tab selection takes precedence.
Without a browser tool, give the user the exact URL and step to complete, then
resume non-browser verification. Never report an unperformed browser action.

1. Resolve the exact target and required account, interaction, and evidence
   capabilities. Preflight the Codex browser tool and read its documentation before operating a
   tab. Use a visible tab when the user needs to follow or complete a browser step.
2. Use that browser when it supports the required flow. In Codex, do not assume
   the in-app browser shares Chrome's sign-in state, extensions, private-window
   support, cookie export, or browser-specific behavior.
3. If it is unavailable or lacks a required capability, record the limitation
   and use an already-authorized supported browser that reaches the same target
   and account and proves the same claim. Honor an explicitly required browser
   or control channel; if no equivalent satisfies it, report the blocker.
   Switching browsers cannot bypass login, CAPTCHA, access, or policy gates.
4. Record the actual browser/channel and result. A screenshot alone does not
   prove interaction, and browser access does not prove a credential works in
   its intended CLI, API, or integration.

For other tasks, keep supported APIs, connectors, CLIs, and repository test suites
as the execution layer when the task requires them. This preference selects the browser
for browser steps; it does not replace non-browser checks or required engine
coverage. Do not request a new confirmation merely to use an equivalent browser
within existing task authority.

For credentials, verify the supported concealed transfer path before copying or
creating a secret. Never extract or expose passwords, tokens, cookies, clipboard
values, or browser storage in tool output, screenshots, logs, or evidence. If
private entry or human-only authentication is required, let the user complete
that step in the selected browser, then resume and verify the requested flow.

## Blocked source reads

For ordinary source reading, use the Codex built-in browser directly for Reddit
and sources already known to require a rendered or signed-in session. If web
search/fetch or a direct page read returns a block, login/age-verification notice,
JavaScript shell, or unusable content, open the same in-scope URL in that browser
through supported controls. Do not repeat the failed non-browser request or treat
its failure as proof that the browser cannot read the page. Honor the user's
explicit browser/profile/tab choice and any enforced tool or platform denial.

Make one browser attempt, inspect the rendered page, and report only what is
visible, with the actual URL and browser/channel. If login, age verification,
CAPTCHA, or consent needs the user's direct handling, hand off that step in the
same session and resume only after it is complete. If a gate, rate limit, paywall,
or permission denial persists, report the blocker; do not cycle browsers, alternate
hosts, proxies, or transports to evade it. Follow the selected skill's tab ownership
and cleanup rules, including on blocked or interrupted reads.

This fallback covers source inspection within the existing task scope. It does
not replace the provider connected-app channel above, media-download contracts,
or required verification channels. A blocked credential or service operation
still follows its owning contract. Browser access is not an exemption from a
site's access requirements and does not prove that hidden content was read.
