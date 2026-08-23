import { assertAllowedRecipient, normalizeIndianPhone } from "./phone-policy.js";

const DEFAULT_BASE_URL = "https://apps.sarvam.ai/api/outbounds/v1";
const DEFINITIVE_REJECTIONS = new Set([400, 401, 403, 404, 409, 422]);
const ATTEMPT_ID = /^[A-Za-z0-9._:/-]{1,240}$/;

export class SarvamOutboundError extends Error {
  constructor(message, { kind, status = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SarvamOutboundError";
    this.kind = kind;
    this.status = status;
  }
}

export function buildOutboundPayload(booking, config) {
  const recipient = assertAllowedRecipient(booking.to);
  const agentPhone = normalizeIndianPhone(config.agentPhoneNumber);
  return {
    app_config: {
      app_id: config.appId,
      app_version: config.appVersion,
      connection_config: {
        connection_id: config.connectionId,
        agent_phone_number: `+${agentPhone}`,
      },
      agent_variables: {
        prospect_name: booking.prospect_name,
        callback_context: booking.context_summary,
      },
    },
    user_config: { user_phone_number: `+${recipient}` },
    webhook_config: {
      url: `${config.webhookBaseUrl}/v1/sarvam/outbound-events/${encodeURIComponent(
        config.webhookToken
      )}`,
      metadata: {
        booking_id: booking.booking_id,
        request_id: booking.request_id,
      },
    },
  };
}

export function createSarvamOutboundClient({
  config,
  fetchImpl = fetch,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 8000,
}) {
  return Object.freeze({
    preview(booking) {
      return buildOutboundPayload(booking, config);
    },
    async createCall(booking) {
      const payload = buildOutboundPayload(booking, config);
      const url = `${baseUrl.replace(/\/+$/, "")}/orgs/${encodeURIComponent(
        config.orgId
      )}/workspaces/${encodeURIComponent(config.workspaceId)}/outbounds`;
      let result;
      try {
        result = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": config.apiKey,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw new SarvamOutboundError("Sarvam outbound delivery is uncertain", {
          kind: "unknown",
          cause,
        });
      }

      if (!result.ok) {
        const kind = DEFINITIVE_REJECTIONS.has(result.status) ? "rejected" : "unknown";
        throw new SarvamOutboundError(`Sarvam outbound returned HTTP ${result.status}`, {
          kind,
          status: result.status,
        });
      }

      let data;
      try {
        const text = await result.text();
        if (Buffer.byteLength(text) > 32 * 1024) throw new Error("Response too large");
        data = JSON.parse(text);
      } catch (cause) {
        throw new SarvamOutboundError("Sarvam outbound response is invalid", {
          kind: "unknown",
          status: result.status,
          cause,
        });
      }
      if (!data || typeof data.attempt_id !== "string" || !ATTEMPT_ID.test(data.attempt_id)) {
        throw new SarvamOutboundError("Sarvam outbound response has no valid attempt ID", {
          kind: "unknown",
          status: result.status,
        });
      }
      return Object.freeze({ attemptId: data.attempt_id, payload });
    },
  });
}
