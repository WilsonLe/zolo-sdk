# Automatic session titles

The Codex `UserPromptSubmit` command hook runs `hooks/title_background.py` with
`"async": true`. The prompt turn continues immediately. The hook performs generation **and**
the exact-session title write in the background; it does not inject work into the foreground
agent.

The worker reads the current thread from the local Codex thread store and the bundled Codex
app-server. It reads only the originating thread ID. Its context comes from the current prompt
and a bounded selection of genuine `user.text` messages in that thread's exact rollout file:
the original objective and the latest corrections. Synthetic instructions, goal context, tool
output, and messages from other threads are excluded. Prompt text is not stored in the title
ledger. The rollout format and local store are host interfaces that can change; missing or
unrecognized state causes a no-write result. The worker never scans unrelated threads.

Codex goal continuations use a reserved leading `<codex_internal_context>` envelope. The
hook ignores these events before advancing the title ledger, so they cannot rename the task
or invalidate a title being generated for a real user message. When a rollout message mixes
user text with goal, collaboration-mode, environment, or other instruction parts, the worker
selects only the parts tagged `user.text` using the aligned `content_item_kinds` metadata.
Ambiguous mixed metadata leaves the title unchanged. A matching synthetic transcript message
cannot be reintroduced through the raw hook-prompt fallback; that fallback is only used when
the current submission has not reached the rollout yet.

Genuine requests, terse continuations, and steering remain eligible across permission modes,
including Plan, and while goal mode is active. Run-mode modifiers do not become title context
or change the isolated title-generation model. The hook does not start, pause, complete, or
otherwise update the foreground goal, its budget, or collaboration mode.

Generation uses `codex exec --ephemeral --ignore-user-config` in an empty temporary directory
with hooks, plugins, memory, shell, apps, browser, and delegation disabled. The default fast
model is `gpt-5.6-luna`, with reasoning explicitly `low`. Set
`AGENTIC_WORKFLOWS_TITLE_MODEL` only to another verified supported fast model. The model has a
12-second deadline; the background hook has a 30-second ceiling. A failed, malformed, or
rerouted response does not change the title. No extra sidebar chat is created. The model
returns only a title, never an answer to the user's request.

Titles have at most **10 whitespace-delimited words** and 100 characters. Reject empty,
multiline, sensitive, or overlong output rather than truncating away meaning. Preserve the
active subject through terse approvals, apply the newest correction, and do not invent issue,
PR, completion, or deployment status.

Before generation and immediately before writing, the worker checks the exact local thread's
title and archived status, plus its pin membership in the Codex app sidebar state. The
local thread database's pin bit alone does not reflect every app pin. It preserves pinned,
archived, manually renamed, and
opted-out sessions. With no recorded automatic title, it preserves a nonempty title except on
the first genuine user turn or after explicit opt-in. A user can opt out with
`hooks/session_title.py disable SESSION_ID --file STATE_FILE` and opt back in with `enable`.
The state file defaults to `${PLUGIN_DATA}/session-titles-v1.json` and stores opaque IDs, event
sequence, bounded seen IDs, opt-out/opt-in state, and the last verified title, not messages.

The worker checks its event sequence before the write, skips unchanged titles, reads back the
exact title, and records only a successful readback. A newer event discards an older generated
result. A new steering message within the same turn gets its own evaluation; exact repeat
submissions in the last 64 events are ignored using salted message fingerprints. The host does not provide a
transactional compare-and-set across pin/manual changes and title writes; recheck immediately
before writing and never claim a stronger guarantee. Unsupported Codex environments leave titles unchanged.

For release evidence, verify a real installed, trusted hook on successive user turns, including
a terse continuation and a correction. Compare the visible app title with the worker's exact
readback, and exercise pinned/manual protection, stale generation, unavailable host APIs, and
failure paths. Local tests and direct app-server probes alone do not establish installed-hook
behavior.
Include goal auto-continuations between real user messages and a user correction with run-mode
modifiers: internal turns should leave the title intact, while the correction remains eligible.
