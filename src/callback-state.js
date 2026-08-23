const LEGAL_TRANSITIONS = Object.freeze({
  scheduled: new Set(["dispatching", "expired"]),
  dispatching: new Set(["dialing", "failed", "dispatch_unknown"]),
  dialing: new Set(["connected", "no_answer", "busy", "failed", "outcome_unknown"]),
  outcome_unknown: new Set(["connected", "no_answer", "busy", "failed"]),
  connected: new Set(),
  no_answer: new Set(),
  busy: new Set(),
  failed: new Set(),
  dispatch_unknown: new Set(),
  expired: new Set(),
});

const METADATA_FIELDS = new Set([
  "attempt_id",
  "interaction_id",
  "dispatched_agent_version",
  "failure_reason",
  "dry_run_payload_id",
]);

export const CALLBACK_STATES = Object.freeze(Object.keys(LEGAL_TRANSITIONS));

export function assertTransition(from, to) {
  if (!(from in LEGAL_TRANSITIONS) || !(to in LEGAL_TRANSITIONS)) {
    throw new Error(`Unknown callback state: ${from} -> ${to}`);
  }
  if (!LEGAL_TRANSITIONS[from].has(to)) {
    throw new Error(`Invalid callback transition: ${from} -> ${to}`);
  }
  return true;
}

function freezeHistory(history) {
  return Object.freeze(history.map((entry) => Object.freeze({ ...entry })));
}

export function transitionRecord(booking, to, { at, reason, metadata = {} }) {
  assertTransition(booking.status, to);
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
    throw new Error("Callback transition timestamp must be ISO 8601");
  }
  if (typeof reason !== "string" || !/^[a-z0-9_:-]{1,160}$/.test(reason)) {
    throw new Error("Callback transition reason must be machine-readable");
  }
  for (const key of Object.keys(metadata)) {
    if (!METADATA_FIELDS.has(key)) throw new Error(`Unsafe callback transition metadata: ${key}`);
  }

  const history = freezeHistory([
    ...(Array.isArray(booking.history) ? booking.history : []),
    { status: to, at, reason },
  ]);
  return Object.freeze({
    ...booking,
    ...metadata,
    status: to,
    updated_at: at,
    history,
  });
}

export function freezeCallbackRecord(booking) {
  return Object.freeze({
    ...booking,
    history: freezeHistory(Array.isArray(booking.history) ? booking.history : []),
  });
}
