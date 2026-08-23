import { z } from "zod";

import { assertAllowedRecipient } from "./phone-policy.js";

const bounded = z.string().trim().min(1).max(500);
const approvedRecipient = z.string().transform((value, context) => {
  try {
    return assertAllowedRecipient(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Invalid option: recipient is not in the demo allowlist",
    });
    return z.NEVER;
  }
});

const callbackRequestSchema = z
  .object({
    request_id: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
    to: approvedRecipient,
    callback_time_iso: z.iso.datetime({ offset: true }),
    callback_time_human: bounded,
    timezone: z.literal("Asia/Kolkata"),
    prospect_name: bounded,
    context_summary: bounded,
    confirmed_by_user: z.literal(true),
    confirmed_at: z.iso.datetime({ offset: true }).optional(),
    source_interaction_id: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

export function parseCallbackRequest(value, { now = new Date() } = {}) {
  const parsed = callbackRequestSchema.parse(value);
  const callback = {
    ...parsed,
    confirmed_at: parsed.confirmed_at || now.toISOString(),
  };
  const delayMs = Date.parse(callback.callback_time_iso) - now.getTime();
  if (delayMs <= 0) {
    throw new Error("Callback time must be in the future");
  }
  if (delayMs < 15_000) {
    throw new Error("Callback must be at least 15 seconds in the future");
  }
  if (delayMs > 7 * 24 * 60 * 60 * 1000) {
    throw new Error("Callback must be within seven days");
  }
  if (Date.parse(callback.confirmed_at) > now.getTime()) {
    throw new Error("Callback confirmation time cannot be in the future");
  }
  return callback;
}
