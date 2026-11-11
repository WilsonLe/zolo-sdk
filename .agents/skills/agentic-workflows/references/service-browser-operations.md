# Provider operation channels

## Connected app operations

Use the provider's configured Codex plugin/connected app for remote account and
resource operations. This applies to Supabase, Cloudflare, DigitalOcean, Railway,
Vercel, PostHog, Polar, and other providers exposed through connected apps. Codex
owns connector authentication. Reuse healthy connections without onboarding them
again. This contract takes precedence over generic CLI, browser, and credential
setup guidance; provider skills add target and verification details.

1. Resolve the intended provider, account, project, environment, and resource from
   the request and project evidence before provider skill or tool discovery. Ask
   only for a genuinely ambiguous target. Discover available connected tools and
   load the applicable provider plugin instructions; never infer that a connection
   or operation exists merely because a workflow names it.
2. Verify connected identity/scope and the exact target through read-only tool
   metadata or operations. Use stable IDs and verify production/sandbox or branch
   where relevant. Connection presence, a matching name, a local link, or a previous
   login does not establish current access or select the intended target.
3. Use exposed tools for authorized reads and writes, retaining task authority,
   data minimization, provider confirmations, bounded results, and secret-safe
   output. A connection grants no new authority. Before consequential writes,
   capture nonsecret pre-state, target, effect, cost/data/traffic impact, verification,
   and recovery; recheck relevant state after drift.
4. Recover a missing, expired, or mismatched connection through Codex's plugin/
   connector flow and reverify the target. Let the user complete enforced private
   sign-in or human-only approval. If the provider connection, required operation,
   or permission is unavailable, report that exact blocker and continue independent
   work. Do not provision local CLI tokens, extract connector credentials, use raw
   HTTP/SDK account calls, or switch to dashboard management as an automatic
   fallback. Permission denial cannot be bypassed through another account/channel.
5. Read back saved state, observe asynchronous terminal status, and verify relevant
   live behavior before claiming completion. An acknowledgement or queued action
   alone is insufficient. On unknown write outcome, read back before retrying;
   do not duplicate writes or automatically send an inverse operation.
6. Report the actual tool/channel, verified target, sanitized operation, readback,
   live evidence, and gaps. Discovery, package checks, or a configured connection
   alone do not prove access, success, or fresh-agent adherence.

## Local development and runtime configuration

Git/GitHub repository delivery follows Standard Development Workflow's existing
commands and authentication contract. This service-provider policy introduces no
new repository credential store.

Local-only tools such as Supabase's local stack or a build/package command may
still be used when the repository requires them. They do not establish remote
identity and must not become authenticated account-management fallbacks.

Application SDKs, database connections, event capture, webhooks, and explicitly
selected media runtimes can need separate configuration or runtime secrets. Follow
the owning integration instructions and the project's approved secret mechanism;
never extract Codex connector authentication or reuse application keys as an agent
account-management fallback. Optional OpenRouter transcription is a separately
authorized runtime upload, not an account-management channel.

Agentic Workflows does not require a project-local CLI credential directory, token
installation, token export/import, or authentication-file copying between worktrees.
Exclude legacy agent authentication stores from bootstrap and packaging. Leave
existing credential files untouched; any cleanup, rotation, or migration needs its
own scope. Required application env files retain the existing safe-copy controls.

## Authority and completion evidence

Inspection/planning authorize reads only. Reuse the user's existing authority for
necessary in-scope operations; ask only for an unresolved target, material choice,
or effect outside that authority. Production, destructive effects, communications,
and new charges need authority covering their actual impact. A provider's enforced
human approval remains in force. Do not interpret an error or missing connector
as permission to broaden access or switch to legacy authentication.

Bound and sanitize logs and query results. Never dump authorization data, secrets,
raw customer/event data, database connection strings, or environment values. If a
tool would expose a secret without a supported concealed path, report the capability
limit before calling it. Verify configuration and workload behavior separately;
saved provider state alone does not prove DNS propagation or application health.
