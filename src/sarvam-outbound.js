import {
  assertAllowedRecipient,
  normalizeIndianPhone,
  recipientForAlias,
} from "./phone-policy.js";

const DEFAULT_BASE_URL = "https://apps.sarvam.ai/api/outbounds/v1";
const DEFINITIVE_REJECTIONS = new Set([400, 401, 403, 404, 409, 422]);
const ATTEMPT_ID = /^[A-Za-z0-9._:/-]{1,240}$/;
const REQUEST_ID = /^[A-Za-z0-9._:/-]{8,160}$/;

function webhookUrl(config) {
  return `${config.webhookBaseUrl}/v1/sarvam/outbound-events/${encodeURIComponent(
    config.webhookToken
  )}`;
}

function commonAppConfig(config, agentVariables) {
  const agentPhone = normalizeIndianPhone(config.agentPhoneNumber);
  return {
    app_id: config.appId,
    app_version: config.appVersion,
    connection_config: {
      connection_id: config.connectionId,
      agent_phone_number: `+${agentPhone}`,
    },
    agent_variables: agentVariables,
  };
}

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
  return {
    app_config: commonAppConfig(config, {
      prospect_name: booking.prospect_name,
      recipient_number: `+${recipient}`,
      user_name: booking.prospect_name,
      initial_call_type: "callback",
      prior_call_context: booking.context_summary,
      requested_callback_time: booking.callback_time_human,
    }),
    user_config: { user_phone_number: `+${recipient}` },
    webhook_config: {
      url: webhookUrl(config),
      metadata: {
        booking_id: booking.booking_id,
        request_id: booking.request_id,
      },
    },
  };
}

export function buildFirstCallPayload(request, config) {
  const recipient = recipientForAlias(request?.recipient_alias);
  const prospectName = request?.prospect_name?.trim();
  const requestId = request?.request_id?.trim();
  if (!prospectName || prospectName.length > 120) {
    throw new Error("First-call prospect name is invalid");
  }
  if (!requestId || !REQUEST_ID.test(requestId)) {
    throw new Error("First-call request ID is invalid");
  }
  return {
    app_config: commonAppConfig(config, {
      prospect_name: prospectName,
      recipient_number: `+${recipient}`,
      user_name: prospectName,
      initial_call_type: "first_call",
      prior_call_context: "",
      requested_callback_time: "",
    }),
    user_config: { user_phone_number: `+${recipient}` },
    webhook_config: {
      url: webhookUrl(config),
      metadata: {
        recipient_alias: request.recipient_alias,
        request_id: requestId,
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
  async function sendPayload(payload) {
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
  }

  return Object.freeze({
    preview(booking) {
      return buildOutboundPayload(booking, config);
    },
    previewFirstCall(request) {
      return buildFirstCallPayload(request, config);
    },
    async createCall(booking) {
      return sendPayload(buildOutboundPayload(booking, config));
    },
    async createFirstCall(request) {
      return sendPayload(buildFirstCallPayload(request, config));
    },
  });
}
