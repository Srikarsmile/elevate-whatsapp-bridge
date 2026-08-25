import assert from "node:assert/strict";
import test from "node:test";

import { runFirstCall } from "../src/first-call-runner.js";

const request = {
  recipient_alias: "controlled_test",
  prospect_name: "Srikar",
  request_id: "controlled-test:20260825:v20",
};

const payload = {
  app_config: {
    app_id: "agent-test",
    app_version: 20,
    connection_config: {
      connection_id: "connection-test",
      agent_phone_number: "+918071581315",
    },
    agent_variables: {
      prospect_name: "Srikar",
      recipient_number: "+918639885985",
    },
  },
  user_config: { user_phone_number: "+918639885985" },
  webhook_config: {
    url: "https://example.test/v1/sarvam/outbound-events/token",
    metadata: {
      recipient_alias: "controlled_test",
      request_id: request.request_id,
    },
  },
};

test("replays a completed first call through the deduplicated webhook path", async () => {
  const posted = [];
  let polls = 0;
  const result = await runFirstCall({
    request,
    outboundClient: {
      createFirstCall: async () => ({ attemptId: "attempt-123", payload }),
    },
    analyticsClient: {
      getAttempt: async () => {
        polls += 1;
        if (polls === 1) return null;
        return {
          attempt_id: "attempt-123",
          interaction_id: "20260825/interaction-123",
          connectivity_status: "connected",
          failure_reason: "NO_FAILURE_REASON",
          ended_by: "AGENT_ENDS",
          duration_in_seconds: 34.8,
          start_datetime: "2026-08-25T07:18:10Z",
          end_datetime: "2026-08-25T07:18:45Z",
          channel_provider: "vobiz",
          agent_variables: { intent_level: "Cold" },
        };
      },
      getTranscript: async () => [
        { role: "agent", en_text: "Hello." },
        { role: "user", en_text: "I do not have a business." },
      ],
    },
    postEvent: async (url, event) => {
      posted.push({ url, event });
      return { ok: true, duplicate: false };
    },
    sleep: async () => {},
    now: () => new Date("2026-08-25T07:20:00.000Z"),
    pollIntervalMs: 1,
    maxWaitMs: 10,
  });

  assert.equal(polls, 2);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, payload.webhook_config.url);
  assert.deepEqual(posted[0].event, {
    attempt_id: "attempt-123",
    status: "connected",
    channel_info: {
      channel_type: "v2v",
      channel_provider: "vobiz",
      agent_phone_number: "+918071581315",
    },
    duration: 34.8,
    interaction_id: "20260825/interaction-123",
    failure_reason: null,
    final_agent_variables: { intent_level: "Cold" },
    webhook_config: payload.webhook_config,
    interaction_transcript: [
      { role: "agent", en_text: "Hello." },
      { role: "user", en_text: "I do not have a business." },
    ],
  });
  assert.deepEqual(result, {
    attemptId: "attempt-123",
    interactionId: "20260825/interaction-123",
    status: "connected",
    duplicate: false,
  });
});

test("fails closed without replaying when analytics never completes", async () => {
  let posted = false;
  let time = 0;
  await assert.rejects(
    () =>
      runFirstCall({
        request,
        outboundClient: {
          createFirstCall: async () => ({ attemptId: "attempt-123", payload }),
        },
        analyticsClient: {
          getAttempt: async () => null,
          getTranscript: async () => [],
        },
        postEvent: async () => {
          posted = true;
        },
        sleep: async () => {
          time += 6;
        },
        now: () => new Date(time),
        pollIntervalMs: 6,
        maxWaitMs: 10,
      }),
    /timed out/
  );
  assert.equal(posted, false);
});
