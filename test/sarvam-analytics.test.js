import assert from "node:assert/strict";
import test from "node:test";

import {
  SarvamAnalyticsError,
  createSarvamAnalyticsClient,
} from "../src/sarvam-analytics.js";

const config = {
  apiKey: "sarvam-test-key",
  orgId: "org test",
  workspaceId: "workspace/test",
  appId: "app/test",
};

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

test("fetches and validates a transcript with the Sarvam API key", async () => {
  const calls = [];
  const client = createSarvamAnalyticsClient({
    config,
    baseUrl: "https://sarvam.test/api/analytics/v1",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, {
        interaction_transcript: [
          { role: "agent", en_text: "Hello." },
          { role: "user", en_text: "Hi." },
        ],
      });
    },
  });

  const transcript = await client.getTranscript("20260823/interaction-123");

  assert.deepEqual(transcript, [
    { role: "agent", en_text: "Hello." },
    { role: "user", en_text: "Hi." },
  ]);
  assert.equal(
    calls[0].url,
    "https://sarvam.test/api/analytics/v1/org%20test/workspace%2Ftest/app%2Ftest/transcripts/20260823%2Finteraction-123"
  );
  assert.deepEqual(calls[0].options.headers, { "x-api-key": "sarvam-test-key" });
  assert.equal(calls[0].options.method, "GET");
  assert.ok(calls[0].options.signal);
});

test("accepts a direct transcript array response", async () => {
  const client = createSarvamAnalyticsClient({
    config,
    fetchImpl: async () =>
      response(200, [{ role: "agent", en_text: "A direct response." }]),
  });
  assert.deepEqual(await client.getTranscript("interaction-123"), [
    { role: "agent", en_text: "A direct response." },
  ]);
});

test("normalizes the current Sarvam messages transcript response", async () => {
  const client = createSarvamAnalyticsClient({
    config,
    fetchImpl: async () =>
      response(200, {
        interaction_id: "20260823/interaction-123",
        messages: [
          {
            turn_id: 1,
            role: "assistant",
            content: "Hello?",
            language_name: "English",
          },
          {
            turn_id: 2,
            role: "user",
            content: "Hello.",
            language_name: "UNKNOWN",
          },
        ],
      }),
  });

  assert.deepEqual(await client.getTranscript("20260823/interaction-123"), [
    { role: "agent", en_text: "Hello?" },
    { role: "user", en_text: "Hello." },
  ]);
});

test("rejects malformed, oversized, and non-success responses", async () => {
  for (const result of [
    response(200, { interaction_transcript: [{ role: "system", en_text: "bad" }] }),
    response(200, "x".repeat(257 * 1024)),
    response(404, { detail: "missing" }),
  ]) {
    const client = createSarvamAnalyticsClient({ config, fetchImpl: async () => result });
    await assert.rejects(
      () => client.getTranscript("interaction-123"),
      (error) => error instanceof SarvamAnalyticsError
    );
  }
});

test("wraps network failures without leaking the API key", async () => {
  const client = createSarvamAnalyticsClient({
    config,
    fetchImpl: async () => {
      throw new Error(`socket closed for ${config.apiKey}`);
    },
  });

  await assert.rejects(
    () => client.getTranscript("interaction-123"),
    (error) =>
      error instanceof SarvamAnalyticsError &&
      error.code === "network_error" &&
      !error.message.includes(config.apiKey)
  );
});
