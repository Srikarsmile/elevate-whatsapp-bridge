import assert from "node:assert/strict";
import test from "node:test";

import {
  SarvamOutboundError,
  buildOutboundPayload,
  createSarvamOutboundClient,
} from "../src/sarvam-outbound.js";

const config = {
  apiKey: "sarvam-test-key",
  orgId: "org test",
  workspaceId: "workspace/test",
  appId: "app-test",
  appVersion: 7,
  connectionId: "connection-test",
  agentPhoneNumber: "+918071581315",
  webhookBaseUrl: "https://example.test/elevate-whatsapp",
  webhookToken: "webhook-token-with-32-characters",
};

const booking = {
  booking_id: "cb-1111111111111111",
  request_id: "call-123:callback",
  to: "918639885985",
  prospect_name: "Srikar",
  context_summary: "Requested a five-minute callback",
};

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

test("builds the documented outbound payload with correlation metadata", () => {
  assert.deepEqual(buildOutboundPayload(booking, config), {
    app_config: {
      app_id: "app-test",
      app_version: 7,
      connection_config: {
        connection_id: "connection-test",
        agent_phone_number: "+918071581315",
      },
      agent_variables: {
        prospect_name: "Srikar",
        callback_context: "Requested a five-minute callback",
      },
    },
    user_config: { user_phone_number: "+918639885985" },
    webhook_config: {
      url: "https://example.test/elevate-whatsapp/v1/sarvam/outbound-events/webhook-token-with-32-characters",
      metadata: {
        booking_id: "cb-1111111111111111",
        request_id: "call-123:callback",
      },
    },
  });
});

test("sends one authenticated request and returns the attempt ID", async () => {
  const calls = [];
  const client = createSarvamOutboundClient({
    config,
    baseUrl: "https://sarvam.test/api/outbounds/v1",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { attempt_id: "attempt-test-1" });
    },
  });

  const result = await client.createCall(booking);

  assert.equal(result.attemptId, "attempt-test-1");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://sarvam.test/api/outbounds/v1/orgs/org%20test/workspaces/workspace%2Ftest/outbounds"
  );
  assert.deepEqual(calls[0].options.headers, {
    "content-type": "application/json",
    "x-api-key": "sarvam-test-key",
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), buildOutboundPayload(booking, config));
  assert.ok(calls[0].options.signal);
});

test("rechecks the recipient allowlist before any fetch", async () => {
  let calls = 0;
  const client = createSarvamOutboundClient({
    config,
    fetchImpl: async () => {
      calls += 1;
      return response(200, { attempt_id: "attempt-test-1" });
    },
  });

  await assert.rejects(
    () => client.createCall({ ...booking, to: "919999999999" }),
    /allowlist/
  );
  assert.equal(calls, 0);
});

test("rejects an invalid successful response as uncertain", async () => {
  const client = createSarvamOutboundClient({
    config,
    fetchImpl: async () => response(200, { accepted: true }),
  });

  await assert.rejects(
    () => client.createCall(booking),
    (error) => error instanceof SarvamOutboundError && error.kind === "unknown"
  );
});

test("classifies definitive HTTP rejection", async () => {
  const client = createSarvamOutboundClient({
    config,
    fetchImpl: async () => response(422, { detail: "invalid" }),
  });

  await assert.rejects(
    () => client.createCall(booking),
    (error) => error instanceof SarvamOutboundError && error.kind === "rejected"
  );
});

test("classifies rate limits, server errors, and network failures as uncertain", async () => {
  for (const failure of [response(429, "busy"), response(503, "down")]) {
    const client = createSarvamOutboundClient({ config, fetchImpl: async () => failure });
    await assert.rejects(
      () => client.createCall(booking),
      (error) => error instanceof SarvamOutboundError && error.kind === "unknown"
    );
  }

  const networkClient = createSarvamOutboundClient({
    config,
    fetchImpl: async () => {
      throw new Error("socket closed");
    },
  });
  await assert.rejects(
    () => networkClient.createCall(booking),
    (error) => error instanceof SarvamOutboundError && error.kind === "unknown"
  );
});
