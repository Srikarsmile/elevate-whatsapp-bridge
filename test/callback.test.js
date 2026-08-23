import assert from "node:assert/strict";
import test from "node:test";

import { parseCallbackRequest } from "../src/callback.js";

const now = new Date("2026-08-22T12:00:00.000Z");
const valid = {
  request_id: "call-123:callback",
  to: "918688664337",
  callback_time_iso: "2026-08-23T10:30:00+05:30",
  callback_time_human: "tomorrow morning at ten thirty",
  timezone: "Asia/Kolkata",
  prospect_name: "ElevateBox hiring team",
  context_summary: "Interested in an e-commerce website and requested a callback.",
  confirmed_by_user: true,
  confirmed_at: "2026-08-22T12:00:00.000Z",
  source_interaction_id: "20260822/interaction-123",
};

test("accepts a confirmed future callback in India time", () => {
  assert.deepEqual(parseCallbackRequest(valid, { now }), valid);
});

test("accepts a callback for the controlled test recipient", () => {
  const request = { ...valid, to: "918639885985" };
  assert.deepEqual(parseCallbackRequest(request, { now }), request);
});

test("normalizes a formatted approved callback recipient", () => {
  const request = { ...valid, to: "+91-86886-64337" };
  assert.deepEqual(parseCallbackRequest(request, { now }), {
    ...request,
    to: "918688664337",
  });
});

test("rejects a callback outside the demo allowlist", () => {
  assert.throws(
    () => parseCallbackRequest({ ...valid, to: "919999999999" }, { now }),
    /Invalid option/
  );
});

test("requires the Asia Kolkata timezone", () => {
  assert.throws(
    () => parseCallbackRequest({ ...valid, timezone: "UTC" }, { now }),
    /Invalid input/
  );
});

test("rejects a callback at or before the current time", () => {
  assert.throws(
    () =>
      parseCallbackRequest(
        { ...valid, callback_time_iso: "2026-08-22T17:30:00+05:30" },
        { now }
      ),
    /future/
  );
});

test("requires at least fifteen seconds before the callback", () => {
  assert.throws(
    () =>
      parseCallbackRequest(
        { ...valid, callback_time_iso: "2026-08-22T12:00:14.999Z" },
        { now }
      ),
    /15 seconds/
  );
});

test("rejects callbacks more than seven days ahead", () => {
  assert.throws(
    () =>
      parseCallbackRequest(
        { ...valid, callback_time_iso: "2026-08-29T12:00:00.001Z" },
        { now }
      ),
    /seven days/
  );
});

test("requires explicit user confirmation", () => {
  assert.throws(
    () => parseCallbackRequest({ ...valid, confirmed_by_user: false }, { now }),
    /Invalid input/
  );
});

test("requires confirmation at or before booking", () => {
  assert.throws(
    () =>
      parseCallbackRequest(
        { ...valid, confirmed_at: "2026-08-22T12:00:01.000Z" },
        { now }
      ),
    /confirmation time/
  );
});

test("allows a callback without a source interaction ID", () => {
  const { source_interaction_id, ...request } = valid;
  assert.deepEqual(parseCallbackRequest(request, { now }), request);
});

test("rejects unknown callback fields", () => {
  assert.throws(
    () => parseCallbackRequest({ ...valid, untrusted: "value" }, { now }),
    /Unrecognized key/
  );
});
