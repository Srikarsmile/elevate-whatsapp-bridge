import { normalizeIndianPhone } from "./phone-policy.js";

const MODES = new Set(["disabled", "dry_run", "live"]);
const SARVAM_KEYS = [
  "SARVAM_API_KEY",
  "SARVAM_ORG_ID",
  "SARVAM_WORKSPACE_ID",
  "SARVAM_APP_ID",
  "SARVAM_APP_VERSION",
  "SARVAM_CONNECTION_ID",
  "SARVAM_AGENT_PHONE_NUMBER",
  "SARVAM_WEBHOOK_BASE_URL",
  "SARVAM_WEBHOOK_TOKEN",
  "PHONE_HASH_SALT",
];

function requiredValue(env, key) {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

function validateSecret(value, label) {
  if (value.length < 32) throw new Error(`${label} must be at least 32 characters`);
  return value;
}

export function loadConfig(env = process.env) {
  const callbackDispatchMode = requiredValue(env, "CALLBACK_DISPATCH_MODE") || "disabled";
  if (!MODES.has(callbackDispatchMode)) throw new Error("Invalid callback dispatch mode");

  const sarvamRequested = SARVAM_KEYS.some((key) => Object.hasOwn(env, key));
  const missing = sarvamRequested
    ? SARVAM_KEYS.filter((key) => requiredValue(env, key).length === 0)
    : [];
  if (missing.length > 0) {
    throw new Error(`Missing Sarvam environment: ${missing.join(", ")}`);
  }
  if (callbackDispatchMode !== "disabled" && !sarvamRequested) {
    throw new Error(`${callbackDispatchMode} callback dispatch requires Sarvam configuration`);
  }

  let sarvam = null;
  let phoneHashSalt = null;
  let webhookToken = null;
  if (sarvamRequested) {
    const appVersionText = requiredValue(env, "SARVAM_APP_VERSION");
    const appVersion = Number(appVersionText);
    if (!Number.isSafeInteger(appVersion) || appVersion <= 0) {
      throw new Error("Sarvam app version must be a positive integer");
    }

    const webhookBaseUrl = requiredValue(env, "SARVAM_WEBHOOK_BASE_URL").replace(/\/+$/, "");
    let parsedWebhookUrl;
    try {
      parsedWebhookUrl = new URL(webhookBaseUrl);
    } catch {
      throw new Error("Sarvam webhook base URL must be valid HTTPS");
    }
    if (parsedWebhookUrl.protocol !== "https:") {
      throw new Error("Sarvam webhook base URL must use HTTPS");
    }

    webhookToken = validateSecret(
      requiredValue(env, "SARVAM_WEBHOOK_TOKEN"),
      "Sarvam webhook token"
    );
    phoneHashSalt = validateSecret(
      requiredValue(env, "PHONE_HASH_SALT"),
      "phone hash salt"
    );
    sarvam = Object.freeze({
      apiKey: requiredValue(env, "SARVAM_API_KEY"),
      orgId: requiredValue(env, "SARVAM_ORG_ID"),
      workspaceId: requiredValue(env, "SARVAM_WORKSPACE_ID"),
      appId: requiredValue(env, "SARVAM_APP_ID"),
      appVersion,
      connectionId: requiredValue(env, "SARVAM_CONNECTION_ID"),
      agentPhoneNumber: `+${normalizeIndianPhone(
        requiredValue(env, "SARVAM_AGENT_PHONE_NUMBER")
      )}`,
      webhookBaseUrl,
      webhookToken,
    });
  }

  const feedbackWorkerTokenValue = requiredValue(env, "FEEDBACK_WORKER_TOKEN");
  const feedbackWorkerToken = feedbackWorkerTokenValue
    ? validateSecret(feedbackWorkerTokenValue, "Feedback worker token")
    : null;

  return Object.freeze({
    callbackDispatchMode,
    sarvamConfigured: sarvam !== null,
    sarvam,
    phoneHashSalt,
    webhookToken,
    feedbackWorkerToken,
  });
}
