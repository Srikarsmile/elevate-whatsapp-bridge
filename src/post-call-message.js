import { parseMessageRequest } from "./message.js";

const FIELD_ALIASES = Object.freeze({
  business: ["business", "business_type", "what_they_sell", "products_sold"],
  products: ["products", "product_count", "number_of_products"],
  budget: ["budget", "budget_range"],
  timeline: ["timeline", "launch_timeline"],
  features: ["features", "required_features"],
  summary: ["follow_up_summary", "summary", "context_summary", "intent_reasons"],
});

function boundedText(value) {
  let text = null;
  if (typeof value === "string") text = value;
  if (typeof value === "number" || typeof value === "boolean") text = String(value);
  if (Array.isArray(value) && value.every((item) => ["string", "number"].includes(typeof item))) {
    text = value.join(", ");
  }
  const normalized = text?.trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}

function firstVariable(variables, aliases) {
  for (const alias of aliases) {
    const value = boundedText(variables?.[alias]);
    if (value) return value;
  }
  return undefined;
}

function classificationFrom(variables) {
  const value = boundedText(
    variables?.intent_level ??
      variables?.intent ??
      variables?.classification ??
      variables?.lead_status
  )?.toLowerCase();
  if (value === "hot") return "Hot";
  if (value === "warm") return "Warm";
  return "Cold";
}

function transcriptSummary(transcript) {
  if (!Array.isArray(transcript)) return undefined;
  const userTurns = transcript
    .filter((turn) => turn?.role === "user")
    .map((turn) => boundedText(turn.en_text))
    .filter(Boolean);
  return boundedText(userTurns.slice(-3).join(" "));
}

export function buildPostCallMessageRequest({ event, recipientPhone }) {
  const variables = event.final_agent_variables || {};
  const facts = Object.fromEntries(
    Object.entries(FIELD_ALIASES)
      .map(([field, aliases]) => [field, firstVariable(variables, aliases)])
      .filter(([, value]) => value)
  );
  if (!facts.summary) facts.summary = transcriptSummary(event.transcript);

  return parseMessageRequest({
    request_id: `post-call:${event.event_id}`,
    to: recipientPhone,
    stage: "post_call",
    classification: classificationFrom(variables),
    ...facts,
  });
}
