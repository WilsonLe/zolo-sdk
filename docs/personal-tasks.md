# Personal tasks

The personal to-do functions use the authenticated account's `boards` service. They cover creating and editing tasks, reading task details and changes, changing the current assignee's status, deleting a task, sending a reminder, and acknowledging reminders. These are separate from group announcements, polls, and reminder boards. The server still enforces feature availability, membership, and task permissions.

```ts
import {
  createPersonalTask, getPersonalTask, updatePersonalTask,
  setPersonalTaskStatus, getPersonalTaskChanges,
} from 'zalo-personal-sdk';

// api is an explicitly authenticated SDK API. These calls modify account data.
const created = await createPersonalTask(api, {
  content: 'Prepare the meeting notes',
  description: 'Meeting notes', // the provider's short task title
  assigneeIds: [api.getOwnId()],
  watcherIds: [],
});

const current = await getPersonalTask(api, created.id);
const changed = await updatePersonalTask(api, current, {
  content: 'Prepare and review the meeting notes',
});
await setPersonalTaskStatus(api, changed.id, 1);
```

`content` allows up to 2,000 UTF-16 code units and `description` up to 100, matching the installed constants. At least one assignee is required. The SDK accepts at most 100 distinct participant IDs, 100 distinct IDs per reminder call, 100 list records per request, and 10,000 updates or deletions per change page; these are local bounds, not verified server limits. Supply user and group IDs as positive decimal strings. Group selectors also accept the installed `g` prefix. Task and message IDs remain strings so large integers do not lose precision.

Task status is `-1` (waiting for response), `0` (in progress), or `1` (done). A new task starts at `0` when the authenticated user is an assignee, otherwise `-1`; an explicit initial status can be `-1` or `0`. `setPersonalTaskStatus` changes the authenticated assignee's status. The installed manager also updates that assignee's participant record locally; the SDK returns no fabricated task update, so fetch details again when needed.

An omitted due date becomes `-1` with date type `0` (no date). Positive due dates are Unix milliseconds, defaulting to date type `5` (custom). Other observed date types are `1` today, `2` tomorrow, `3` day after tomorrow, and `4` next week; the caller supplies the actual timestamp. `schedule` is `null` or the provider's `{ startTime, repeat, endTime }` object. For example, the installed encoder can emit `0 0 9 * * ? * | 1 d`; this is an extended cron expression derived from local wall-clock time, not an SDK timezone or recurrence engine. One-shot schedules use `endTime: startTime + 1000`; recurring schedules use `-1`. Supply an expression whose meaning you have established for the intended client and timezone.

`origin` optionally references an already submitted direct or group message through `threadType`, `threadId`, `messageId`, `clientMessageId`, `senderId`, and `messageType`. The SDK does not send a message or create a group as part of task creation. `source` defaults to `-1`; codes `1` through `8` are the installed UI attribution values. The manager turns its zero-valued chatbar-suggestion source into `-1`, so zero is not accepted here.

`updatePersonalTask(api, fetchedTask, changes)` uses a fetched task record because the wire update sends the full editable content, assignees, watchers, date, status, creator, origin metadata, and schedule. It preserves provider fields inside `extra`, removes the installed local-only `z_parsedTokens`, `msg_id`, and `message` fields, and omits `updateTime` as the ordinary edit UI does. It does not mutate the supplied record. Known response fields are normalized; other provider fields remain available. Participant objects retain provider status and other fields, with their ID normalized to `userId`. The installed classifier/editor also accept assignees as JSON strings or ID-keyed object maps; these normalize to the same array. Watcher arrays may also be JSON-encoded strings; their ID or object entries normalize to ID strings. Historical zero-valued due dates remain readable; an ordinary edit changes zero to `-1` and date type `0`, even when the old date hint was inconsistent. An explicitly contradictory new hint is rejected. Empty schedule objects normalize to inactive `null`; malformed active schedules are rejected.

Empty-string or null participant fields, including their JSON-encoded forms, normalize to empty arrays as the installed editor does. Reading such records is supported; editing a task with no assignees requires explicitly selecting at least one entry in `assigneeIds`. Malformed nonempty JSON and unsupported active participant shapes remain rejected.

The operation table uses paths relative to `/api/board/personal`. Account AES and the current common protocol version apply to all nine routes. POST requests place encrypted JSON in a form `params` field; GET requests place it in the query. Assignees, watchers, and `extra` are **separate JSON strings inside** create/update JSON. Schedule stays an object or `null`.

| Function | Method and path | Operation-specific wire fields |
| --- | --- | --- |
| `createPersonalTask` | POST `/todo/create` | Editable fields, `src`, `imei` |
| `updatePersonalTask` | POST `/todo/update` | `id`, editable fields, `creator`; no added `imei` |
| `getPersonalTask` | GET `/get` | `id`, `imei` |
| `deletePersonalTask` | GET `/delete` | `id` |
| `setPersonalTaskStatus` | GET `/todo/status` | `id`, `status`, `imei` |
| `listPersonalTasks` | GET `/list` | `scrollId`, `offset`, `limit`, JSON-string `queries`, `type` |
| `getPersonalTaskChanges` | GET `/todo/verify` | `scrollId`, `lastUpdatedTime`, `imei` |
| `remindPersonalTasks` | GET `/todo/ding` | Array `taskIds` |
| `acknowledgePersonalTaskReminders` | GET `/todo/dingack` | Array `taskIds` |

Create, update, and detail return the task record directly after account-envelope decoding. Status, delete, reminder, and reminder acknowledgment return `void`; their installed consumers do not depend on response fields, and successful empty acknowledgments are accepted. Sending a reminder is explicit and may notify assignees. Deletion is the provider's personal-task delete operation; the SDK does not assert it is merely a local hide or that it deletes associated chat messages.

## Listing and synchronization

`listPersonalTasks` exposes the proven `totalItems` count and the decoded `raw` provider object. The shipped list consumers only read `totalItems`, so the SDK deliberately does not invent an item-array name, next-page field, or list pagination completion rule. Options cover the observed roles (`all`, `creator`, `assignees`, `watchers`), unfinished/done status, and one conversation selector. `groupId` produces `extra.toUid` and `extra.isGroup` predicates; direct-chat selectors use `creatorId` or `assigneeId`. `type` maps `tasks` to `1`, `finished-tasks` to `2`, and `all` to `0`. The default is `tasks`, offset `0`, and limit `20`. Done-only queries omit the default role, matching the installed Done tab.

`getPersonalTaskChanges` provides the established task inventory contract:

```ts
// Keep this boundary unchanged for the entire run. Zero requests an initial sync.
const boundary = 0;
let scrollId = '';
for (;;) {
  const page = await getPersonalTaskChanges(api, { lastUpdatedTime: boundary, scrollId });
  // Persist task upserts, applicable deletions, and this cursor together.
  // Use task.updateTime and deletion.ts to avoid removing a newer local record.
  await applyTaskPage(page);
  scrollId = page.scrollId;
  if (page.complete) {
    // Only now commit the new server timestamp as a completed sync boundary.
    await finishTaskSync(page.timestamp);
    break;
  }
}
```

`updated` contains normalized full provider task records. `deleted` contains normalized `{ id, ts? }` records; the installed database deletion path also accepts primitive IDs, which the SDK converts to `{ id }`. Preserve missing `ts` as missing. Compare a deletion timestamp with the stored task's `updateTime` when both exist; the installed manager removes its cached task only when the deletion is newer. Timestamp and other provider fields are not discarded. `complete` means **both arrays are empty**, not merely that a cursor is empty. A missing response cursor normalizes to `''` as the installed verifier does. The helper fetches exactly one page and does not loop, retry, schedule background refreshes, or silently persist anything. Applications should bound their own runs and detect repeated pages/cursors.

All requests reject HTTP redirects. No operation automatically retries. A provider rejection retains its numeric `ZaloProtocolError.providerCode`; observed UI handling includes `166` for permission rejection and `212` for a missing task, without treating these as a universal exhaustive code list. An abort, transport failure, or malformed response after a mutation was submitted can leave the result unknown. Fetch/synchronize before deciding whether to repeat a create, edit, delete, status change, or reminder; blindly retrying can duplicate tasks or notifications. These fixtures do not establish current server behavior or successful live mutations.

## Static evidence and offline checks

Evidence is the installed Zalo `pc-dist/lazy/default-login-main-startup-shared-worker-znotification.4bb5e1e2c2e9bab4f7b3.js`, extracted as `desktop-shared.js`, SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. Offsets below are zero-based UTF-8 bytes, not JavaScript character indices.

| Offsets | Evidence |
| --- | --- |
| `14701038`, `14705938` | `BOARD: "boards"` and `getBoardDomain` service selection |
| `12514734`–`12517030` | Nine concrete request builders and IMEI/method differences |
| `3607780`–`3608620`, `12113780`–`12114560` | Create/update participant and extra JSON serialization |
| `3609250`–`3610730`, `6783550`–`6785000` | Ordinary update omits `updateTime`; local extra fields removed |
| `3615720`–`3617200`, `6770000`–`6772400` | Legacy assignee string/map and watcher JSON decoding, watcher objects, undated zero, and object schedule consumers |
| `3597230`–`3597900`, `1536484`–`1536800` | Status, date, source, list type, and content-size constants |
| `3602762`–`3603300`, `3607002`–`3607340` | Role/status/conversation query constructors and list count use |
| `3628550`–`3632900` | Verify cursor/boundary/empty-page logic, updated records and timestamped deletion |
| `6746231`–`6746710`, `6783763`–`6785000` | Schedule encoder, no-date sentinel, and reminder object |
| `4281600`–`4282800` | Submitted-message origin metadata used when creating a task |
| `1377998`, `1380759`, `1381114` | Reminder and acknowledgment consumers pass task-ID arrays |
| `13736118` onward | Common decrypted account response handling |

`test/personal-tasks.test.mjs` decrypts synthetic requests independently and returns encrypted synthetic provider responses. It checks all nine routes, nested serialization, metadata preservation, large IDs, exact filters and fixed-boundary change pages, empty acknowledgments, invalid input, provider failures, unsupported services, cancellation, sanitized transport errors, and malformed responses. No live task API was called.

On 6 November 2026, a saved Desktop session successfully bootstrapped and read the profile, then an explicit one-page task-list read with limit one returned provider code -69. No task mutation was submitted. This is a measured refusal, not accepted task-list interoperability or proof of its cause.
