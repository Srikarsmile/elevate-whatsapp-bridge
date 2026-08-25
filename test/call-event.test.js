import assert from "node:assert/strict";
import test from "node:test";

import {
  eventIdFor,
  parseOnEndEvent,
  parseOutboundEvent,
} from "../src/call-event.js";

const receivedAt = new Date("2026-08-23T05:10:00.000Z");
const phoneHashSalt = "phone-hash-salt-with-at-least-32-characters";

const outbound = {
  attempt_id: "attempt-123",
  status: "connected",
  channel_info: {
    channel_type: "v2v",
    channel_provider: "vobiz",
    agent_phone_number: "+918071581315",
  },
  duration: 93.2,
  interaction_id: "20260823/interaction-123",
  failure_reason: null,
  final_agent_variables: { intent_level: "Hot", callback_requested: true },
  webhook_config: {
    url: "https://example.test/elevate-whatsapp/v1/sarvam/outbound-events/secret-token",
    metadata: {
      booking_id: "cb-1111111111111111",
      request_id: "call-123:callback",
    },
  },
  interaction_transcript: [
    { role: "agent", en_text: "Hello, is now a good time?" },
    { role: "user", en_text: "Yes, go ahead." },
  ],
};

const onEnd = {
  interaction_id: "20260823/interaction-123",
  app_id: "app-test",
  app_version: 7,
  status: "connected",
  duration: 93.2,
  user_phone_number: "+91 86398 85985",
  final_agent_variables: { intent_level: "Hot" },
  interaction_transcript: outbound.interaction_transcript,
  tool_results: [
    {
      name: "schedule_callback",
      status: "success",
      booking_id: "cb-1111111111111111",
    },
  ],
};

test("normalizes an outbound completion event and removes secrets and full phones", () => {
  const event = parseOutboundEvent(outbound, {
    phoneHashSalt,
    receivedAt,
    recipientPhone: "918639885985",
  });

  assert.match(event.event_id, /^evt-[a-f0-9]{24}$/);
  assert.equal(event.source, "instant_outbound");
  assert.equal(event.attempt_id, "attempt-123");
  assert.equal(event.interaction_id, "20260823/interaction-123");
  assert.equal(event.agent_phone_last4, "1315");
  assert.equal(event.phone_last4, "5985");
  assert.match(event.phone_hash, /^[a-f0-9]{64}$/);
  assert.equal(event.transcript_status, "available");
  assert.equal(event.evaluation_status, "pending");
  assert.deepEqual(event.correlation, {
    booking_id: "cb-1111111111111111",
    request_id: "call-123:callback",
  });

  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /918071581315|918639885985|secret-token/);
});

test("accepts a non-connected event and marks its transcript unavailable", () => {
  const event = parseOutboundEvent(
    {
      ...outbound,
      status: "no_answer",
      duration: null,
      interaction_id: null,
      final_agent_variables: null,
      interaction_transcript: null,
    },
    { phoneHashSalt, receivedAt, recipientPhone: "918639885985" }
  );

  assert.equal(event.status, "no_answer");
  assert.equal(event.transcript_status, "unavailable");
  assert.equal(event.transcript, null);
});

test("accepts a bounded recipient alias for a first-call webhook", () => {
  const event = parseOutboundEvent(
    {
      ...outbound,
      webhook_config: {
        ...outbound.webhook_config,
        metadata: {
          recipient_alias: "controlled_test",
          request_id: "controlled-test:20260825",
        },
      },
    },
    { phoneHashSalt, receivedAt, recipientPhone: "918639885985" }
  );

  assert.deepEqual(event.correlation, {
    recipient_alias: "controlled_test",
    request_id: "controlled-test:20260825",
  });
  assert.doesNotMatch(JSON.stringify(event), /918639885985/);
});

test("marks a connected event without a transcript for asynchronous backfill", () => {
  const event = parseOutboundEvent(
    { ...outbound, interaction_transcript: null },
    { phoneHashSalt, receivedAt, recipientPhone: "918639885985" }
  );
  assert.equal(event.transcript_status, "pending");
});

test("normalizes the strict bridge-owned on-end contract", () => {
  const event = parseOnEndEvent(onEnd, { phoneHashSalt, receivedAt });

  assert.equal(event.source, "on_end");
  assert.equal(event.app_id, "app-test");
  assert.equal(event.app_version, 7);
  assert.equal(event.phone_last4, "5985");
  assert.deepEqual(event.tool_results, onEnd.tool_results);
  assert.equal(event.correlation.booking_id, "cb-1111111111111111");
  assert.doesNotMatch(JSON.stringify(event), /918639885985/);
});

test("deduplicates outbound and on-end payloads by interaction ID", () => {
  assert.equal(eventIdFor(outbound), eventIdFor(onEnd));
});

test("rejects disallowed on-end recipients", () => {
  assert.throws(
    () =>
      parseOnEndEvent(
        { ...onEnd, user_phone_number: "+919999999999" },
        { phoneHashSalt, receivedAt }
      ),
    /allowlist/
  );
});

test("rejects unknown fields and malformed transcript turns", () => {
  assert.throws(
    () => parseOutboundEvent({ ...outbound, unknown: true }, { phoneHashSalt, receivedAt }),
    /Unrecognized key/
  );
  assert.throws(
    () =>
      parseOutboundEvent(
        {
          ...outbound,
          channel_info: { ...outbound.channel_info, secret: "value" },
        },
        { phoneHashSalt, receivedAt }
      ),
    /Unrecognized key/
  );
  assert.throws(
    () =>
      parseOnEndEvent(
        {
          ...onEnd,
          interaction_transcript: [{ role: "system", en_text: "invalid" }],
        },
        { phoneHashSalt, receivedAt }
      ),
    /Invalid option/
  );
});

test("redacts phone-like values from provider failure text", () => {
  const event = parseOutboundEvent(
    {
      ...outbound,
      status: "failed",
      duration: null,
      interaction_id: null,
      final_agent_variables: null,
      interaction_transcript: null,
      failure_reason: "vobiz rejected +918639885985",
    },
    { phoneHashSalt, receivedAt, recipientPhone: "918639885985" }
  );

  assert.equal(event.failure_reason, "vobiz rejected [redacted-phone]");
});

test("redacts phone-like values inside variables and transcript text", () => {
  const event = parseOutboundEvent(
    {
      ...outbound,
      final_agent_variables: { contact: "+918639885985" },
      interaction_transcript: [
        { role: "user", en_text: "Call me on +91 86398 85985." },
      ],
    },
    { phoneHashSalt, receivedAt, recipientPhone: "918639885985" }
  );

  assert.doesNotMatch(JSON.stringify(event), /918639885985|86398 85985/);
  assert.equal(event.final_agent_variables.contact, "[redacted-phone]");
  assert.equal(event.transcript[0].en_text, "Call me on [redacted-phone].");
});

test("rejects oversized variable payloads", () => {
  assert.throws(
    () =>
      parseOutboundEvent(
        {
          ...outbound,
          final_agent_variables: { notes: "x".repeat(20 * 1024) },
        },
        { phoneHashSalt, receivedAt }
      ),
    /variables too large/
  );
});
