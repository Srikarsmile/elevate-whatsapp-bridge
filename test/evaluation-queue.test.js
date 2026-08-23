import assert from "node:assert/strict";
import test from "node:test";

import {
  EvaluationQueueError,
  createEvaluationQueue,
  parseHermesEvaluation,
} from "../src/evaluation-queue.js";

function memoryStore(idField, initial = []) {
  const values = new Map(initial.map((value) => [value[idField], Object.freeze(value)]));
  return {
    get: (id) => values.get(id),
    list: (predicate = () => true) => [...values.values()].filter(predicate),
    async update(id, updater) {
      const current = values.get(id);
      if (!current) throw new Error("not found");
      const next = Object.freeze({ ...updater(current) });
      values.set(id, next);
      return next;
    },
  };
}

function job(overrides = {}) {
  return {
    job_id: "job-111111111111111111111111",
    event_id: "evt-111111111111111111111111",
    transcript: [
      { role: "agent", en_text: "One question?" },
      { role: "user", en_text: "One answer." },
    ],
    deterministic_evaluation: { score: 90, findings: [] },
    status: "pending",
    attempts: 0,
    next_attempt_at: "2026-08-23T05:00:00.000Z",
    created_at: "2026-08-23T05:00:00.000Z",
    updated_at: "2026-08-23T05:00:00.000Z",
    ...overrides,
  };
}

const validResult = {
  scores: {
    listening: 91,
    concision: 88,
    naturalness: 86,
    intent_accuracy: 92,
    task_completion: 90,
  },
  evidence: [{ turn_indexes: [0], failure_code: "stacked_questions" }],
  failures: ["stacked_questions"],
  prompt_delta: "Ask one question, then wait for the answer.",
  confidence: 0.83,
  insufficient_evidence: false,
};

test("strictly validates Hermes output and existing turn indexes", () => {
  assert.deepEqual(parseHermesEvaluation(validResult, 2), validResult);
  assert.throws(
    () =>
      parseHermesEvaluation(
        { ...validResult, evidence: [{ turn_indexes: [2], failure_code: "other" }] },
        2
      ),
    /turn index/
  );
  assert.throws(() => parseHermesEvaluation({ ...validResult, extra: true }, 2));
  assert.throws(() => parseHermesEvaluation({ ...validResult, confidence: 2 }, 2));
});

test("persists a two-minute lease before returning a job", async () => {
  const store = memoryStore("job_id", [job()]);
  const queue = createEvaluationQueue({
    store,
    clock: () => new Date("2026-08-23T05:00:10.000Z"),
    randomToken: () => "lease-token-with-at-least-32-characters",
  });
  const claimed = await queue.claim();

  assert.equal(claimed.job_id, job().job_id);
  assert.equal(claimed.lease_token, "lease-token-with-at-least-32-characters");
  assert.equal(claimed.lease_expires_at, "2026-08-23T05:02:10.000Z");
  const persisted = store.get(job().job_id);
  assert.equal(persisted.status, "leased");
  assert.equal(persisted.attempts, 1);
  assert.notEqual(persisted.lease_token_hash, claimed.lease_token);
});

test("reclaims an expired lease but not an active one", async () => {
  const activeStore = memoryStore("job_id", [
    job({ status: "leased", lease_expires_at: "2026-08-23T05:01:00.000Z" }),
  ]);
  const active = createEvaluationQueue({
    store: activeStore,
    clock: () => new Date("2026-08-23T05:00:30.000Z"),
  });
  assert.equal(await active.claim(), null);

  const expired = createEvaluationQueue({
    store: activeStore,
    clock: () => new Date("2026-08-23T05:01:01.000Z"),
    randomToken: () => "replacement-lease-token-with-entropy",
  });
  assert.equal((await expired.claim()).lease_token, "replacement-lease-token-with-entropy");
  assert.equal(activeStore.get(job().job_id).attempts, 1);
});

test("completes a matching lease idempotently and updates the event", async () => {
  const store = memoryStore("job_id", [job()]);
  const eventStore = memoryStore("event_id", [
    {
      event_id: job().event_id,
      llm_status: "pending",
      evaluation_status: "deterministic_complete",
    },
  ]);
  const queue = createEvaluationQueue({
    store,
    eventStore,
    clock: () => new Date("2026-08-23T05:00:10.000Z"),
    randomToken: () => "lease-token-with-at-least-32-characters",
  });
  const claimed = await queue.claim();
  const first = await queue.complete({
    jobId: claimed.job_id,
    leaseToken: claimed.lease_token,
    result: validResult,
  });
  const duplicate = await queue.complete({
    jobId: claimed.job_id,
    leaseToken: claimed.lease_token,
    result: validResult,
  });

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.get(claimed.job_id).status, "complete");
  assert.equal(store.get(claimed.job_id).transcript, null);
  assert.deepEqual(eventStore.get(job().event_id).hermes_evaluation, validResult);
  assert.equal(eventStore.get(job().event_id).llm_status, "complete");
});

test("forwards completed Hermes output to governed feedback processing", async () => {
  const store = memoryStore("job_id", [job()]);
  const call = { event_id: job().event_id, llm_status: "pending" };
  const eventStore = memoryStore("event_id", [call]);
  const recorded = [];
  const queue = createEvaluationQueue({
    store,
    eventStore,
    feedbackLoop: {
      recordHermesEvaluation: async (event, evaluation) =>
        recorded.push({ event, evaluation }),
    },
    randomToken: () => "lease-token-with-at-least-32-characters",
  });
  const claimed = await queue.claim();
  await queue.complete({
    jobId: claimed.job_id,
    leaseToken: claimed.lease_token,
    result: validResult,
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].event.event_id, call.event_id);
  assert.deepEqual(recorded[0].evaluation, validResult);
});

test("returns failed work to pending with bounded exponential delay", async () => {
  let now = new Date("2026-08-23T05:00:00.000Z");
  const store = memoryStore("job_id", [job({ attempts: 7 })]);
  const queue = createEvaluationQueue({
    store,
    clock: () => now,
    randomToken: () => "lease-token-with-at-least-32-characters",
  });
  const claimed = await queue.claim();
  await queue.complete({
    jobId: claimed.job_id,
    leaseToken: claimed.lease_token,
    errorCode: "timeout",
  });
  const pending = store.get(claimed.job_id);
  assert.equal(pending.status, "pending");
  assert.equal(pending.last_error_code, "timeout");
  assert.equal(pending.next_attempt_at, "2026-08-23T05:05:00.000Z");

  now = new Date("2026-08-23T05:04:59.000Z");
  assert.equal(await queue.claim(), null);
});

test("rejects unknown jobs, mismatched leases, and invalid error codes", async () => {
  const store = memoryStore("job_id", [job()]);
  const queue = createEvaluationQueue({
    store,
    clock: () => new Date("2026-08-23T05:00:10.000Z"),
    randomToken: () => "lease-token-with-at-least-32-characters",
  });
  const claimed = await queue.claim();
  await assert.rejects(
    () => queue.complete({ jobId: "job-missing", leaseToken: "x", result: validResult }),
    (error) => error instanceof EvaluationQueueError && error.code === "not_found"
  );
  await assert.rejects(
    () => queue.complete({ jobId: claimed.job_id, leaseToken: "wrong", result: validResult }),
    (error) => error instanceof EvaluationQueueError && error.code === "lease_mismatch"
  );
  await assert.rejects(
    () =>
      queue.complete({
        jobId: claimed.job_id,
        leaseToken: claimed.lease_token,
        errorCode: "secret provider detail",
      }),
    (error) => error instanceof EvaluationQueueError && error.code === "invalid_input"
  );
});
