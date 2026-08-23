import { normalizeIndianPhone, redactPhone } from "./phone-policy.js";
import { SarvamOutboundError } from "./sarvam-outbound.js";

function dryRunEvent(booking, payload, at) {
  const connection = payload.app_config.connection_config;
  return Object.freeze({
    event_id: `dry-${booking.booking_id}`,
    source: "callback_dry_run",
    status: "dry_run",
    booking_id: booking.booking_id,
    request_id: booking.request_id,
    app_id: payload.app_config.app_id,
    app_version: payload.app_config.app_version,
    connection_id: connection.connection_id,
    agent_phone_last4: normalizeIndianPhone(connection.agent_phone_number).slice(-4),
    user_phone_last4: normalizeIndianPhone(payload.user_config.user_phone_number).slice(-4),
    created_at: at,
  });
}

export function createCallbackScheduler({
  mode,
  store,
  outboundClient,
  outboundEventStore,
  appVersion,
  clock = () => new Date(),
  intervalMs = 1000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = console,
}) {
  let active = null;
  let timer = null;
  let state = mode === "disabled" ? "disabled" : "stopped";

  async function processDryRun(booking, now) {
    let payload;
    try {
      payload = outboundClient.preview(booking);
    } catch {
      await store.transition(booking.booking_id, "expired", {
        at: now.toISOString(),
        reason: "dry_run_validation_failed",
      });
      logger.error({
        bookingId: booking.booking_id,
        status: "dry_run_validation_failed",
        recipient: redactPhone(booking.to),
      });
      return;
    }

    const event = dryRunEvent(booking, payload, now.toISOString());
    await outboundEventStore.put(event);
    await store.transition(booking.booking_id, "expired", {
      at: now.toISOString(),
      reason: "dry_run_completed_without_call",
      metadata: { dry_run_payload_id: event.event_id },
    });
    logger.info({
      bookingId: booking.booking_id,
      status: "dry_run_completed_without_call",
      recipient: redactPhone(booking.to),
    });
  }

  async function processLive(booking, now) {
    await store.transition(booking.booking_id, "dispatching", {
      at: now.toISOString(),
      reason: "callback_due",
      metadata: { dispatched_agent_version: appVersion },
    });

    try {
      const result = await outboundClient.createCall(booking);
      await store.transition(booking.booking_id, "dialing", {
        at: clock().toISOString(),
        reason: "sarvam_accepted",
        metadata: { attempt_id: result.attemptId },
      });
      logger.info({
        bookingId: booking.booking_id,
        attemptId: result.attemptId,
        status: "dialing",
        recipient: redactPhone(booking.to),
      });
    } catch (error) {
      const rejected = error instanceof SarvamOutboundError && error.kind === "rejected";
      const uncertain = error instanceof SarvamOutboundError && error.kind === "unknown";
      const status = uncertain ? "dispatch_unknown" : "failed";
      const reason = uncertain
        ? "sarvam_delivery_uncertain"
        : rejected
          ? "sarvam_rejected"
          : "dispatch_preflight_failed";
      await store.transition(booking.booking_id, status, {
        at: clock().toISOString(),
        reason,
        metadata: { failure_reason: reason },
      });
      logger.error({
        bookingId: booking.booking_id,
        status,
        reason,
        recipient: redactPhone(booking.to),
      });
    }
  }

  function runOnce(now = clock()) {
    if (mode === "disabled") return Promise.resolve(0);
    if (active) return active;

    const operation = (async () => {
      if (typeof store.recover === "function") await store.recover(now);
      const due = store.listDue(now);
      let processed = 0;
      for (const booking of due) {
        if (mode === "dry_run") await processDryRun(booking, now);
        else await processLive(booking, now);
        processed += 1;
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

  async function start(recoveryNow = clock()) {
    if (timer !== null || state === "running") return;
    if (typeof store.recover === "function") await store.recover(recoveryNow);
    if (mode === "disabled") {
      state = "disabled";
      return;
    }
    state = "running";
    timer = setIntervalImpl(() => {
      void runOnce().catch(() => logger.error({ service: "callback_scheduler_poll_failed" }));
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

  return Object.freeze({
    start,
    stop,
    runOnce,
    status: () => (mode === "disabled" ? "disabled" : state),
  });
}
