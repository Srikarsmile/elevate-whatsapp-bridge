import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const failureCodes = [
  "long_agent_turn",
  "stacked_questions",
  "consecutive_agent_turns",
  "repeated_sentence",
  "agent_user_word_ratio",
  "callback_not_booked",
  "due_callback_not_dispatched",
  "tool_promise_without_success",
  "missing_required_variables",
  "talked_over_user",
  "robotic_repetition",
  "wrong_intent",
  "tool_failure",
  "missed_callback",
  "other",
];
const workerErrorCodes = [
  "spawn_error",
  "timeout",
  "process_error",
  "invalid_json",
  "invalid_output",
  "output_too_large",
  "network_error",
];

const scoreSchema = z.number().int().min(0).max(100);
const hermesSchema = z
  .object({
    scores: z
      .object({
        listening: scoreSchema,
        concision: scoreSchema,
        naturalness: scoreSchema,
        intent_accuracy: scoreSchema,
        task_completion: scoreSchema,
      })
      .strict(),
    evidence: z
      .array(
        z
          .object({
            turn_indexes: z.array(z.number().int().nonnegative()).min(1).max(50),
            failure_code: z.enum(failureCodes),
          })
          .strict()
      )
      .max(100),
    failures: z.array(z.enum(failureCodes)).max(50),
    prompt_delta: z.string().trim().max(500),
    confidence: z.number().min(0).max(1),
    insufficient_evidence: z.boolean(),
  })
  .strict();

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function secureHashEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function retryDelayMs(attempts) {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 5 * 60 * 1000);
}

export class EvaluationQueueError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "EvaluationQueueError";
    this.code = code;
  }
}

export function parseHermesEvaluation(value, transcriptLength) {
  const parsed = hermesSchema.parse(value);
  if (!Number.isInteger(transcriptLength) || transcriptLength < 0) {
    throw new Error("Transcript length is invalid");
  }
  for (const evidence of parsed.evidence) {
    if (evidence.turn_indexes.some((index) => index >= transcriptLength)) {
      throw new Error("Hermes evidence turn index is outside the transcript");
    }
  }
  return parsed;
}

export function createEvaluationQueue({
  store,
  eventStore = null,
  feedbackLoop = null,
  clock = () => new Date(),
  leaseMs = 2 * 60 * 1000,
  randomToken = () => randomBytes(32).toString("hex"),
}) {
  async function claim() {
    const now = clock();
    const current = store.list((value) => {
      if (value.status === "pending") {
        return !value.next_attempt_at || Date.parse(value.next_attempt_at) <= now.getTime();
      }
      return value.status === "leased" && Date.parse(value.lease_expires_at) <= now.getTime();
    })[0];
    if (!current) return null;

    const leaseToken = randomToken();
    if (typeof leaseToken !== "string" || leaseToken.length < 24) {
      throw new EvaluationQueueError("Lease token generation failed", "internal_error");
    }
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const persisted = await store.update(current.job_id, (value) => ({
      ...value,
      status: "leased",
      attempts: (Number.isInteger(value.attempts) ? value.attempts : 0) + 1,
      lease_token_hash: tokenHash(leaseToken),
      lease_expires_at: leaseExpiresAt,
      updated_at: now.toISOString(),
    }));
    return Object.freeze({
      job_id: persisted.job_id,
      event_id: persisted.event_id,
      interaction_id: persisted.interaction_id || null,
      app_version: persisted.app_version || null,
      transcript: persisted.transcript,
      deterministic_evaluation: persisted.deterministic_evaluation,
      lease_token: leaseToken,
      lease_expires_at: leaseExpiresAt,
    });
  }

  async function updateEvent(job, result, now) {
    if (!eventStore) return;
    const event = eventStore.get(job.event_id);
    if (!event) return;
    const updated = await eventStore.update(job.event_id, (value) => ({
      ...value,
      hermes_evaluation: result,
      llm_status: "complete",
      llm_evaluated_at: now.toISOString(),
    }));
    if (feedbackLoop) await feedbackLoop.recordHermesEvaluation(updated, result);
  }

  async function complete({ jobId, leaseToken, result, errorCode }) {
    const current = store.get(jobId);
    if (!current) throw new EvaluationQueueError("Evaluation job not found", "not_found");
    const suppliedHash = tokenHash(leaseToken || "");
    if (current.status === "complete") {
      if (!secureHashEqual(current.last_lease_token_hash, suppliedHash)) {
        throw new EvaluationQueueError("Evaluation lease does not match", "lease_mismatch");
      }
      await updateEvent(current, current.result, clock());
      return { job: current, duplicate: true };
    }
    if (
      current.status !== "leased" ||
      !current.lease_token_hash ||
      !secureHashEqual(current.lease_token_hash, suppliedHash)
    ) {
      throw new EvaluationQueueError("Evaluation lease does not match", "lease_mismatch");
    }

    const hasResult = result !== undefined;
    const hasError = errorCode !== undefined;
    if (hasResult === hasError) {
      throw new EvaluationQueueError("Completion requires one result or error", "invalid_input");
    }
    const now = clock();
    if (hasError) {
      if (!workerErrorCodes.includes(errorCode)) {
        throw new EvaluationQueueError("Worker error code is invalid", "invalid_input");
      }
      const pending = await store.update(jobId, (value) => ({
        ...value,
        status: "pending",
        last_error_code: errorCode,
        next_attempt_at: new Date(now.getTime() + retryDelayMs(value.attempts)).toISOString(),
        lease_token_hash: null,
        lease_expires_at: null,
        updated_at: now.toISOString(),
      }));
      return { job: pending, duplicate: false };
    }

    let parsed;
    try {
      parsed = parseHermesEvaluation(result, current.transcript.length);
    } catch {
      throw new EvaluationQueueError("Hermes evaluation is invalid", "invalid_input");
    }
    const completed = await store.update(jobId, (value) => ({
      ...value,
      status: "complete",
      result: parsed,
      transcript: null,
      completed_at: now.toISOString(),
      last_lease_token_hash: value.lease_token_hash,
      lease_token_hash: null,
      lease_expires_at: null,
      updated_at: now.toISOString(),
    }));
    await updateEvent(completed, parsed, now);
    return { job: completed, duplicate: false };
  }

  return Object.freeze({ claim, complete });
}
