# Callback Execution and Voice-Agent Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make confirmed callbacks execute exactly once through Sarvam for the two approved demo numbers, ingest call outcomes and transcripts, and turn observed failures into reviewable regression cases and prompt recommendations without automatically changing the live agent.

**Architecture:** Extend the existing Node.js bridge as the sole writer for callbacks, call events, evaluation jobs, regression cases, and recommendations. A one-second scheduler dispatches due bookings through a small Sarvam adapter, while token-authenticated Sarvam webhooks persist results before asynchronous evaluation. A separate unprivileged worker calls the installed Hermes runtime with no tools and returns strict JSON to loopback-only bridge endpoints; all prompt changes remain human-approved.

**Tech Stack:** Node.js ESM, native `fetch`, `node:http`, Zod 4, atomic JSON files, `node:test`, systemd, nginx, Python wrapper around the installed Hermes Agent runtime, GPT-5.6 Sol through `openai-codex`.

**Spec:** [`docs/superpowers/specs/2026-08-23-callback-feedback-loop-design.md`](../specs/2026-08-23-callback-feedback-loop-design.md)

## Global Constraints

- [ ] Never call a real phone number from unit tests, integration tests, deployment checks, or dry-run verification.
- [ ] Keep `CALLBACK_DISPATCH_MODE=disabled` as the code and fresh-install default. This plan stops at `dry_run`; switching to `live` requires a separate approval.
- [ ] Enforce the allowlist in both booking validation and outbound dispatch: `918639885985` and `918688664337` only.
- [ ] Treat one confirmed booking as consent for one call at one time. Never auto-redial `busy`, `no_answer`, `failed`, or `dispatch_unknown` records.
- [ ] Never commit Sarvam keys, bridge tokens, webhook tokens, OAuth credentials, transcripts, phone hashes, or VPS state.
- [ ] Never log full phone numbers, transcript text, operator feedback text, authorization headers, or generated Hermes prompts.
- [ ] Keep the HTTP bridge as the only process that mutates JSON stores. The feedback worker claims and completes jobs over loopback HTTP so two processes cannot overwrite the same atomic JSON file.
- [ ] Remove the stale `Priya` identity from user-facing copy and documentation. Use neutral wording such as `our website specialist`.
- [ ] Run each task's focused test before the full suite, and commit only after both pass.

## File Map

### Existing files to modify

- `src/message.js`: import the shared phone allowlist and remove the stale agent name.
- `src/callback.js`: validate explicit confirmation and callback time bounds.
- `src/callback-store.js`: add serialized mutations, transition history, recovery, and lookup by attempt/interaction.
- `src/server.js`: add Sarvam webhooks, feedback APIs, worker APIs, and expanded health output.
- `src/index.js`: load configuration, open stores, and start/stop schedulers and processors.
- `package.json`: include Python syntax checks and recommendation CLI scripts.
- `deploy/elevate-whatsapp-bridge.service`: pin state paths and callback mode.
- `deploy/nginx-location.conf`: block worker-only endpoints from the public proxy.
- `docs/demo-runbook.md`: document callback proof, dry-run gates, feedback review, and neutral agent wording.
- `assets/architecture.html` and `assets/architecture.png`: show callback execution and the controlled feedback loop.

### New production files

- `src/phone-policy.js`: normalization, allowlist checks, hashing, and safe phone labels.
- `src/config.js`: strict environment parsing and mode-specific requirements.
- `src/callback-state.js`: callback states and legal transitions.
- `src/sarvam-outbound.js`: Instant Outbound payload construction and HTTP adapter.
- `src/callback-scheduler.js`: due-job polling, expiry, recovery, and dispatch orchestration.
- `src/persistent-record-store.js`: bounded single-writer JSON store for new record types.
- `src/call-event.js`: strict webhook and on-end schemas plus normalized event records.
- `src/sarvam-analytics.js`: bounded transcript backfill client.
- `src/evaluator.js`: deterministic conversation and reliability checks.
- `src/feedback-loop.js`: evaluation jobs, regression cases, recommendation grouping, and approval records.
- `src/event-processor.js`: transcript backfill, deterministic evaluation, retention, and Hermes queueing.
- `src/feedback-worker.js`: loopback job claimant and Hermes process supervisor.
- `worker/hermes_eval.py`: tool-free Hermes runtime adapter with strict JSON validation.
- `bin/recommendations.js`: read-only listing plus explicit approve/reject recording.
- `deploy/elevate-feedback-worker.service`: hardened unprivileged worker.
- `deploy/elevate-feedback-worker.env.example`: non-secret variable names and safe defaults only.

### New test files and fixtures

- `test/phone-policy.test.js`
- `test/config.test.js`
- `test/callback-state.test.js`
- `test/sarvam-outbound.test.js`
- `test/callback-scheduler.test.js`
- `test/persistent-record-store.test.js`
- `test/call-event.test.js`
- `test/sarvam-analytics.test.js`
- `test/evaluator.test.js`
- `test/feedback-loop.test.js`
- `test/event-processor.test.js`
- `test/feedback-worker.test.js`
- `test/integration/callback-lifecycle.test.js`
- `test/fixtures/calls/good-concise.json`
- `test/fixtures/calls/missed-booking.json`
- `test/fixtures/calls/stored-not-dispatched.json`
- `test/fixtures/calls/stacked-questions.json`
- `test/fixtures/calls/repeated-acknowledgements.json`
- `test/fixtures/calls/consecutive-agent-turns.json`
- `test/fixtures/calls/interruption-without-timing.json`

---

## Task 1: Centralize Phone Policy and Tighten the Booking Contract

**Files:**
- Create: `src/phone-policy.js`
- Create: `test/phone-policy.test.js`
- Modify: `src/message.js`
- Modify: `src/callback.js`
- Modify: `test/message.test.js`
- Modify: `test/callback.test.js`

- [ ] **Step 1: Write failing phone-policy tests**

Cover `+91 86398 85985`, `918639885985`, and `+91-86886-64337` normalization; rejection of malformed or non-Indian values; last-four labels; deterministic salted hashes; and the exact two-number allowlist.

```js
assert.equal(normalizeIndianPhone("+91 86398 85985"), "918639885985");
assert.equal(assertAllowedRecipient("+91-86886-64337"), "918688664337");
assert.throws(() => assertAllowedRecipient("+919999999999"), /allowlist/);
assert.equal(redactPhone("918639885985"), "********5985");
assert.equal(hashPhone("918639885985", "test-salt"), hashPhone("+91 86398 85985", "test-salt"));
```

- [ ] **Step 2: Write failing callback-contract tests**

Extend the valid fixture with these fields and assert each failure separately:

```js
confirmed_by_user: true,
confirmed_at: "2026-08-22T12:00:00.000Z",
source_interaction_id: "interaction-123",
```

Test the 15-second minimum, seven-day maximum, `confirmed_by_user: false`, absent confirmation time, destination normalization, and unknown fields. Inject `now` so tests never depend on wall-clock time.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run: `node --test test/phone-policy.test.js test/callback.test.js test/message.test.js`

Expected: failures for missing exports and the not-yet-enforced confirmation/time rules.

- [ ] **Step 4: Implement `src/phone-policy.js`**

Export these exact interfaces:

```text
ASSIGNMENT_RECIPIENT: "918688664337"
CONTROLLED_TEST_RECIPIENT: "918639885985"
ALLOWED_RECIPIENTS: readonly array containing exactly those two values
normalizeIndianPhone(value) -> normalized 12-digit string or throws
assertAllowedRecipient(value) -> normalized allowlisted string or throws
redactPhone(value) -> seven asterisks plus last four digits
hashPhone(value, salt) -> lowercase SHA-256 hex digest
```

Normalization removes spaces, parentheses, and hyphens, converts a ten-digit Indian mobile number matching `[6-9][0-9]{9}` to `91` plus ten digits, and rejects every other shape. `assertAllowedRecipient` must compare the normalized value against `ALLOWED_RECIPIENTS` and return the normalized digits. `hashPhone` uses HMAC-SHA-256 with the salt as the key rather than concatenating secret and phone text.

- [ ] **Step 5: Update message and callback parsing**

Move the phone constants out of `message.js`, import them from `phone-policy.js`, and preserve the existing exports from `message.js` for compatibility. Change Zod destination fields to validated strings transformed by `assertAllowedRecipient` rather than `z.enum`, then add the confirmation fields.

In `parseCallbackRequest`, calculate the delay once and enforce:

```js
const delayMs = Date.parse(parsed.callback_time_iso) - now.getTime();
if (delayMs < 15_000) throw new Error("Callback must be at least 15 seconds in the future");
if (delayMs > 7 * 24 * 60 * 60 * 1000) throw new Error("Callback must be within seven days");
```

Also require `confirmed_at <= now`. Keep `source_interaction_id` optional because Sarvam does not expose it in every tool context; persist `null` when absent so evaluation can identify missing provenance.

- [ ] **Step 6: Remove stale agent-name copy**

Change both `Thanks for speaking with Priya` strings in `formatMessage` to `Thanks for speaking with our website specialist`, then update assertions in `test/message.test.js`.

- [ ] **Step 7: Run focused and full tests**

Run: `node --test test/phone-policy.test.js test/callback.test.js test/message.test.js`

Run: `npm test`

Expected: all tests pass; no network request is made.

- [ ] **Step 8: Commit**

```bash
git add src/phone-policy.js src/message.js src/callback.js test/phone-policy.test.js test/message.test.js test/callback.test.js
git commit -m "feat: enforce callback consent and phone policy"
```

---

## Task 2: Add the Durable Callback State Machine

**Files:**
- Create: `src/callback-state.js`
- Create: `test/callback-state.test.js`
- Modify: `src/callback-store.js`
- Modify: `test/callback-store.test.js`

- [ ] **Step 1: Write failing transition tests**

Define and test the legal matrix exactly:

```js
const LEGAL_TRANSITIONS = {
  scheduled: new Set(["dispatching", "expired"]),
  dispatching: new Set(["dialing", "failed", "dispatch_unknown"]),
  dialing: new Set(["connected", "no_answer", "busy", "failed"]),
  connected: new Set(),
  no_answer: new Set(),
  busy: new Set(),
  failed: new Set(),
  dispatch_unknown: new Set(),
  expired: new Set(),
};
```

Assert that every listed transition succeeds and representative invalid transitions such as `connected -> dialing`, `failed -> dispatching`, and `dispatching -> busy` throw without mutating the record.

- [ ] **Step 2: Write failing persistence and recovery tests**

Test these cases in `test/callback-store.test.js`:

- a booking contains `history` beginning with a `scheduled` transition;
- `transition(bookingId, "dispatching", metadata)` persists before it resolves;
- an attempt ID and interaction ID can be indexed and looked up;
- an interrupted persisted `dispatching` booking becomes `dispatch_unknown` on recovery;
- a scheduled job at most ten minutes overdue remains dispatchable;
- a scheduled job more than ten minutes overdue becomes `expired`;
- two concurrent mutations are serialized and both survive reopening;
- the dispatcher can query due records without returning terminal records.

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `node --test test/callback-state.test.js test/callback-store.test.js`

- [ ] **Step 4: Implement the state module and store APIs**

Export:

```text
CALLBACK_STATES -> immutable array of every LEGAL_TRANSITIONS key
assertTransition(from, to) -> true or throws without mutation
transitionRecord(booking, to, transition) -> new frozen booking record
```

Add these store methods:

```js
async transition(bookingId, to, transition)
async recover(now)
getByAttemptId(attemptId)
getByInteractionId(interactionId)
listDue(now)
countPending()
```

All mutations must run through a private promise chain. The mutation is applied, atomically persisted, and only then becomes visible to the next mutation. Persist `attempt_id`, `interaction_id`, and `dispatched_agent_version` only through transition metadata.

- [ ] **Step 5: Preserve bounded-store indexes**

When records are evicted, remove request, attempt, and interaction indexes. On `load()`, validate the file is an array, validate each state, rebuild all indexes, and fail closed on corrupt state.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test test/callback-state.test.js test/callback-store.test.js`

Run: `npm test`

- [ ] **Step 7: Commit**

```bash
git add src/callback-state.js src/callback-store.js test/callback-state.test.js test/callback-store.test.js
git commit -m "feat: persist callback lifecycle transitions"
```

---

## Task 3: Parse Configuration and Build the Sarvam Outbound Adapter

**Files:**
- Create: `src/config.js`
- Create: `src/sarvam-outbound.js`
- Create: `test/config.test.js`
- Create: `test/sarvam-outbound.test.js`

- [ ] **Step 1: Write failing configuration tests**

Test that no mode means `disabled`; `disabled` can start without Sarvam variables; providing any Sarvam variable requires the complete Sarvam group; `dry_run` and `live` require that complete group; and `SARVAM_APP_VERSION` must be a positive integer. The complete group includes every Sarvam identifier, API key, HTTPS webhook base URL, webhook token of at least 32 characters, and phone-hash salt of at least 32 characters. A fully configured `disabled` service still ingests webhooks and evaluations while refusing to dispatch callbacks.

The exported interface is:

```js
export function loadConfig(env = process.env) {
  return {
    callbackDispatchMode: "disabled",
    sarvam: null,
    phoneHashSalt: null,
    webhookToken: null,
    feedbackWorkerToken: null,
  };
}
```

The implementation fills the Sarvam values when the complete group is configured, independent of callback mode. It fills worker values only when the complete worker-token group is configured.

- [ ] **Step 2: Write failing outbound-adapter tests with injected `fetch`**

Assert the exact request:

```js
{
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": "sarvam-test-key",
  },
  body: JSON.stringify({
    app_config: {
      app_id: "app-test",
      app_version: 7,
      connection_config: {
        connection_id: "connection-test",
        agent_phone_number: "+918071581315",
      },
      agent_variables: {
        prospect_name: "Srikar",
        callback_context: "Requested a five-minute callback",
      },
    },
    user_config: { user_phone_number: "+918639885985" },
    webhook_config: {
      url: "https://example.test/elevate-whatsapp/v1/sarvam/outbound-events/webhook-token-with-32-characters",
      metadata: {
        booking_id: "cb-1111111111111111",
        request_id: "call-123:callback",
      },
    },
  }),
}
```

Also test that the adapter normalizes and independently checks the destination, validates a UUID-like or non-empty `attempt_id`, rejects an invalid 200 body, and classifies failures as:

- `rejected`: HTTP 400, 401, 403, 404, 409, or 422;
- `unknown`: timeout, socket error, HTTP 429, or HTTP 5xx.

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `node --test test/config.test.js test/sarvam-outbound.test.js`

- [ ] **Step 4: Implement config parsing and payload construction**

Use the documented endpoint:

```text
https://apps.sarvam.ai/api/outbounds/v1/orgs/{org_id}/workspaces/{workspace_id}/outbounds
```

Use `X-API-Key`, an eight-second `AbortSignal.timeout`, and `response.text()` followed by guarded JSON parsing so an HTML error page cannot enter state. Export:

```text
buildOutboundPayload(booking, config) -> validated Sarvam request body
createSarvamOutboundClient(options) -> object exposing createCall(booking)
```

The client exposes `createCall(booking)` and returns `{ attemptId, payload }` only on a valid HTTP 200 response. It never accepts app version or connection data from a booking.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/config.test.js test/sarvam-outbound.test.js`

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/sarvam-outbound.js test/config.test.js test/sarvam-outbound.test.js
git commit -m "feat: add guarded Sarvam outbound adapter"
```

---

## Task 4: Execute Due Callbacks Without Duplicate Calls

**Files:**
- Create: `src/callback-scheduler.js`
- Create: `test/callback-scheduler.test.js`
- Modify: `src/index.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: Write failing scheduler tests**

Build the scheduler around an explicit `runOnce(now)` method and injected timer functions. Cover:

- `disabled` mode does not query or mutate due jobs;
- `dry_run` writes one redacted outbound-event record and transitions `scheduled -> expired` with reason `dry_run_completed_without_call` without calling `fetch`;
- `live` persists `dispatching` before calling the adapter;
- a successful adapter response records `dialing`, `attempt_id`, and configured app version;
- a definitive rejection records `failed` without retry;
- an uncertain failure records `dispatch_unknown` without retry;
- a poll cannot overlap the previous poll;
- restart recovery marks persisted `dispatching` as `dispatch_unknown` before polling;
- due jobs are processed serially, keeping concurrency at one;
- stopping clears the timer and waits for the active poll.

- [ ] **Step 2: Run the scheduler test and confirm RED**

Run: `node --test test/callback-scheduler.test.js`

- [ ] **Step 3: Implement scheduler interfaces**

Export:

```text
createCallbackScheduler({
  mode, store, outboundClient, outboundEventStore, appVersion,
  clock, intervalMs, setIntervalImpl, clearIntervalImpl, logger
}) -> { start, stop, runOnce, status }
```

Return `{ start, stop, runOnce, status }`. `runOnce` must set and clear an internal active promise in `finally`. Log only booking ID, state, mode, attempt ID, and redacted last four digits.

- [ ] **Step 4: Wire scheduler lifecycle into `src/index.js`**

Open all required stores before `transport.start()` and before `server.listen()`. Execute callback-store recovery before scheduler start. Shutdown order is:

1. stop accepting HTTP;
2. stop callback scheduler;
3. stop event processor;
4. stop WhatsApp transport;
5. exit.

Pass scheduler status and counts into the health view; do not read environment variables inside `server.js`.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/callback-scheduler.test.js test/server.test.js`

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/callback-scheduler.js src/index.js test/callback-scheduler.test.js test/server.test.js
git commit -m "feat: dispatch due callbacks exactly once"
```

---

## Task 5: Persist and Validate Sarvam Call Events

**Files:**
- Create: `src/persistent-record-store.js`
- Create: `src/call-event.js`
- Create: `test/persistent-record-store.test.js`
- Create: `test/call-event.test.js`

- [ ] **Step 1: Write failing generic-store tests**

Test atomic persistence, deterministic IDs, bounded eviction, single-writer serialization, deduplication, reopening, corrupt-file failure, updates, and retention deletion.

Export:

```text
PersistentRecordStore.open({ filePath, idField, maxRecords }) -> Promise<store>
store.get(id) -> record or undefined
store.list(predicate) -> copied record array
store.count(predicate) -> non-negative integer
store.put(record) -> Promise<{ record, duplicate }>
store.update(id, updater) -> Promise<updated record>
store.deleteWhere(predicate) -> Promise<number deleted>
```

- [ ] **Step 2: Write failing event-schema tests**

For instant-outbound webhooks, accept only the documented statuses, channel types, transcript roles, nullable fields, and echoed metadata. Reject unknown top-level and nested fields.

For the configurable on-end hook, define this strict bridge-owned contract:

```json
{
  "interaction_id": "interaction-123",
  "app_id": "app-test",
  "app_version": 7,
  "status": "connected",
  "duration": 93.2,
  "user_phone_number": "+918639885985",
  "final_agent_variables": {"intent_level":"Hot"},
  "interaction_transcript": [
    {"role":"agent","en_text":"Hello, is now a good time?"},
    {"role":"user","en_text":"Yes, go ahead."}
  ],
  "tool_results": [
    {"name":"schedule_callback","status":"success","booking_id":"cb-1111111111111111"}
  ]
}
```

The configurable mapping in Sarvam must produce this contract. `tool_results` may be empty but not omitted. The phone is normalized, compared to the same two-number allowlist, then replaced in the persisted event by `phone_hash` and `phone_last4`.

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `node --test test/persistent-record-store.test.js test/call-event.test.js`

- [ ] **Step 4: Implement normalized event records**

Export:

```text
parseOutboundEvent(value, context) -> normalized redacted event or throws
parseOnEndEvent(value, context) -> normalized redacted event or throws
eventIdFor(value) -> deterministic `evt-` identifier
```

Normalized records contain event ID, source, attempt/interaction IDs, status, duration, failure class, app/version, final variables, tool results, transcript, phone hash/last four, correlation metadata, `transcript_status`, `evaluation_status`, and received timestamp. They never contain a full destination or agent phone number.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/persistent-record-store.test.js test/call-event.test.js`

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/persistent-record-store.js src/call-event.js test/persistent-record-store.test.js test/call-event.test.js
git commit -m "feat: persist redacted Sarvam call events"
```

---

## Task 6: Add Webhook Routes and Transcript Backfill

**Files:**
- Create: `src/sarvam-analytics.js`
- Create: `test/sarvam-analytics.test.js`
- Modify: `src/server.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: Write failing analytics-client tests**

Use injected `fetch` to assert a GET to:

```text
https://apps.sarvam.ai/api/analytics/v1/{org_id}/{workspace_id}/{app_id}/transcripts/{interaction_id}
```

Assert `X-API-Key`, URL encoding of every segment, eight-second timeout, strict transcript-turn parsing, and failure classification. No test may access `apps.sarvam.ai`.

- [ ] **Step 2: Write failing server-route tests**

Add helpers that post directly to:

```text
/v1/sarvam/outbound-events/{token}
/v1/sarvam/on-end/{token}
```

Test correct token, incorrect token, malformed body, oversized body, deduplication, persist-before-200 ordering, correlation to a known booking, state updates for all four Sarvam statuses, and redacted structured logging. These two routes do not use the bridge bearer secret.

Also test expanded health output:

```json
{
  "ok": true,
  "whatsapp": "connected",
  "callbackScheduler": "running",
  "callbackDispatchMode": "dry_run",
  "sarvamConfigured": true,
  "pendingCallbacks": 0,
  "pendingEvaluations": 0
}
```

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `node --test test/sarvam-analytics.test.js test/server.test.js`

- [ ] **Step 4: Implement route authentication and correlation**

Match tokenized webhook routes before bearer-authenticated bridge routes. Compare the path token with `timingSafeEqual` through the existing digest-based helper. Persist the normalized event first, then apply a legal callback transition when `booking_id` or `attempt_id` correlates. A duplicate event returns HTTP 200 without enqueuing a duplicate evaluation.

For a missing transcript plus non-null interaction ID, persist `transcript_status: "pending"`; never fetch analytics inside the webhook request.

- [ ] **Step 5: Preserve existing API behavior**

Keep `/v1/messages`, `/v1/callbacks`, and callback status bearer-authenticated. The callback status response may add `attemptId`, `interactionId`, and the latest transition reason but must still omit context summaries and full numbers.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test test/sarvam-analytics.test.js test/server.test.js`

Run: `npm test`

- [ ] **Step 7: Commit**

```bash
git add src/sarvam-analytics.js src/server.js test/sarvam-analytics.test.js test/server.test.js
git commit -m "feat: ingest Sarvam outcomes and transcripts"
```

---

## Task 7: Build the Deterministic Evaluator and Event Processor

**Files:**
- Create: `src/evaluator.js`
- Create: `src/event-processor.js`
- Create: `test/evaluator.test.js`
- Create: `test/event-processor.test.js`
- Create: `test/fixtures/calls/good-concise.json`
- Create: `test/fixtures/calls/missed-booking.json`
- Create: `test/fixtures/calls/stored-not-dispatched.json`
- Create: `test/fixtures/calls/stacked-questions.json`
- Create: `test/fixtures/calls/repeated-acknowledgements.json`
- Create: `test/fixtures/calls/consecutive-agent-turns.json`
- Create: `test/fixtures/calls/interruption-without-timing.json`

- [ ] **Step 1: Write regression fixtures as complete JSON documents**

Every fixture contains `event`, `callback`, and `expected` keys. Use only fictional business details and the two approved last-four values. Do not place real transcript content from the user's calls in Git.

- [ ] **Step 2: Write failing deterministic-evaluator tests**

Define stable thresholds and deductions:

| Check | Trigger | Deduction |
| --- | --- | ---: |
| Long agent turn | More than 45 words | 8 per turn, capped at 24 |
| Stacked questions | More than one `?` in one turn | 10 per turn, capped at 20 |
| Consecutive agent turns | Two agent turns without a non-empty user turn | 15 per occurrence |
| Repeated sentence | Same normalized sentence twice | 10 per repeated sentence, capped at 20 |
| Agent/user ratio | Above 1.8 after at least 20 total words | 12 |
| Callback promise without booking | Explicit callback variable/tool intent and no booking | 40 |
| Due booking without attempt | Due live booking and no attempt | 50 |
| Tool promise without success | Declared tool action and no successful tool result | 30 |
| Missing required variable | business, products, features, budget, timeline, decision maker, or intent | 4 each, capped at 24 |

Start at 100, subtract applicable deductions, and floor at zero. Produce findings with codes, severity, turn indexes, and numeric evidence only. Mark `interruption: "not_scoreable"` unless transcript turns include timing or overlap fields.

- [ ] **Step 3: Run evaluator tests and confirm RED**

Run: `node --test test/evaluator.test.js`

- [ ] **Step 4: Implement evaluator output**

Export:

```js
export function evaluateDeterministically({ event, callback = null }) {
  return {
    score: 100,
    findings: [],
    interruption: "not_scoreable",
    metrics: {},
    insufficientEvidence: false,
  };
}
```

Do not infer a callback promise from free-form prose alone. Use `final_agent_variables.callback_requested`, a `schedule_callback` tool result, or correlated callback state.

- [ ] **Step 5: Write failing event-processor tests**

Cover:

- immediate evaluation when a transcript is present;
- three bounded backfill attempts at 30 seconds, two minutes, and ten minutes;
- `transcript_status: unavailable` after the third failure;
- deterministic evaluation still runs on non-connected calls;
- one Hermes job is created only when a transcript is available;
- an event persisted before a crash is replayed on restart to finish callback correlation without duplicating the event;
- records older than 30 days have transcript arrays removed while scores and finding codes remain;
- processing is idempotent across restart;
- processor stop waits for active work.

- [ ] **Step 6: Implement the processor and retention pass**

Return `{ start, stop, runOnce, status }` from `createEventProcessor`. Poll every five seconds, handle at most ten events per pass, persist after each step, and run transcript retention once at startup and once per hour. Never block callback dispatch on evaluation work.

- [ ] **Step 7: Run focused and full tests**

Run: `node --test test/evaluator.test.js test/event-processor.test.js`

Run: `npm test`

- [ ] **Step 8: Commit**

```bash
git add src/evaluator.js src/event-processor.js test/evaluator.test.js test/event-processor.test.js test/fixtures/calls
git commit -m "feat: score call reliability and conversation quality"
```

---

## Task 8: Store Operator Feedback, Regression Cases, and Recommendations

**Files:**
- Create: `src/feedback-loop.js`
- Create: `bin/recommendations.js`
- Create: `test/feedback-loop.test.js`
- Modify: `src/server.js`
- Modify: `test/server.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing feedback and recommendation tests**

Define the authenticated operator payload:

```json
{
  "request_id": "feedback-interaction-123",
  "interaction_id": "interaction-123",
  "category": "missed_callback",
  "severity": "critical",
  "note": "The agent promised five minutes but no callback arrived."
}
```

Categories are `missed_callback`, `talked_over_user`, `stacked_questions`, `robotic_repetition`, `wrong_intent`, `tool_failure`, and `other`. Severity is `low`, `medium`, `high`, or `critical`. Notes are trimmed, 1 to 1,000 characters, stored but never logged.

Test:

- authenticated `POST /v1/feedback` and request-id idempotency;
- rejection of unknown events, categories, and fields;
- one critical reliability failure immediately creates a candidate;
- a single ordinary style case does not create a candidate;
- two matching style cases across distinct interactions create one grouped candidate;
- candidate evidence uses event IDs, finding codes, turn indexes, and affected versions;
- approve/reject changes only recommendation state and never calls Sarvam;
- a promoted record requires a positive Sarvam version and passing regression fixture IDs.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/feedback-loop.test.js test/server.test.js`

- [ ] **Step 3: Implement feedback-loop interfaces**

Export:

```text
parseOperatorFeedback(value) -> strict normalized feedback record or throws
createFeedbackLoop(options) -> feedback-loop service methods
```

Return methods `recordOperatorFeedback`, `recordEvaluation`, `listRecommendations`, `approve`, `reject`, and `recordPromotion`. Recommendation records contain a minimal prompt delta, never a whole replacement prompt.

- [ ] **Step 4: Add the operator route**

`POST /v1/feedback` uses the existing bridge bearer token and rate limiter. Return the stable feedback ID and any recommendation ID only after all records are durable.

Add bearer-authenticated operator routes for `GET /v1/recommendations`, `GET /v1/recommendations/{recommendation_id}`, `POST /v1/recommendations/{recommendation_id}/approve`, `POST /v1/recommendations/{recommendation_id}/reject`, and `POST /v1/recommendations/{recommendation_id}/promote`. Every mutation goes through `feedbackLoop` in the running bridge and returns only after persistence. Unknown IDs return 404 and invalid state transitions return 409.

- [ ] **Step 5: Add the local recommendation CLI**

Add scripts:

```json
"recommendations": "node bin/recommendations.js"
```

Supported commands are:

```text
npm run recommendations -- list
npm run recommendations -- show REC_ID
npm run recommendations -- approve REC_ID
npm run recommendations -- reject REC_ID --reason "reason text"
npm run recommendations -- promote REC_ID --version 8 --fixtures fixture-a,fixture-b
```

The CLI calls bearer-authenticated loopback bridge routes for list, show, approve, reject, and promote operations. It never opens a JSON store directly, preserving the bridge's single-writer rule, and it never accesses the Sarvam API or dashboard.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test test/feedback-loop.test.js test/server.test.js`

Run: `npm test`

- [ ] **Step 7: Commit**

```bash
git add src/feedback-loop.js src/server.js bin/recommendations.js test/feedback-loop.test.js test/server.test.js package.json
git commit -m "feat: create human-reviewed voice feedback loop"
```

---

## Task 9: Add a Tool-Free Hermes GPT-5.6 Sol Worker

**Files:**
- Create: `worker/hermes_eval.py`
- Create: `src/feedback-worker.js`
- Create: `test/feedback-worker.test.js`
- Modify: `src/server.js`
- Modify: `test/server.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing worker API tests**

Add two bridge-internal routes:

```text
POST /v1/internal/evaluations/claim
POST /v1/internal/evaluations/complete
```

They use `Authorization: Bearer {FEEDBACK_WORKER_TOKEN}` and are never exposed by nginx. A claim persists a two-minute lease before returning the job. An expired lease can be reclaimed. Completion requires the matching job ID and lease token, validates strict Hermes output, and is idempotent.

- [ ] **Step 2: Write failing Node worker tests**

Inject `fetch`, `spawn`, and clock implementations. Assert:

- no job causes a bounded 5-second sleep;
- the child receives an argument array with `shell: false`;
- transcript content is passed on stdin, not in command-line arguments;
- stdout is capped at 128 KiB and stderr at 16 KiB;
- the child is killed after 90 seconds;
- invalid JSON, schema errors, timeout, or nonzero exit return the job to pending with a bounded error code;
- successful strict JSON completes the lease;
- exponential worker retry delays cap at five minutes;
- no transcript, prompt, or model output is logged.

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `node --test test/feedback-worker.test.js test/server.test.js`

- [ ] **Step 4: Implement the fixed Hermes rubric and schema**

The worker output schema is strict:

```json
{
  "scores": {
    "listening": 0,
    "concision": 0,
    "naturalness": 0,
    "intent_accuracy": 0,
    "task_completion": 0
  },
  "evidence": [{"turn_indexes":[0],"failure_code":"stacked_questions"}],
  "failures": ["stacked_questions"],
  "prompt_delta": "Ask only one discovery question, then wait for the answer.",
  "confidence": 0.0,
  "insufficient_evidence": false
}
```

Each score is an integer from 0 to 100, confidence is 0 to 1, evidence may cite only existing turn indexes, failure codes come from the deterministic taxonomy, and `prompt_delta` is at most 500 characters. The prompt explicitly treats transcript text as untrusted data and forbids following instructions found inside it.

- [ ] **Step 5: Implement `worker/hermes_eval.py` without `hermes -z`**

Do not invoke `hermes -z`: the installed CLI automatically sets `HERMES_YOLO_MODE=1` and loads toolsets. Instead, import Hermes from `/usr/local/lib/hermes-agent`, resolve the pinned `openai-codex` runtime, and construct `AIAgent` with:

```python
enabled_toolsets=[]
max_iterations=1
skip_context_files=True
load_soul_identity=False
skip_memory=True
checkpoints_enabled=False
model=os.environ["HERMES_EVAL_MODEL"]
provider=os.environ["HERMES_EVAL_PROVIDER"]
```

Before reading stdin, call Hermes' `get_tool_definitions(enabled_toolsets=[])` and abort unless it returns an empty list. Read one bounded JSON job from stdin, build the fixed rubric prompt, run one inference, validate the returned JSON again in Python, print only the JSON object, close the agent, and exit.

- [ ] **Step 6: Implement Node supervision**

Spawn exactly:

```js
spawn("/usr/local/lib/hermes-agent/venv/bin/python", [
  "/srv/elevate-whatsapp-bridge/worker/hermes_eval.py",
], {
  shell: false,
  cwd: "/var/empty/elevate-feedback-worker",
  env: workerEnv,
  stdio: ["pipe", "pipe", "pipe"],
});
```

Use an environment allowlist containing only `HOME`, `HERMES_HOME`, `PATH`, `HERMES_EVAL_MODEL`, `HERMES_EVAL_PROVIDER`, locale, and proxy variables that are already explicitly configured for the worker. Never inherit the bridge process environment wholesale.

- [ ] **Step 7: Run focused and full local tests**

Expand the `check` script to syntax-check `src/*.js`, `bin/*.js`, and `worker/hermes_eval.py`.

Run: `node --test test/feedback-worker.test.js test/server.test.js`

Run: `python3 -m py_compile worker/hermes_eval.py`

Run: `npm test && npm run check`

- [ ] **Step 8: Commit**

```bash
git add worker/hermes_eval.py src/feedback-worker.js src/server.js test/feedback-worker.test.js test/server.test.js
git commit -m "feat: evaluate call feedback with tool-free Hermes"
```

---

## Task 10: Prove the Full Lifecycle Against a Fake Sarvam Server

**Files:**
- Create: `test/integration/callback-lifecycle.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing end-to-end integration test**

Start a local fake Sarvam HTTP server and the bridge on random loopback ports. Use a fake clock and explicit scheduler ticks; never sleep for five real minutes.

The primary test must:

1. book `918639885985` for five minutes in the future using explicit confirmation;
2. advance the fake clock and run one poll;
3. observe exactly one outbound request with the configured app version;
4. return `attempt_id: "attempt-test-1"` and assert `dialing`;
5. post a connected webhook with a two-turn transcript;
6. assert the booking is `connected` and the event is durable;
7. run the event processor and assert a deterministic evaluation and one Hermes job;
8. simulate a strict Hermes completion and assert the merged evaluation;
9. restart stores and processors and assert no second outbound request.

- [ ] **Step 2: Add lifecycle boundary cases**

Cover `no_answer`, `busy`, definitive provider rejection, uncertain network failure, malformed webhook, missing-transcript backfill, Hermes unavailable, disallowed phone, interrupted `dispatching`, and `dry_run`. Assert the fake server receives zero requests in every non-live case.

- [ ] **Step 3: Add the integration script and run RED**

Add:

```json
"test:integration": "node --test test/integration"
```

Run: `npm run test:integration`

- [ ] **Step 4: Make only the integration fixes required by the tests**

Keep fixes within the modules already introduced. Do not add retries, parallel dialing, or a database.

- [ ] **Step 5: Run all verification**

Run: `npm test`

Run: `npm run test:integration`

Run: `npm run check`

Expected: all pass and the test log contains no DNS connection to `apps.sarvam.ai`.

- [ ] **Step 6: Commit**

```bash
git add test/integration/callback-lifecycle.test.js package.json src
git commit -m "test: verify callback and feedback lifecycle"
```

---

## Task 11: Harden Services, Update the Diagram, and Deploy in No-Call Modes

**Files:**
- Create: `deploy/elevate-feedback-worker.service`
- Create: `deploy/elevate-feedback-worker.env.example`
- Modify: `deploy/elevate-whatsapp-bridge.service`
- Modify: `deploy/nginx-location.conf`
- Modify: `test/deploy.test.js`
- Modify: `docs/demo-runbook.md`
- Modify: `assets/architecture.html`
- Regenerate: `assets/architecture.png`

- [ ] **Step 1: Write failing deployment tests**

Assert:

- bridge unit pins all five JSON paths and defaults mode to `disabled`;
- worker runs as `elevate-feedback`, not root or `elevate-wa`;
- worker has `NoNewPrivileges`, strict filesystem protection, private `/tmp`, no capabilities, and read/write access only to its own home;
- nginx returns 404 for `/elevate-whatsapp/v1/internal/` before the general proxy location;
- nginx access logging is disabled for the bridge route so webhook tokens never enter request logs;
- the example worker env contains no secret values;
- neither unit contains `CALLBACK_DISPATCH_MODE=live`;
- runbook contains the two-number policy, no-call gate, callback states, feedback approval, and no `Priya` text.

- [ ] **Step 2: Run deployment tests and confirm RED**

Run: `node --test test/deploy.test.js`

- [ ] **Step 3: Add hardened systemd units**

The feedback worker unit uses:

```ini
User=elevate-feedback
Group=elevate-feedback
WorkingDirectory=/var/empty/elevate-feedback-worker
EnvironmentFile=/etc/elevate-feedback-worker.env
ExecStart=/usr/bin/node /srv/elevate-whatsapp-bridge/src/feedback-worker.js
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/var/lib/elevate-feedback-worker
```

The bridge unit pins `outbound-events.json`, `feedback.json`, `evaluation-cases.json`, and `recommendations.json` under `/var/lib/elevate-whatsapp-bridge`. Put `Environment=CALLBACK_DISPATCH_MODE=disabled` immediately before `EnvironmentFile=/etc/elevate-whatsapp-bridge.env`, allowing a deliberate environment-file value to override the safe default during dry-run or separately approved live operation.

- [ ] **Step 4: Block internal worker routes at nginx**

Place this location before the existing proxy location:

```nginx
location ^~ /elevate-whatsapp/v1/internal/ {
    return 404;
}
```

Set `access_log off;` on the general `/elevate-whatsapp/` proxy location. The application retains redacted structured event logs, so operational status remains observable without recording bearer or webhook tokens in request URIs.

- [ ] **Step 5: Update the runbook and architecture source**

Document the actual components, state transitions, dry-run proof, evaluation scores, review command, retention policy, and recovery procedure. Replace stale version/voice/persona labels with dashboard-independent descriptions. Add callback scheduler, Sarvam outbound/event flow, deterministic evaluator, tool-free Hermes worker, regression cases, and human approval to `assets/architecture.html`.

Regenerate `assets/architecture.png` with the same local rendering process used for the existing diagram. Inspect the PNG visually and verify dimensions with:

```bash
sips -g pixelWidth -g pixelHeight assets/architecture.png
```

- [ ] **Step 6: Run complete local verification**

Run: `npm test`

Run: `npm run test:integration`

Run: `npm run check`

Run: `python3 -m py_compile worker/hermes_eval.py`

Run: `git diff --check`

Run: `rg -n "Thanks for speaking with Priya" src docs/demo-runbook.md assets`

Run: `rg -n "^Environment=CALLBACK_DISPATCH_MODE=live$" deploy`

Run: `rg -n "^(SARVAM_API_KEY|FEEDBACK_WORKER_TOKEN)=.+" deploy`

Expected: tests and checks pass; each scan exits with no matches.

- [ ] **Step 7: Commit deployment artifacts**

```bash
git add deploy test/deploy.test.js docs/demo-runbook.md assets/architecture.html assets/architecture.png
git commit -m "docs: operationalize callback feedback demo"
```

- [ ] **Step 8: Back up VPS code and state**

Run from the local repository:

```bash
STAMP=$(date +%Y%m%d%H%M%S)
ssh srikarhermes-vps "sudo cp -a /srv/elevate-whatsapp-bridge /srv/elevate-whatsapp-bridge.backup-$STAMP && sudo cp -a /var/lib/elevate-whatsapp-bridge /var/lib/elevate-whatsapp-bridge.backup-$STAMP"
rsync -az --exclude node_modules --exclude .git ./ srikarhermes-vps:/tmp/elevate-whatsapp-bridge-release/
ssh srikarhermes-vps "cd /tmp/elevate-whatsapp-bridge-release && npm ci && npm test && npm run test:integration && npm run check"
```

Stop if any remote check fails.

- [ ] **Step 9: Install code and units with dispatch disabled**

```bash
ssh srikarhermes-vps "sudo rsync -a --exclude node_modules /tmp/elevate-whatsapp-bridge-release/ /srv/elevate-whatsapp-bridge/ && cd /srv/elevate-whatsapp-bridge && sudo npm ci --omit=dev"
ssh srikarhermes-vps "sudo install -o root -g root -m 0644 /srv/elevate-whatsapp-bridge/deploy/elevate-whatsapp-bridge.service /etc/systemd/system/elevate-whatsapp-bridge.service"
ssh srikarhermes-vps "sudo install -o root -g root -m 0644 /srv/elevate-whatsapp-bridge/deploy/elevate-feedback-worker.service /etc/systemd/system/elevate-feedback-worker.service"
ssh srikarhermes-vps "sudo systemctl daemon-reload && sudo systemctl restart elevate-whatsapp-bridge"
```

Do not start the feedback worker until its dedicated identity and OAuth profile exist.

- [ ] **Step 10: Configure secrets without committing them**

Create the worker user and private state:

```bash
ssh srikarhermes-vps "sudo useradd --system --home /var/lib/elevate-feedback-worker --create-home --shell /usr/sbin/nologin elevate-feedback || true; sudo install -d -o elevate-feedback -g elevate-feedback -m 0700 /var/lib/elevate-feedback-worker /var/empty/elevate-feedback-worker"
```

Generate a worker token and webhook token with `openssl rand -hex 32`. Put the matching worker token in both root-owned environment files. Use `sudoedit /etc/elevate-whatsapp-bridge.env` for Sarvam IDs, API key, tokens, hash salt, and `CALLBACK_DISPATCH_MODE=disabled`. Use `sudoedit /etc/elevate-feedback-worker.env` for loopback URL, worker token, Hermes home, `HERMES_EVAL_MODEL=gpt-5.6-sol`, and `HERMES_EVAL_PROVIDER=openai-codex`.

Validate presence without printing values:

```bash
ssh srikarhermes-vps 'sudo sh -c '\''for key in SARVAM_API_KEY SARVAM_ORG_ID SARVAM_WORKSPACE_ID SARVAM_APP_ID SARVAM_APP_VERSION SARVAM_CONNECTION_ID SARVAM_AGENT_PHONE_NUMBER SARVAM_WEBHOOK_BASE_URL SARVAM_WEBHOOK_TOKEN PHONE_HASH_SALT FEEDBACK_WORKER_TOKEN CALLBACK_DISPATCH_MODE; do grep -Eq "^${key}=.+$" /etc/elevate-whatsapp-bridge.env || exit 1; done'\'''
```

- [ ] **Step 11: Authenticate the separate Hermes worker identity**

Run an interactive OAuth flow as the worker user; do not copy root's Hermes credentials:

```bash
ssh -t srikarhermes-vps 'sudo -u elevate-feedback -H env HERMES_HOME=/var/lib/elevate-feedback-worker/.hermes /usr/local/bin/hermes auth add openai-codex --type oauth --label elevate-feedback --no-browser'
```

Then execute one local fixture through `worker/hermes_eval.py`, confirm strict JSON, and confirm the wrapper's zero-tool assertion. This is an inference-only test and cannot place a call.

- [ ] **Step 12: Configure Sarvam webhooks without publishing a live callback flow**

In the Sarvam draft:

1. update `schedule_callback` to send the confirmation fields to the authenticated bridge endpoint;
2. add the on-end mapping for the strict bridge-owned contract;
3. commit a new immutable agent version;
4. place that version in `/etc/elevate-whatsapp-bridge.env`;
5. leave `CALLBACK_DISPATCH_MODE=disabled`;
6. restart the bridge and inspect health.

Do not create or start a campaign and do not use the Instant Outbound endpoint manually.

- [ ] **Step 13: Start the worker and verify no-call operation**

```bash
ssh srikarhermes-vps "sudo systemctl enable --now elevate-feedback-worker && sudo systemctl restart elevate-whatsapp-bridge"
ssh srikarhermes-vps "systemctl is-active elevate-whatsapp-bridge elevate-feedback-worker"
ssh srikarhermes-vps "curl -fsS http://127.0.0.1:3218/health"
ssh srikarhermes-vps "sudo nginx -t"
curl -i https://193-203-163-98.sslip.io/elevate-whatsapp/v1/internal/evaluations/claim
```

Expected: both units active, health shows `disabled`, nginx passes, and the public internal route returns 404.

- [ ] **Step 14: Switch only to dry run and verify a five-minute booking**

Set `CALLBACK_DISPATCH_MODE=dry_run`, restart, and book one confirmed callback to `918639885985` five minutes ahead through the authenticated endpoint. Verify:

- one redacted dry-run outbound record exists;
- the callback becomes `expired` with reason `dry_run_completed_without_call`;
- no Sarvam `attempt_id` exists;
- Sarvam call logs show no new call;
- restarting both units creates no second dry-run record;
- health reports zero pending callbacks and the correct evaluation count.

Return the service to `CALLBACK_DISPATCH_MODE=disabled` after evidence is captured.

- [ ] **Step 15: Final verification and stop gate**

```bash
ssh srikarhermes-vps "sudo systemctl restart elevate-whatsapp-bridge elevate-feedback-worker && sleep 3 && systemctl is-active elevate-whatsapp-bridge elevate-feedback-worker"
ssh srikarhermes-vps "sudo journalctl -u elevate-whatsapp-bridge -u elevate-feedback-worker --since '10 minutes ago' --no-pager | tail -200"
git status --short
git log --oneline --decorate -12
```

Inspect logs for IDs and statuses only. Stop here. Do not enable live dispatch or place a test call until the user gives a new, explicit approval after reviewing the dry-run evidence.

---

## Acceptance Checklist

- [ ] Both approved phone formats normalize correctly and every other destination is rejected twice: at booking and dispatch.
- [ ] A callback cannot be booked without recent explicit user confirmation.
- [ ] Every callback state transition is legal, timestamped, reasoned, and durable.
- [ ] Restart recovery cannot duplicate an uncertain dispatch.
- [ ] Disabled and dry-run verification produce zero real calls.
- [ ] A fake five-minute callback produces exactly one outbound request within the 15-second target.
- [ ] Sarvam outcomes correlate with callbacks and persist before webhook acknowledgement.
- [ ] Missing transcripts backfill asynchronously and stop after three attempts.
- [ ] Deterministic evaluation catches missed callbacks, long turns, stacked questions, repetition, and consecutive agent turns.
- [ ] Interruption quality remains `not_scoreable` without timing evidence.
- [ ] Hermes GPT-5.6 Sol runs under a separate user with an asserted empty tool schema.
- [ ] Operator feedback and low scores create regression cases and thresholded recommendations.
- [ ] Recommendations cannot call Sarvam, edit a draft, or publish a version.
- [ ] Transcript content expires after 30 days while non-sensitive scores remain.
- [ ] Public nginx access to worker endpoints returns 404.
- [ ] User-facing copy and runbooks contain no stale `Priya` identity.
- [ ] The updated architecture PNG accurately shows the deployed callback and feedback flow.
