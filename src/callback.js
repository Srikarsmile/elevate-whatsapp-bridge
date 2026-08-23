import { z } from "zod";

import { ALLOWED_RECIPIENTS } from "./message.js";

const bounded = z.string().trim().min(1).max(500);

const callbackRequestSchema = z
  .object({
    request_id: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
    to: z.enum(ALLOWED_RECIPIENTS),
    callback_time_iso: z.iso.datetime({ offset: true }),
    callback_time_human: bounded,
    timezone: z.literal("Asia/Kolkata"),
    prospect_name: bounded,
    context_summary: bounded,
  })
  .strict();

export function parseCallbackRequest(value, { now = new Date() } = {}) {
  const parsed = callbackRequestSchema.parse(value);
  if (Date.parse(parsed.callback_time_iso) <= now.getTime()) {
    throw new Error("Callback time must be in the future");
  }
  return parsed;
}
