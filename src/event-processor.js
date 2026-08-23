import { createHash } from "node:crypto";

import { evaluateDeterministically } from "./evaluator.js";

const DEFAULT_BACKFILL_DELAYS = Object.freeze([30_000, 120_000, 600_000]);
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

function jobId(eventId) {
  return `job-${createHash("sha256").update(eventId).digest("hex").slice(0, 24)}`;
}

function eventMetadata(event) {
  return Object.fromEntries(
    Object.entries({
      attempt_id: event.attempt_id,
      interaction_id: event.interaction_id,
      failure_reason: event.failure_reason,
    }).filter(([, value]) => value !== null && value !== undefined)
  );
}

async function reconcileCallback(event, callbackStore) {
  const bookingId = event.source === "instant_outbound" ? event.correlation?.booking_id : null;
  if (!bookingId || !callbackStore) return null;
  let booking = callbackStore.get(bookingId);
  if (!booking) return null;
  if (booking.status === "dispatching") {
    booking = await callbackStore.transition(bookingId, "dialing", {
      at: event.received_at,
      reason: "processor_replayed_webhook",
      metadata: eventMetadata(event),
    });
  }
  if (booking.status === "dialing") {
    booking = await callbackStore.transition(bookingId, event.status, {
      at: event.received_at,
      reason: `sarvam_${event.status}`,
      metadata: eventMetadata(event),
    });
  }
  return booking;
}

export function createEventProcessor({
  eventStore,
  evaluationJobStore,
  callbackStore = null,
  analyticsClient = null,
  evaluate = evaluateDeterministically,
  clock = () => new Date(),
  intervalMs = 5000,
  batchSize = 10,
  backfillDelaysMs = DEFAULT_BACKFILL_DELAYS,
  retentionMs = DEFAULT_RETENTION_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = console,
}) {
  if (!eventStore || !evaluationJobStore) {
    throw new Error("Event and evaluation job stores are required");
  }
  let active = null;
  let timer = null;
  let state = "stopped";
  let lastRetentionAt = null;

  async function runRetention(now) {
    if (lastRetentionAt && now.getTime() - lastRetentionAt < RETENTION_INTERVAL_MS) return;
    const cutoff = now.getTime() - retentionMs;
    for (const current of eventStore.list(
      (value) =>
        Array.isArray(value.transcript) && Date.parse(value.received_at) < cutoff
    )) {
      await eventStore.update(current.event_id, (value) => ({
        ...value,
        transcript: null,
        transcript_status: "expired",
        transcript_expired_at: now.toISOString(),
      }));
    }
    lastRetentionAt = now.getTime();
  }

  async function backfillTranscript(current, now) {
    if (current.transcript_status !== "pending") return { event: current, attempted: false };
    const attempts = Number.isInteger(current.backfill_attempts)
      ? current.backfill_attempts
      : 0;
    const delay = backfillDelaysMs[attempts];
    if (delay === undefined) {
      const unavailable = await eventStore.update(current.event_id, (value) => ({
        ...value,
        transcript_status: "unavailable",
      }));
      return { event: unavailable, attempted: false };
    }
    const dueAt = Date.parse(current.received_at) + delay;
    if (now.getTime() < dueAt) return { event: current, attempted: false };

    try {
      if (!analyticsClient) throw new Error("Analytics client unavailable");
      const transcript = await analyticsClient.getTranscript(current.interaction_id);
      const updated = await eventStore.update(current.event_id, (value) => ({
        ...value,
        transcript,
        transcript_status: "available",
        backfill_attempts: attempts + 1,
        next_backfill_at: null,
      }));
      return { event: updated, attempted: true };
    } catch {
      const nextAttempts = attempts + 1;
      const exhausted = nextAttempts >= backfillDelaysMs.length;
      const updated = await eventStore.update(current.event_id, (value) => ({
        ...value,
        transcript_status: exhausted ? "unavailable" : "pending",
        backfill_attempts: nextAttempts,
        next_backfill_at: exhausted
          ? null
          : new Date(Date.parse(value.received_at) + backfillDelaysMs[nextAttempts]).toISOString(),
      }));
      logger.error({
        eventId: current.event_id,
        attempt: nextAttempts,
        status: exhausted ? "transcript_unavailable" : "transcript_backfill_failed",
      });
      return { event: updated, attempted: true };
    }
  }

  async function evaluateEvent(current, callback, now) {
    if (current.evaluation_status !== "pending" || current.transcript_status === "pending") {
      return current;
    }
    const deterministic = evaluate({ event: current, callback });
    const hasTranscript =
      current.transcript_status === "available" && Array.isArray(current.transcript);
    if (hasTranscript) {
      await evaluationJobStore.put({
        job_id: jobId(current.event_id),
        event_id: current.event_id,
        interaction_id: current.interaction_id,
        app_version: current.app_version,
        transcript: current.transcript,
        deterministic_evaluation: deterministic,
        status: "pending",
        attempts: 0,
        next_attempt_at: now.toISOString(),
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      });
    }
    return eventStore.update(current.event_id, (value) => ({
      ...value,
      deterministic_evaluation: deterministic,
      evaluation_status: "deterministic_complete",
      llm_status: hasTranscript ? "pending" : "not_queued",
      evaluated_at: now.toISOString(),
    }));
  }

  async function processEvent(initial, now) {
    const callback = await reconcileCallback(initial, callbackStore);
    const backfill = await backfillTranscript(initial, now);
    const wasPending = backfill.event.evaluation_status === "pending";
    const evaluated = await evaluateEvent(backfill.event, callback, now);
    const evaluationCompleted =
      wasPending && evaluated.evaluation_status === "deterministic_complete";
    if (evaluationCompleted) {
      logger.info({
        eventId: initial.event_id,
        score: evaluated.deterministic_evaluation.score,
        status: "deterministic_complete",
      });
    }
    return backfill.attempted || evaluationCompleted;
  }

  function runOnce(now = clock()) {
    if (active) return active;
    const operation = (async () => {
      await runRetention(now);
      const pending = eventStore
        .list(
          (value) =>
            value.evaluation_status === "pending" || value.transcript_status === "pending"
        )
        .slice(0, batchSize);
      let processed = 0;
      for (const value of pending) {
        if (await processEvent(value, now)) processed += 1;
      }
      return processed;
    })();
    active = operation;
    void operation.then(
      () => {
        if (active === operation) active = null;
      },
      () => {
        if (active === operation) active = null;
      }
    );
    return operation;
  }

  async function start() {
    if (timer !== null || state === "running") return;
    state = "running";
    await runOnce();
    timer = setIntervalImpl(() => {
      void runOnce().catch(() => logger.error({ service: "event_processor_poll_failed" }));
    }, intervalMs);
  }

  async function stop() {
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
    state = "stopped";
    if (active) await active;
  }

  return Object.freeze({ start, stop, runOnce, status: () => state });
}
