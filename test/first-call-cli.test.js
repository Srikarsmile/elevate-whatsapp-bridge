import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, run } from "../bin/first-call.js";

const config = {
  apiKey: "key-test",
  orgId: "org-test",
  workspaceId: "workspace-test",
  appId: "agent-test",
  appVersion: 20,
  connectionId: "connection-test",
  agentPhoneNumber: "+918071581315",
  webhookBaseUrl: "https://example.test",
  webhookToken: "webhook-token-with-at-least-32-characters",
};

test("accepts only an explicit demo alias and prospect name", () => {
  assert.deepEqual(parseArgs(["controlled_test", "Srikar"]), {
    recipientAlias: "controlled_test",
    prospectName: "Srikar",
  });
  assert.deepEqual(parseArgs(["assignment", "ElevateBox"]), {
    recipientAlias: "assignment",
    prospectName: "ElevateBox",
  });
  assert.throws(() => parseArgs(["918639885985", "Srikar"]), /alias/);
  assert.throws(() => parseArgs(["controlled_test"]), /usage/i);
});

test("runs the guarded call and prints no phone or secret", async () => {
  const output = [];
  const outboundClient = {
    createFirstCall: async (request) => ({
      attemptId: "attempt-123",
      payload: {
        app_config: {
          connection_config: { agent_phone_number: config.agentPhoneNumber },
        },
        webhook_config: {
          url: `${config.webhookBaseUrl}/v1/sarvam/outbound-events/${config.webhookToken}`,
          metadata: {
            recipient_alias: request.recipient_alias,
            request_id: request.request_id,
          },
        },
      },
    }),
  };
  const analyticsClient = {
    getAttempt: async () => ({
      attempt_id: "attempt-123",
      interaction_id: "interaction-123",
      connectivity_status: "connected",
      duration_in_seconds: 10,
      end_datetime: "2026-08-25T07:00:10.000Z",
      channel_provider: "vobiz",
      agent_variables: null,
    }),
    getTranscript: async () => [{ role: "user", en_text: "No business." }],
  };

  await run(["controlled_test", "Srikar"], {
    config,
    outboundClient,
    analyticsClient,
    postEvent: async () => ({ ok: true, duplicate: false }),
    now: () => new Date("2026-08-25T07:00:00.000Z"),
    stdout: (value) => output.push(value),
  });

  assert.equal(output.length, 1);
  assert.match(output[0], /"attemptId": "attempt-123"/);
  assert.match(output[0], /"appVersion": 20/);
  assert.doesNotMatch(output[0], /918639885985|8071581315|webhook-token/);
});
