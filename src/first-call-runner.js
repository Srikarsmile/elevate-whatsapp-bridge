function callStatus(attempt) {
  const value = String(attempt.connectivity_status || "").toLowerCase();
  if (value === "connected") return "connected";
  if (["no_answer", "no-answer", "not_connected"].includes(value)) return "no_answer";
  if (value === "busy") return "busy";
  return "failed";
}

function failureReason(attempt, status) {
  const value = attempt.failure_reason?.trim();
  if (status === "connected" || !value || value === "NO_FAILURE_REASON") return null;
  return value;
}

function fallbackEvent({ attempt, payload, transcript }) {
  const status = callStatus(attempt);
  return {
    attempt_id: attempt.attempt_id,
    status,
    channel_info: {
      channel_type: "v2v",
      channel_provider: attempt.channel_provider || "unknown",
      agent_phone_number: payload.app_config.connection_config.agent_phone_number,
    },
    duration: attempt.duration_in_seconds ?? null,
    interaction_id: attempt.interaction_id ?? null,
    failure_reason: failureReason(attempt, status),
    final_agent_variables: attempt.agent_variables || null,
    webhook_config: payload.webhook_config,
    interaction_transcript: transcript,
  };
}

export async function runFirstCall({
  request,
  outboundClient,
  analyticsClient,
  postEvent,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => new Date(),
  pollIntervalMs = 5000,
  maxWaitMs = 15 * 60 * 1000,
}) {
  const startedAt = now();
  const { attemptId, payload } = await outboundClient.createFirstCall(request);
  const startDatetime = new Date(startedAt.getTime() - 5 * 60 * 1000).toISOString();
  let attempt = null;

  while (!attempt?.end_datetime) {
    const current = now();
    if (current.getTime() - startedAt.getTime() >= maxWaitMs) {
      throw new Error("First-call analytics timed out");
    }
    attempt = await analyticsClient.getAttempt(attemptId, {
      startDatetime,
      endDatetime: new Date(current.getTime() + 5 * 60 * 1000).toISOString(),
    });
    if (!attempt?.end_datetime) await sleep(pollIntervalMs);
  }

  const transcript = attempt.interaction_id
    ? await analyticsClient.getTranscript(attempt.interaction_id)
    : null;
  const event = fallbackEvent({ attempt, payload, transcript });
  const delivery = await postEvent(payload.webhook_config.url, event);
  return Object.freeze({
    attemptId,
    interactionId: attempt.interaction_id ?? null,
    status: event.status,
    duplicate: Boolean(delivery?.duplicate),
  });
}
