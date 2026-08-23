import assert from "node:assert/strict";
import test from "node:test";

import {
  FeedbackLoopError,
  createFeedbackLoop,
  parseOperatorFeedback,
} from "../src/feedback-loop.js";

function memoryStore(idField, initial = []) {
  const values = new Map(initial.map((value) => [value[idField], Object.freeze(value)]));
  return {
    get: (id) => values.get(id),
    list: (predicate = () => true) => [...values.values()].filter(predicate),
    async put(value) {
      const existing = values.get(value[idField]);
      if (existing) return { record: existing, duplicate: true };
      const record = Object.freeze({ ...value });
      values.set(value[idField], record);
      return { record, duplicate: false };
    },
    async update(id, updater) {
      if (!values.has(id)) throw new Error("not found");
      const record = Object.freeze({ ...updater(values.get(id)) });
      values.set(id, record);
      return record;
    },
  };
}

function callEvent(interactionId, overrides = {}) {
  return {
    event_id: `evt-${interactionId.padEnd(24, "0").slice(0, 24)}`,
    interaction_id: interactionId,
    app_version: 7,
    status: "connected",
    deterministic_evaluation: {
      score: 90,
      findings: [],
    },
    ...overrides,
  };
}

function stores(events = [callEvent("interaction-123")]) {
  return {
    eventStore: memoryStore("event_id", events),
    feedbackStore: memoryStore("feedback_id"),
    caseStore: memoryStore("case_id"),
    recommendationStore: memoryStore("recommendation_id"),
  };
}

function service(values = stores()) {
  return {
    values,
    loop: createFeedbackLoop({
      ...values,
      clock: () => new Date("2026-08-23T06:00:00.000Z"),
    }),
  };
}

const criticalFeedback = {
  request_id: "feedback-interaction-123",
  interaction_id: "interaction-123",
  category: "missed_callback",
  severity: "critical",
  note: "The agent promised five minutes but no callback arrived.",
};

test("strictly parses and trims operator feedback", () => {
  assert.deepEqual(parseOperatorFeedback({ ...criticalFeedback, note: "  missed callback  " }), {
    ...criticalFeedback,
    note: "missed callback",
  });
  assert.throws(
    () => parseOperatorFeedback({ ...criticalFeedback, category: "unknown" }),
    /Invalid/
  );
  assert.throws(
    () => parseOperatorFeedback({ ...criticalFeedback, unexpected: true }),
    /Unrecognized key/
  );
});

test("rejects feedback for an unknown interaction", async () => {
  const { loop } = service(stores([]));
  await assert.rejects(
    () => loop.recordOperatorFeedback(criticalFeedback),
    (error) => error instanceof FeedbackLoopError && error.code === "not_found"
  );
});

test("records critical reliability feedback idempotently and opens a recommendation", async () => {
  const { loop, values } = service();
  const first = await loop.recordOperatorFeedback(criticalFeedback);
  const duplicate = await loop.recordOperatorFeedback(criticalFeedback);

  assert.match(first.feedback.feedback_id, /^fb-[a-f0-9]{24}$/);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.recommendation.state, "candidate");
  assert.equal(first.recommendation.category, "missed_callback");
  assert.equal(values.feedbackStore.list().length, 1);
  assert.equal(values.caseStore.list().length, 1);
  assert.equal(values.recommendationStore.list().length, 1);
  assert.doesNotMatch(JSON.stringify(first.recommendation), /promised five minutes/);
});

test("requires two distinct style cases before creating one grouped candidate", async () => {
  const events = [callEvent("interaction-a"), callEvent("interaction-b")];
  const { loop, values } = service(stores(events));
  const base = {
    category: "stacked_questions",
    severity: "medium",
    note: "The agent combined discovery questions.",
  };

  const first = await loop.recordOperatorFeedback({
    ...base,
    request_id: "feedback-interaction-a",
    interaction_id: "interaction-a",
  });
  assert.equal(first.recommendation, null);
  const second = await loop.recordOperatorFeedback({
    ...base,
    request_id: "feedback-interaction-b",
    interaction_id: "interaction-b",
  });

  assert.equal(second.recommendation.category, "stacked_questions");
  assert.equal(second.recommendation.evidence.length, 2);
  assert.deepEqual(
    second.recommendation.evidence.map((item) => item.event_id),
    events.map((item) => item.event_id)
  );
  assert.deepEqual(second.recommendation.affected_versions, [7]);
  assert.ok(second.recommendation.prompt_delta.length <= 500);
  assert.equal(values.recommendationStore.list().length, 1);
});

test("turns a low deterministic evaluation into numeric regression evidence", async () => {
  const event = callEvent("interaction-score", {
    deterministic_evaluation: {
      score: 72,
      findings: [
        {
          code: "stacked_questions",
          turn_indexes: [0, 2],
          evidence: { question_count: 3 },
        },
      ],
    },
  });
  const { loop, values } = service(stores([event]));
  const result = await loop.recordEvaluation(event, event.deterministic_evaluation);

  assert.equal(result.caseRecord.category, "stacked_questions");
  assert.deepEqual(result.caseRecord.finding_codes, ["stacked_questions"]);
  assert.deepEqual(result.caseRecord.turn_indexes, [0, 2]);
  assert.equal(result.recommendation, null);
  assert.doesNotMatch(JSON.stringify(values.caseStore.list()), /question_count/);
});

test("groups adequate low Hermes scores but ignores insufficient evidence", async () => {
  const events = [callEvent("interaction-hermes-a"), callEvent("interaction-hermes-b")];
  const { loop } = service(stores(events));
  const low = {
    scores: {
      listening: 82,
      concision: 91,
      naturalness: 90,
      intent_accuracy: 92,
      task_completion: 91,
    },
    evidence: [{ turn_indexes: [0], failure_code: "stacked_questions" }],
    failures: ["stacked_questions"],
    prompt_delta: "Ask one question.",
    confidence: 0.8,
    insufficient_evidence: false,
  };
  const first = await loop.recordHermesEvaluation(events[0], low);
  assert.equal(first.recommendation, null);
  const second = await loop.recordHermesEvaluation(events[1], low);
  assert.equal(second.recommendation.category, "stacked_questions");

  const ignored = await loop.recordHermesEvaluation(events[0], {
    ...low,
    insufficient_evidence: true,
  });
  assert.equal(ignored.caseRecord, null);
});

test("approval, rejection, and promotion only mutate recommendation state", async () => {
  const { loop } = service();
  const { recommendation } = await loop.recordOperatorFeedback(criticalFeedback);
  const approved = await loop.approve(recommendation.recommendation_id);
  assert.equal(approved.state, "approved");
  assert.equal((await loop.approve(recommendation.recommendation_id)).state, "approved");

  await assert.rejects(
    () => loop.reject(recommendation.recommendation_id, "changed mind"),
    (error) => error instanceof FeedbackLoopError && error.code === "invalid_state"
  );
  await assert.rejects(
    () => loop.recordPromotion(recommendation.recommendation_id, 0, []),
    (error) => error instanceof FeedbackLoopError && error.code === "invalid_input"
  );

  const promoted = await loop.recordPromotion(recommendation.recommendation_id, 8, [
    "missed-booking",
    "good-concise",
  ]);
  assert.equal(promoted.state, "promoted");
  assert.equal(promoted.sarvam_version, 8);
  assert.deepEqual(promoted.passed_fixture_ids, ["missed-booking", "good-concise"]);

  const second = service();
  const other = await second.loop.recordOperatorFeedback(criticalFeedback);
  const rejected = await second.loop.reject(other.recommendation.recommendation_id, "Not useful");
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.rejection_reason, "Not useful");
});

test("lists and retrieves recommendations without exposing feedback notes", async () => {
  const { loop } = service();
  const { recommendation } = await loop.recordOperatorFeedback(criticalFeedback);
  assert.deepEqual(loop.listRecommendations(), [recommendation]);
  assert.equal(
    loop.getRecommendation(recommendation.recommendation_id).recommendation_id,
    recommendation.recommendation_id
  );
  assert.equal(loop.getRecommendation("rec-missing"), null);
  assert.doesNotMatch(JSON.stringify(loop.listRecommendations()), /no callback arrived/);
});
