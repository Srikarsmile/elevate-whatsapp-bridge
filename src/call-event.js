import { createHash } from "node:crypto";

import { z } from "zod";

import { assertAllowedRecipient, hashPhone, normalizeIndianPhone } from "./phone-policy.js";

const boundedId = z.string().trim().min(1).max(240);
const statusSchema = z.enum(["connected", "no_answer", "busy", "failed"]);
const transcriptTurnSchema = z
  .object({
    role: z.enum(["agent", "user"]),
    en_text: z.string().trim().min(1).max(4000),
  })
  .strict();
const transcriptSchema = z.array(transcriptTurnSchema).max(500).nullable();
const variablesSchema = z.record(z.string().trim().min(1).max(160), z.unknown()).nullable();
const correlationSchema = z
  .object({
    booking_id: z.string().regex(/^cb-[a-f0-9]{16}$/).optional(),
    recipient_alias: z.enum(["assignment", "controlled_test"]).optional(),
    request_id: z.string().trim().min(8).max(160).optional(),
  })
  .strict()
  .nullable();

const outboundSchema = z
  .object({
    attempt_id: boundedId,
    status: statusSchema,
    channel_info: z
      .object({
        channel_type: z.enum(["v2v", "whatsapp"]),
        channel_provider: z.string().trim().min(1).max(120),
        agent_phone_number: z.string().trim().min(1).max(40),
      })
      .strict(),
    duration: z.number().nonnegative().max(24 * 60 * 60).nullable(),
    interaction_id: boundedId.nullable(),
    failure_reason: z.string().trim().min(1).max(1000).nullable(),
    final_agent_variables: variablesSchema,
    webhook_config: z
      .object({
        url: z.url(),
        metadata: correlationSchema,
      })
      .strict()
      .nullable(),
    interaction_transcript: transcriptSchema,
  })
  .strict();

const toolResultSchema = z
  .object({
    name: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
    status: z.enum(["success", "error"]),
    booking_id: z.string().regex(/^cb-[a-f0-9]{16}$/).optional(),
  })
  .strict();

const onEndSchema = z
  .object({
    interaction_id: boundedId,
    app_id: boundedId,
    app_version: z.number().int().positive(),
    status: statusSchema,
    duration: z.number().nonnegative().max(24 * 60 * 60).nullable(),
    user_phone_number: z.string().trim().min(1).max(40),
    final_agent_variables: variablesSchema,
    interaction_transcript: transcriptSchema,
    tool_results: z.array(toolResultSchema).max(50),
  })
  .strict();

const PHONE_IN_TEXT = /(?:\+?91[\s()-]*)?[6-9](?:[\s()-]*\d){9}/g;

function redactText(value) {
  return value.replace(PHONE_IN_TEXT, "[redacted-phone]");
}

function sanitize(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

function assertVariablesSize(variables) {
  if (variables && Buffer.byteLength(JSON.stringify(variables)) > 16 * 1024) {
    throw new Error("Final agent variables too large");
  }
}

function receivedAtIso(receivedAt) {
  const date = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid event receipt time");
  return date.toISOString();
}

function transcriptStatus(transcript, interactionId) {
  if (Array.isArray(transcript) && transcript.length > 0) return "available";
  return interactionId ? "pending" : "unavailable";
}

function phoneFields(phone, salt) {
  if (!phone) return { phone_hash: null, phone_last4: null };
  const normalized = assertAllowedRecipient(phone);
  return {
    phone_hash: hashPhone(normalized, salt),
    phone_last4: normalized.slice(-4),
  };
}

export function eventIdFor(value) {
  const key = value?.interaction_id
    ? `interaction:${value.interaction_id}`
    : value?.attempt_id
      ? `attempt:${value.attempt_id}`
      : null;
  if (!key) throw new Error("Call event requires an interaction or attempt ID");
  return `evt-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

export function parseOutboundEvent(
  value,
  { phoneHashSalt, receivedAt = new Date(), recipientPhone = null }
) {
  const parsed = outboundSchema.parse(value);
  assertVariablesSize(parsed.final_agent_variables);
  const transcript = parsed.interaction_transcript
    ? parsed.interaction_transcript.map((turn) => ({
        role: turn.role,
        en_text: redactText(turn.en_text),
      }))
    : null;
  return Object.freeze({
    event_id: eventIdFor(parsed),
    source: "instant_outbound",
    attempt_id: parsed.attempt_id,
    interaction_id: parsed.interaction_id,
    status: parsed.status,
    duration: parsed.duration,
    failure_reason: parsed.failure_reason ? redactText(parsed.failure_reason) : null,
    channel_type: parsed.channel_info.channel_type,
    channel_provider: parsed.channel_info.channel_provider,
    agent_phone_last4: normalizeIndianPhone(parsed.channel_info.agent_phone_number).slice(-4),
    app_id: null,
    app_version: null,
    final_agent_variables: sanitize(parsed.final_agent_variables),
    tool_results: [],
    transcript,
    ...phoneFields(recipientPhone, phoneHashSalt),
    correlation: parsed.webhook_config?.metadata || null,
    transcript_status: transcriptStatus(transcript, parsed.interaction_id),
    evaluation_status: "pending",
    received_at: receivedAtIso(receivedAt),
  });
}

export function parseOnEndEvent(value, { phoneHashSalt, receivedAt = new Date() }) {
  const parsed = onEndSchema.parse(value);
  assertVariablesSize(parsed.final_agent_variables);
  const transcript = parsed.interaction_transcript
    ? parsed.interaction_transcript.map((turn) => ({
        role: turn.role,
        en_text: redactText(turn.en_text),
      }))
    : null;
  const callbackResult = parsed.tool_results.find(
    (result) => result.name === "schedule_callback" && result.booking_id
  );
  return Object.freeze({
    event_id: eventIdFor(parsed),
    source: "on_end",
    attempt_id: null,
    interaction_id: parsed.interaction_id,
    status: parsed.status,
    duration: parsed.duration,
    failure_reason: null,
    channel_type: null,
    channel_provider: null,
    agent_phone_last4: null,
    app_id: parsed.app_id,
    app_version: parsed.app_version,
    final_agent_variables: sanitize(parsed.final_agent_variables),
    tool_results: parsed.tool_results.map((result) => ({ ...result })),
    transcript,
    ...phoneFields(parsed.user_phone_number, phoneHashSalt),
    correlation: callbackResult ? { booking_id: callbackResult.booking_id } : null,
    transcript_status: transcriptStatus(transcript, parsed.interaction_id),
    evaluation_status: "pending",
    received_at: receivedAtIso(receivedAt),
  });
}
