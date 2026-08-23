import assert from "node:assert/strict";
import test from "node:test";

import { createEventProcessor } from "../src/event-processor.js";

function memoryStore(idField, initial = []) {
  const values = new Map(initial.map((value) => [value[idField], Object.freeze(value)]));
  return {
    get: (id) => values.get(id),
    list: (predicate = () => true) => [...values.values()].filter(predicate),
    count: (predicate = () => true) => [...values.values()].filter(predicate).length,
    async put(value) {
      const id = value[idField];
      const existing = values.get(id);
      if (existing) return { record: existing, duplicate: true };
      values.set(id, Object.freeze({ ...value }));
      return { record: values.get(id), duplicate: false };
    },
    async update(id, updater) {
      const next = Object.freeze({ ...updater(values.get(id)) });
      values.set(id, next);
      return next;
    },
  };
}

function event(overrides = {}) {
  return {
    event_id: "evt-111111111111111111111111",
    source: "on_end",
    attempt_id: null,
    interaction_id: "20260823/interaction-123",
    status: "connected",
    app_version: 7,
    transcript: [
      { role: "agent", en_text: "What does the fictional shop sell?" },
      { role: "user", en_text: "Notebooks and desk accessories." },
    ],
    transcript_status: "available",
    evaluation_status: "pending",
    final_agent_variables: {
      business: "fictional stationery",
      products: "notebooks",
      features: "catalogue",
      budget: "unknown",
      timeline: "month",
      decision_maker: "owner",
      intent: "warm",
    },
    tool_results: [],
    correlation: null,
    received_at: "2026-08-23T05:00:00.000Z",
    ...overrides,
  };
}

function processorOptions(overrides = {}) {
  const eventStore = overrides.eventStore || memoryStore("event_id", [event()]);
  const evaluationJobStore = overrides.evaluationJobStore || memoryStore("job_id");
  return {
    eventStore,
    evaluationJobStore,
    callbackStore: overrides.callbackStore || null,
    analyticsClient: overrides.analyticsClient || null,
    clock: overrides.clock || (() => new Date("2026-08-23T05:00:01.000Z")),
    logger: { info() {}, error() {} },
    ...overrides,
    eventStore,
    evaluationJobStore,
  };
}

test("evaluates an available transcript and queues exactly one Hermes job", async () => {
  const options = processorOptions();
  const processor = createEventProcessor(options);

  assert.equal(await processor.runOnce(), 1);
  const updated = options.eventStore.list()[0];
  assert.equal(updated.evaluation_status, "deterministic_complete");
  assert.equal(updated.deterministic_evaluation.score, 100);
  assert.equal(updated.llm_status, "pending");
  assert.equal(options.evaluationJobStore.count(), 1);
  assert.equal(options.evaluationJobStore.list()[0].status, "pending");

  assert.equal(await processor.runOnce(), 0);
  assert.equal(options.evaluationJobStore.count(), 1);
});

test("hands a completed deterministic evaluation to the feedback loop once", async () => {
  const recorded = [];
  const options = processorOptions({
    feedbackLoop: {
      recordEvaluation: async (call, evaluation) => {
        recorded.push({ call, evaluation });
      },
    },
  });
  const processor = createEventProcessor(options);

  await processor.runOnce();
  await processor.runOnce();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].call.event_id, "evt-111111111111111111111111");
  assert.equal(recorded[0].evaluation.score, 100);
});

test("backs a transcript off at 30 seconds, two minutes, and ten minutes", async () => {
  let now = new Date("2026-08-23T05:00:00.000Z");
  let calls = 0;
  const eventStore = memoryStore("event_id", [
    event({ transcript: null, transcript_status: "pending" }),
  ]);
  const options = processorOptions({
    eventStore,
    clock: () => now,
    analyticsClient: {
      getTranscript: async () => {
        calls += 1;
        throw new Error("analytics unavailable");
      },
    },
  });
  const processor = createEventProcessor(options);

  assert.equal(await processor.runOnce(), 0);
  now = new Date("2026-08-23T05:00:30.000Z");
  assert.equal(await processor.runOnce(), 1);
  now = new Date("2026-08-23T05:02:00.000Z");
  assert.equal(await processor.runOnce(), 1);
  now = new Date("2026-08-23T05:10:00.000Z");
  assert.equal(await processor.runOnce(), 1);

  const updated = eventStore.list()[0];
  assert.equal(calls, 3);
  assert.equal(updated.transcript_status, "unavailable");
  assert.equal(updated.backfill_attempts, 3);
  assert.equal(updated.evaluation_status, "deterministic_complete");
  assert.equal(updated.llm_status, "not_queued");
  assert.equal(options.evaluationJobStore.count(), 0);
});

test("backfills a missing transcript and evaluates it in the same pass", async () => {
  const eventStore = memoryStore("event_id", [
    event({ transcript: null, transcript_status: "pending" }),
  ]);
  const options = processorOptions({
    eventStore,
    clock: () => new Date("2026-08-23T05:00:30.000Z"),
    analyticsClient: {
      getTranscript: async () => [
        { role: "agent", en_text: "What is the main goal?" },
        { role: "user", en_text: "A clearer fictional catalogue." },
      ],
    },
  });
  const processor = createEventProcessor(options);

  assert.equal(await processor.runOnce(), 1);
  const updated = eventStore.list()[0];
  assert.equal(updated.transcript_status, "available");
  assert.equal(updated.evaluation_status, "deterministic_complete");
  assert.equal(options.evaluationJobStore.count(), 1);
});

test("evaluates a non-connected call deterministically without a Hermes job", async () => {
  const eventStore = memoryStore("event_id", [
    event({
      status: "no_answer",
      interaction_id: null,
      transcript: null,
      transcript_status: "unavailable",
    }),
  ]);
  const options = processorOptions({ eventStore });
  assert.equal(await createEventProcessor(options).runOnce(), 1);
  assert.equal(eventStore.list()[0].evaluation_status, "deterministic_complete");
  assert.equal(options.evaluationJobStore.count(), 0);
});

test("replays callback correlation after a crash without duplicating the event", async () => {
  let booking = {
    booking_id: "cb-1111111111111111",
    status: "dispatching",
    to: "918639885985",
  };
  const transitions = [];
  const callbackStore = {
    get: () => booking,
    async transition(id, status, transition) {
      booking = { ...booking, ...transition.metadata, status };
      transitions.push(status);
      return booking;
    },
  };
  const eventStore = memoryStore("event_id", [
    event({
      source: "instant_outbound",
      attempt_id: "attempt-123",
      correlation: { booking_id: booking.booking_id },
    }),
  ]);
  const options = processorOptions({ eventStore, callbackStore });
  const processor = createEventProcessor(options);

  await processor.runOnce();
  await processor.runOnce();
  assert.deepEqual(transitions, ["dialing", "connected"]);
  assert.equal(booking.attempt_id, "attempt-123");
  assert.equal(eventStore.count(), 1);
});

test("reconciles a late provider event after the callback outcome timed out", async () => {
  let booking = {
    booking_id: "cb-1111111111111111",
    status: "outcome_unknown",
    to: "918639885985",
  };
  const transitions = [];
  const callbackStore = {
    get: () => booking,
    async transition(id, status, transition) {
      booking = { ...booking, ...transition.metadata, status };
      transitions.push(status);
      return booking;
    },
  };
  const eventStore = memoryStore("event_id", [
    event({
      source: "instant_outbound",
      attempt_id: "attempt-123",
      correlation: { booking_id: booking.booking_id },
    }),
  ]);
  const processor = createEventProcessor(processorOptions({ eventStore, callbackStore }));

  await processor.runOnce();

  assert.deepEqual(transitions, ["connected"]);
  assert.equal(booking.status, "connected");
});

test("removes transcripts older than 30 days while retaining score and finding codes", async () => {
  const old = event({
    received_at: "2026-07-01T00:00:00.000Z",
    evaluation_status: "deterministic_complete",
    deterministic_evaluation: {
      score: 82,
      findings: [{ code: "stacked_questions", turn_indexes: [0] }],
    },
  });
  const eventStore = memoryStore("event_id", [old]);
  const options = processorOptions({
    eventStore,
    clock: () => new Date("2026-08-23T05:00:00.000Z"),
  });
  assert.equal(await createEventProcessor(options).runOnce(), 0);
  const retained = eventStore.get(old.event_id);
  assert.equal(retained.transcript, null);
  assert.equal(retained.transcript_status, "expired");
  assert.equal(retained.deterministic_evaluation.score, 82);
  assert.equal(retained.deterministic_evaluation.findings[0].code, "stacked_questions");
});

test("stop waits for active transcript work", async () => {
  let release;
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const eventStore = memoryStore("event_id", [
    event({ transcript: null, transcript_status: "pending" }),
  ]);
  const options = processorOptions({
    eventStore,
    clock: () => new Date("2026-08-23T05:00:30.000Z"),
    analyticsClient: {
      getTranscript: async () => {
        startedResolve();
        await new Promise((resolve) => {
          release = resolve;
        });
        return [
          { role: "agent", en_text: "One question?" },
          { role: "user", en_text: "One answer." },
        ];
      },
    },
  });
  const processor = createEventProcessor(options);
  const running = processor.runOnce();
  await started;
  let stopped = false;
  const stopping = processor.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([running, stopping]);
  assert.equal(stopped, true);
  assert.equal(processor.status(), "stopped");
});
