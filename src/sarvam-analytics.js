import { z } from "zod";

const DEFAULT_BASE_URL = "https://apps.sarvam.ai/api/analytics/v1";
const MAX_RESPONSE_BYTES = 256 * 1024;
const IDENTIFIER = /^[A-Za-z0-9._:/-]{1,240}$/;

const transcriptTurnSchema = z
  .object({
    role: z.enum(["agent", "user"]),
    en_text: z.string().trim().min(1).max(4000),
  })
  .strict();

const transcriptSchema = z.array(transcriptTurnSchema).max(500);
const analyticsDatetimeSchema = z
  .string()
  .trim()
  .max(80)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/);
const messageSchema = z
  .object({
    turn_id: z.number().int().positive(),
    role: z.enum(["assistant", "user"]),
    content: z.string().trim().min(1).max(4000),
    language_name: z.string().trim().min(1).max(80),
  })
  .strict();
const responseSchema = z.union([
  transcriptSchema,
  z.object({ interaction_transcript: transcriptSchema }).strict(),
  z
    .object({
      interaction_id: z.string().trim().min(1).max(240),
      messages: z.array(messageSchema).max(500),
    })
    .strict(),
]);
const attemptSchema = z.object({
  attempt_id: z.string().trim().min(1).max(240),
  interaction_id: z.string().trim().min(1).max(240).nullable().optional(),
  connectivity_status: z.string().trim().min(1).max(120).nullable().optional(),
  failure_reason: z.string().trim().min(1).max(1000).nullable().optional(),
  ended_by: z.string().trim().min(1).max(120).nullable().optional(),
  duration_in_seconds: z.number().nonnegative().max(24 * 60 * 60).nullable().optional(),
  start_datetime: analyticsDatetimeSchema.nullable().optional(),
  end_datetime: analyticsDatetimeSchema.nullable().optional(),
  channel_provider: z.string().trim().min(1).max(120).nullable().optional(),
  agent_variables: z.record(z.string().trim().min(1).max(160), z.unknown()).nullable().optional(),
});
const attemptsResponseSchema = z.object({
  items: z.array(attemptSchema).max(1000),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

function isoDatetime(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new SarvamAnalyticsError(`${label} is invalid`, { code: "invalid_datetime" });
  }
  return date.toISOString();
}

export class SarvamAnalyticsError extends Error {
  constructor(message, { code, status = null } = {}) {
    super(message);
    this.name = "SarvamAnalyticsError";
    this.code = code;
    this.status = status;
  }
}

export function createSarvamAnalyticsClient({
  config,
  fetchImpl = fetch,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 8000,
}) {
  return Object.freeze({
    async getAttempt(attemptId, { startDatetime, endDatetime }) {
      if (typeof attemptId !== "string" || !IDENTIFIER.test(attemptId)) {
        throw new SarvamAnalyticsError("Sarvam attempt ID is invalid", {
          code: "invalid_attempt_id",
        });
      }
      const url = new URL(
        `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(
          config.orgId
        )}/${encodeURIComponent(config.workspaceId)}/${encodeURIComponent(
          config.appId
        )}/attempts`
      );
      url.searchParams.set("start_datetime", isoDatetime(startDatetime, "Start datetime"));
      url.searchParams.set("end_datetime", isoDatetime(endDatetime, "End datetime"));
      url.searchParams.set(
        "filter_conditions",
        JSON.stringify([
          { id: "attempt", field: "attempt_id", operator: "equals", value: attemptId },
        ])
      );

      let result;
      try {
        result = await fetchImpl(url, {
          method: "GET",
          headers: { "x-api-key": config.apiKey },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new SarvamAnalyticsError("Sarvam attempt request failed", {
          code: "network_error",
        });
      }
      if (!result.ok) {
        throw new SarvamAnalyticsError(
          `Sarvam attempt request returned HTTP ${result.status}`,
          { code: "http_error", status: result.status }
        );
      }

      let payload;
      try {
        const text = await result.text();
        if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Response too large");
        payload = attemptsResponseSchema.parse(JSON.parse(text));
      } catch {
        throw new SarvamAnalyticsError("Sarvam attempt response is invalid", {
          code: "invalid_response",
          status: result.status,
        });
      }
      const attempt = payload.items.find((item) => item.attempt_id === attemptId);
      return attempt ? Object.freeze({ ...attempt }) : null;
    },
    async getTranscript(interactionId) {
      if (typeof interactionId !== "string" || !IDENTIFIER.test(interactionId)) {
        throw new SarvamAnalyticsError("Sarvam interaction ID is invalid", {
          code: "invalid_interaction_id",
        });
      }

      const url = `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(
        config.orgId
      )}/${encodeURIComponent(config.workspaceId)}/${encodeURIComponent(
        config.appId
      )}/transcripts/${encodeURIComponent(interactionId)}`;

      let result;
      try {
        result = await fetchImpl(url, {
          method: "GET",
          headers: { "x-api-key": config.apiKey },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new SarvamAnalyticsError("Sarvam transcript request failed", {
          code: "network_error",
        });
      }

      if (!result.ok) {
        throw new SarvamAnalyticsError(
          `Sarvam transcript request returned HTTP ${result.status}`,
          { code: "http_error", status: result.status }
        );
      }

      let payload;
      try {
        const text = await result.text();
        if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
          throw new Error("Response too large");
        }
        payload = responseSchema.parse(JSON.parse(text));
      } catch {
        throw new SarvamAnalyticsError("Sarvam transcript response is invalid", {
          code: "invalid_response",
          status: result.status,
        });
      }

      if (Array.isArray(payload)) return payload;
      if ("interaction_transcript" in payload) return payload.interaction_transcript;
      return payload.messages.map((message) => ({
        role: message.role === "assistant" ? "agent" : "user",
        en_text: message.content,
      }));
    },
  });
}
