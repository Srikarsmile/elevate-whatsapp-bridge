import assert from "node:assert/strict";
import test from "node:test";

import {
  CALLBACK_STATES,
  assertTransition,
  transitionRecord,
} from "../src/callback-state.js";

const transitions = {
  scheduled: ["dispatching", "expired"],
  dispatching: ["dialing", "failed", "dispatch_unknown"],
  dialing: ["connected", "no_answer", "busy", "failed", "outcome_unknown"],
  outcome_unknown: ["connected", "no_answer", "busy", "failed"],
  connected: [],
  no_answer: [],
  busy: [],
  failed: [],
  dispatch_unknown: [],
  expired: [],
};

test("exports the complete callback state set", () => {
  assert.deepEqual(CALLBACK_STATES, Object.keys(transitions));
});

test("accepts every legal callback transition", () => {
  for (const [from, destinations] of Object.entries(transitions)) {
    for (const to of destinations) assert.equal(assertTransition(from, to), true);
  }
});

test("rejects invalid and terminal callback transitions", () => {
  assert.throws(() => assertTransition("connected", "dialing"), /Invalid callback transition/);
  assert.throws(() => assertTransition("failed", "dispatching"), /Invalid callback transition/);
  assert.throws(() => assertTransition("dispatching", "busy"), /Invalid callback transition/);
  assert.throws(() => assertTransition("unknown", "scheduled"), /Unknown callback state/);
});

test("creates a new timestamped record without mutating the original", () => {
  const booking = Object.freeze({
    booking_id: "cb-1111111111111111",
    status: "scheduled",
    history: Object.freeze([
      Object.freeze({
        status: "scheduled",
        at: "2026-08-23T05:00:00.000Z",
        reason: "callback_confirmed",
      }),
    ]),
  });

  const next = transitionRecord(booking, "dispatching", {
    at: "2026-08-23T05:05:00.000Z",
    reason: "callback_due",
    metadata: { dispatched_agent_version: 7 },
  });

  assert.equal(booking.status, "scheduled");
  assert.equal(next.status, "dispatching");
  assert.equal(next.dispatched_agent_version, 7);
  assert.equal(next.updated_at, "2026-08-23T05:05:00.000Z");
  assert.deepEqual(next.history.at(-1), {
    status: "dispatching",
    at: "2026-08-23T05:05:00.000Z",
    reason: "callback_due",
  });
  assert.equal(Object.isFrozen(next), true);
  assert.equal(Object.isFrozen(next.history), true);
});

test("rejects unsafe transition metadata", () => {
  const booking = { booking_id: "cb-1111111111111111", status: "scheduled", history: [] };
  assert.throws(
    () =>
      transitionRecord(booking, "dispatching", {
        at: "2026-08-23T05:05:00.000Z",
        reason: "callback_due",
        metadata: { status: "connected" },
      }),
    /metadata/
  );
});
