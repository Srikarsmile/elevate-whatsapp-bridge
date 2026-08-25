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

test("fetches one redacted attempt by its exact ID", async () => {
  const calls = [];
  const client = createSarvamAnalyticsClient({
    config,
    baseUrl: "https://sarvam.test/api/analytics/v1",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, {
        items: [
          {
            attempt_id: "attempt-123",
            interaction_id: "20260825/interaction-123",
            connectivity_status: "connected",
            failure_reason: "NO_FAILURE_REASON",
            ended_by: "AGENT_ENDS",
            duration_in_seconds: 34.8,
            start_datetime: "2026-08-25T07:18:10",
            end_datetime: "2026-08-25T07:18:45",
            channel_provider: "vobiz",
            agent_variables: { intent_level: "Cold" },
            user_contact_masked: "******5985",
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      });
    },
  });

  const attempt = await client.getAttempt("attempt-123", {
    startDatetime: "2026-08-25T07:00:00.000Z",
    endDatetime: "2026-08-25T08:00:00.000Z",
  });

  assert.deepEqual(attempt, {
    attempt_id: "attempt-123",
    interaction_id: "20260825/interaction-123",
    connectivity_status: "connected",
    failure_reason: "NO_FAILURE_REASON",
    ended_by: "AGENT_ENDS",
    duration_in_seconds: 34.8,
    start_datetime: "2026-08-25T07:18:10",
    end_datetime: "2026-08-25T07:18:45",
    channel_provider: "vobiz",
    agent_variables: { intent_level: "Cold" },
  });
  const requested = new URL(calls[0].url);
  assert.equal(requested.searchParams.get("start_datetime"), "2026-08-25T07:00:00.000Z");
  assert.equal(requested.searchParams.get("end_datetime"), "2026-08-25T08:00:00.000Z");
  assert.match(requested.searchParams.get("filter_conditions"), /attempt-123/);
  assert.doesNotMatch(JSON.stringify(attempt), /5985/);
});

test("returns null when the exact attempt is not present", async () => {
  const client = createSarvamAnalyticsClient({
    config,
    fetchImpl: async () =>
      response(200, { items: [], total: 0, limit: 20, offset: 0 }),
  });
  assert.equal(
    await client.getAttempt("attempt-123", {
      startDatetime: "2026-08-25T07:00:00.000Z",
      endDatetime: "2026-08-25T08:00:00.000Z",
    }),
    null
  );
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
