import { createHmac } from "node:crypto";

export const ASSIGNMENT_RECIPIENT = "918688664337";
export const CONTROLLED_TEST_RECIPIENT = "918639885985";
export const ALLOWED_RECIPIENTS = Object.freeze([
  ASSIGNMENT_RECIPIENT,
  CONTROLLED_TEST_RECIPIENT,
]);
export const SRIKAR_CONTACT = "+918639885985";
const RECIPIENT_ALIASES = Object.freeze({
  assignment: ASSIGNMENT_RECIPIENT,
  controlled_test: CONTROLLED_TEST_RECIPIENT,
});

export function normalizeIndianPhone(value) {
  if (typeof value !== "string") throw new Error("Invalid Indian mobile number");
  const compact = value.trim().replace(/[\s()-]/g, "");
  const digits = compact.startsWith("+") ? compact.slice(1) : compact;
  const normalized = /^[6-9]\d{9}$/.test(digits) ? `91${digits}` : digits;
  if (!/^91[6-9]\d{9}$/.test(normalized)) {
    throw new Error("Invalid Indian mobile number");
  }
  return normalized;
}

export function assertAllowedRecipient(value) {
  const normalized = normalizeIndianPhone(value);
  if (!ALLOWED_RECIPIENTS.includes(normalized)) {
    throw new Error("Recipient is not in the demo allowlist");
  }
  return normalized;
}

export function recipientForAlias(value) {
  if (typeof value !== "string" || !Object.hasOwn(RECIPIENT_ALIASES, value)) {
    throw new Error("Invalid demo recipient alias");
  }
  return RECIPIENT_ALIASES[value];
}

export function redactPhone(value) {
  const normalized = normalizeIndianPhone(value);
  return `${"*".repeat(normalized.length - 4)}${normalized.slice(-4)}`;
}

export function hashPhone(value, salt) {
  if (typeof salt !== "string" || salt.length === 0) {
    throw new Error("Phone hash salt is required");
  }
  return createHmac("sha256", salt).update(normalizeIndianPhone(value)).digest("hex");
}
