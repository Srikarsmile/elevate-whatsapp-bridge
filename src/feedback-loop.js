import { createHash } from "node:crypto";

import { z } from "zod";

const categories = [
  "missed_callback",
  "talked_over_user",
  "stacked_questions",
  "robotic_repetition",
  "wrong_intent",
  "tool_failure",
  "other",
];
const severities = ["low", "medium", "high", "critical"];
const reliabilityCategories = new Set(["missed_callback", "tool_failure"]);
const fixtureIdSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

const feedbackSchema = z
  .object({
    request_id: z.string().trim().min(8).max(160),
    interaction_id: z.string().trim().min(1).max(240),
    category: z.enum(categories),
    severity: z.enum(severities),
    note: z.string().trim().min(1).max(1000),
  })
  .strict();

const promptDeltas = Object.freeze({
  missed_callback:
    "Confirm a callback only after the scheduling tool returns success; otherwise say that booking did not complete.",
  talked_over_user:
    "After asking a question, wait for a complete user response before speaking again.",
  stacked_questions: "Ask one discovery question per turn, then wait for the answer.",
  robotic_repetition:
    "Acknowledge once in natural language and avoid repeating the same phrase or sentence.",
  wrong_intent:
    "Confirm the user's primary goal before assigning intent or choosing the next action.",
  tool_failure:
    "Describe a tool action as complete only after its result reports success.",
  other: "Address the cited regression with the smallest specific prompt instruction.",
});

const regressionFixtures = Object.freeze({
  missed_callback: ["missed-booking", "stored-not-dispatched", "good-concise"],
  talked_over_user: ["consecutive-agent-turns", "interruption-without-timing", "good-concise"],
  stacked_questions: ["stacked-questions", "good-concise"],
  robotic_repetition: ["repeated-acknowledgements", "good-concise"],
  wrong_intent: ["good-concise"],
  tool_failure: ["missed-booking", "good-concise"],
  other: ["good-concise"],
});

function stableId(prefix, value) {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function unique(values) {
  return [...new Set(values)];
}

function freezeEvidence(value) {
  return Object.freeze({
    event_id: value.event_id,
    finding_codes: Object.freeze([...value.finding_codes]),
    turn_indexes: Object.freeze([...value.turn_indexes]),
  });
}

function categoryForFindings(findings) {
  const codes = findings.map((finding) => finding.code);
  if (codes.includes("callback_not_booked") || codes.includes("due_callback_not_dispatched")) {
    return "missed_callback";
  }
  if (codes.includes("tool_promise_without_success")) return "tool_failure";
  if (codes.includes("stacked_questions")) return "stacked_questions";
  if (codes.includes("repeated_sentence")) return "robotic_repetition";
  if (codes.includes("consecutive_agent_turns")) return "talked_over_user";
  return "other";
}

export class FeedbackLoopError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FeedbackLoopError";
    this.code = code;
  }
}

export function parseOperatorFeedback(value) {
  return feedbackSchema.parse(value);
}

export function createFeedbackLoop({
  eventStore,
  feedbackStore,
  caseStore,
  recommendationStore,
  clock = () => new Date(),
}) {
  function findEvent(interactionId) {
    return eventStore.list((event) => event.interaction_id === interactionId)[0] || null;
  }

  async function ensureRecommendation(category, force = false) {
    const cases = caseStore.list((item) => item.category === category);
    const distinctInteractions = unique(cases.map((item) => item.interaction_id));
    if (!force && distinctInteractions.length < 2) return null;

    const recommendationId = stableId("rec", category);
    const evidence = cases.map(freezeEvidence);
    const affectedVersions = unique(
      cases
        .map((item) => item.app_version)
        .filter((version) => Number.isInteger(version) && version > 0)
    ).sort((left, right) => left - right);
    const existing = recommendationStore.get(recommendationId);
    if (existing) {
      if (existing.state !== "candidate") return existing;
      return recommendationStore.update(recommendationId, (current) => ({
        ...current,
        evidence,
        affected_versions: affectedVersions,
        updated_at: clock().toISOString(),
      }));
    }

    const now = clock().toISOString();
    const { record } = await recommendationStore.put({
      recommendation_id: recommendationId,
      category,
      state: "candidate",
      evidence,
      affected_versions: affectedVersions,
      prompt_delta: promptDeltas[category],
      regression_expectations: regressionFixtures[category],
      created_at: now,
      updated_at: now,
      approved_at: null,
      rejected_at: null,
      rejection_reason: null,
      promoted_at: null,
      sarvam_version: null,
      passed_fixture_ids: [],
    });
    return record;
  }

  async function persistCase({ sourceId, event, category, severity, findings = [] }) {
    const caseId = stableId("case", sourceId);
    const findingCodes = unique(findings.map((finding) => finding.code));
    const turnIndexes = unique(
      findings.flatMap((finding) =>
        Array.isArray(finding.turn_indexes) ? finding.turn_indexes : []
      )
    ).sort((left, right) => left - right);
    const { record } = await caseStore.put({
      case_id: caseId,
      event_id: event.event_id,
      interaction_id: event.interaction_id,
      category,
      severity,
      finding_codes: findingCodes,
      turn_indexes: turnIndexes,
      app_version: event.app_version || null,
      created_at: clock().toISOString(),
    });
    return record;
  }

  async function recordOperatorFeedback(value) {
    const parsed = parseOperatorFeedback(value);
    const feedbackId = stableId("fb", parsed.request_id);
    const existing = feedbackStore.get(feedbackId);
    if (existing) {
      return {
        feedback: existing,
        recommendation: existing.recommendation_id
          ? recommendationStore.get(existing.recommendation_id) || null
          : null,
        duplicate: true,
      };
    }
    const event = findEvent(parsed.interaction_id);
    if (!event) throw new FeedbackLoopError("Call interaction not found", "not_found");

    const caseRecord = await persistCase({
      sourceId: feedbackId,
      event,
      category: parsed.category,
      severity: parsed.severity,
    });
    const force =
      parsed.severity === "critical" && reliabilityCategories.has(parsed.category);
    const recommendation = await ensureRecommendation(parsed.category, force);
    const now = clock().toISOString();
    const { record: feedback } = await feedbackStore.put({
      feedback_id: feedbackId,
      ...parsed,
      event_id: event.event_id,
      case_id: caseRecord.case_id,
      recommendation_id: recommendation?.recommendation_id || null,
      created_at: now,
    });
    return { feedback, recommendation, duplicate: false };
  }

  async function recordEvaluation(event, evaluation) {
    if (!event || !evaluation || !Number.isFinite(evaluation.score)) {
      throw new FeedbackLoopError("Evaluation input is invalid", "invalid_input");
    }
    const findings = Array.isArray(evaluation.findings) ? evaluation.findings : [];
    const reliability = findings.some((finding) =>
      [
        "callback_not_booked",
        "due_callback_not_dispatched",
        "tool_promise_without_success",
      ].includes(finding.code)
    );
    if (!reliability && evaluation.score >= 85) {
      return { caseRecord: null, recommendation: null, duplicate: false };
    }
    const category = categoryForFindings(findings);
    const severity = reliability ? "critical" : evaluation.score < 60 ? "high" : "medium";
    const caseId = stableId("case", `evaluation:${event.event_id}`);
    const duplicate = Boolean(caseStore.get(caseId));
    const caseRecord = await persistCase({
      sourceId: `evaluation:${event.event_id}`,
      event,
      category,
      severity,
      findings,
    });
    const recommendation = await ensureRecommendation(category, reliability);
    return { caseRecord, recommendation, duplicate };
  }

  function getRecommendation(recommendationId) {
    return recommendationStore.get(recommendationId) || null;
  }

  function listRecommendations() {
    return recommendationStore.list();
  }

  async function updateState(recommendationId, expected, state, fields) {
    const current = recommendationStore.get(recommendationId);
    if (!current) throw new FeedbackLoopError("Recommendation not found", "not_found");
    if (current.state === state) return current;
    if (!expected.includes(current.state)) {
      throw new FeedbackLoopError("Recommendation state transition is invalid", "invalid_state");
    }
    return recommendationStore.update(recommendationId, (value) => ({
      ...value,
      ...fields,
      state,
      updated_at: clock().toISOString(),
    }));
  }

  function approve(recommendationId) {
    return updateState(recommendationId, ["candidate"], "approved", {
      approved_at: clock().toISOString(),
    });
  }

  async function reject(recommendationId, reason) {
    if (typeof reason !== "string" || reason.trim().length < 1 || reason.trim().length > 1000) {
      throw new FeedbackLoopError("Rejection reason is invalid", "invalid_input");
    }
    return updateState(recommendationId, ["candidate"], "rejected", {
      rejected_at: clock().toISOString(),
      rejection_reason: reason.trim(),
    });
  }

  async function recordPromotion(recommendationId, version, fixtureIds) {
    const parsedFixtures = z.array(fixtureIdSchema).min(1).max(100).safeParse(fixtureIds);
    if (!Number.isInteger(version) || version <= 0 || !parsedFixtures.success) {
      throw new FeedbackLoopError("Promotion evidence is invalid", "invalid_input");
    }
    return updateState(recommendationId, ["approved"], "promoted", {
      promoted_at: clock().toISOString(),
      sarvam_version: version,
      passed_fixture_ids: unique(parsedFixtures.data),
    });
  }

  return Object.freeze({
    recordOperatorFeedback,
    recordEvaluation,
    listRecommendations,
    getRecommendation,
    approve,
    reject,
    recordPromotion,
  });
}
