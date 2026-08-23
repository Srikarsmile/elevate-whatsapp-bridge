import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

import { parseOnEndEvent, parseOutboundEvent } from "./call-event.js";
import { parseCallbackRequest } from "./callback.js";
import { formatMessage, parseMessageRequest } from "./message.js";

const DEFAULT_BODY_LIMIT = 32 * 1024;
const DEFAULT_WEBHOOK_BODY_LIMIT = 256 * 1024;

function secureEqual(left, right) {
  const leftDigest = createHash("sha256").update(String(left)).digest();
  const rightDigest = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function bearerToken(request) {
  const value = request.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function readJson(request, bodyLimitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > bodyLimitBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function createRateLimiter({ max, windowMs }) {
  const clients = new Map();
  return (client, now = Date.now()) => {
    const current = clients.get(client);
    if (!current || now - current.startedAt >= windowMs) {
      clients.set(client, { count: 1, startedAt: now });
      return true;
    }
    current.count += 1;
    return current.count <= max;
  };
}

function webhookRoute(pathname) {
  const match = pathname.match(/^\/v1\/sarvam\/(outbound-events|on-end)\/([^/]+)$/);
  if (!match) return null;
  try {
    return { kind: match[1], token: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

function transitionMetadata(event) {
  return Object.fromEntries(
    Object.entries({
      attempt_id: event.attempt_id,
      interaction_id: event.interaction_id,
      failure_reason: event.failure_reason,
    }).filter(([, value]) => value !== null && value !== undefined)
  );
}

async function applyOutboundEvent(callbackStore, bookingId, event) {
  let booking = callbackStore.get(bookingId);
  if (booking.status === "dispatching") {
    booking = await callbackStore.transition(bookingId, "dialing", {
      at: event.received_at,
      reason: "sarvam_webhook_received",
      metadata: transitionMetadata(event),
    });
  }
  if (booking.status === "dialing") {
    await callbackStore.transition(bookingId, event.status, {
      at: event.received_at,
      reason: `sarvam_${event.status}`,
      metadata: transitionMetadata(event),
    });
  }
}

export function createBridgeServer({
  secret,
  transport,
  store,
  callbackStore,
  callEventStore = null,
  webhookToken = null,
  phoneHashSalt = null,
  healthStatus = null,
  architectureImagePath = null,
  resumePath = null,
  implementationNote = null,
  bodyLimitBytes = DEFAULT_BODY_LIMIT,
  webhookBodyLimitBytes = DEFAULT_WEBHOOK_BODY_LIMIT,
  rateLimit = { max: 10, windowMs: 60_000 },
  logger = console,
}) {
  if (!secret || secret.length < 24) throw new Error("Bridge secret must be at least 24 characters");
  if (!callbackStore) throw new Error("Callback store is required");
  if (webhookToken && webhookToken.length < 24) {
    throw new Error("Sarvam webhook token must be at least 24 characters");
  }
  if (webhookToken && (!callEventStore || !phoneHashSalt)) {
    throw new Error("Sarvam webhook storage and phone hash salt are required");
  }
  const allowRequest = createRateLimiter(rateLimit);
  const inFlight = new Map();

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "GET" && url.pathname === "/health") {
      const whatsapp = transport.status();
      sendJson(response, whatsapp === "connected" ? 200 : 503, {
        ok: whatsapp === "connected",
        whatsapp,
        ...(healthStatus ? healthStatus() : {}),
      });
      return;
    }

    const sarvamWebhook = request.method === "POST" ? webhookRoute(url.pathname) : null;
    if (sarvamWebhook) {
      if (!webhookToken || !secureEqual(sarvamWebhook.token, webhookToken)) {
        sendJson(response, 404, { ok: false, error: "Not found" });
        return;
      }

      let body;
      try {
        body = await readJson(request, webhookBodyLimitBytes);
      } catch (error) {
        sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
        return;
      }

      let event;
      let bookingId = null;
      try {
        if (sarvamWebhook.kind === "outbound-events") {
          bookingId = body?.webhook_config?.metadata?.booking_id;
          const booking = typeof bookingId === "string" ? callbackStore.get(bookingId) : null;
          if (!booking) {
            sendJson(response, 404, { ok: false, error: "Callback booking not found" });
            return;
          }
          event = parseOutboundEvent(body, {
            phoneHashSalt,
            recipientPhone: booking.to,
          });
        } else {
          event = parseOnEndEvent(body, { phoneHashSalt });
        }
      } catch {
        sendJson(response, 400, { ok: false, error: "Invalid Sarvam event" });
        return;
      }

      let stored;
      try {
        stored = await callEventStore.put(event);
      } catch {
        logger.error({ eventId: event.event_id, status: "call_event_store_error" });
        sendJson(response, 503, { ok: false, error: "Call event storage unavailable" });
        return;
      }

      if (!stored.duplicate && bookingId) {
        try {
          await applyOutboundEvent(callbackStore, bookingId, event);
        } catch {
          logger.error({
            eventId: event.event_id,
            bookingId,
            status: "callback_transition_error",
          });
        }
      }
      logger.info({
        eventId: event.event_id,
        interactionId: event.interaction_id,
        source: event.source,
        status: event.status,
        duplicate: stored.duplicate,
      });
      sendJson(response, 200, { ok: true, duplicate: stored.duplicate });
      return;
    }

    const isMessagePost = request.method === "POST" && url.pathname === "/v1/messages";
    const isCallbackPost = request.method === "POST" && url.pathname === "/v1/callbacks";
    const callbackStatusMatch =
      request.method === "GET"
        ? url.pathname.match(/^\/v1\/callbacks\/(cb-[a-f0-9]{16})$/)
        : null;
    if (!isMessagePost && !isCallbackPost && !callbackStatusMatch) {
      sendJson(response, 404, { ok: false, error: "Not found" });
      return;
    }

    if (!secureEqual(bearerToken(request), secret)) {
      sendJson(response, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    if (callbackStatusMatch) {
      const booking = callbackStore.get(callbackStatusMatch[1]);
      if (!booking) {
        sendJson(response, 404, { ok: false, error: "Callback booking not found" });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        bookingId: booking.booking_id,
        status: booking.status,
        callbackTimeIso: booking.callback_time_iso,
        callbackTimeHuman: booking.callback_time_human,
      });
      return;
    }

    const client = request.socket.remoteAddress || "unknown";
    if (!allowRequest(client)) {
      sendJson(response, 429, { ok: false, error: "Rate limit exceeded" });
      return;
    }

    let body;
    try {
      body = await readJson(request, bodyLimitBytes);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
      return;
    }

    const headerRequestId = request.headers["idempotency-key"]?.trim();
    const bodyRequestId = typeof body?.request_id === "string" ? body.request_id.trim() : "";
    if (headerRequestId && bodyRequestId && headerRequestId !== bodyRequestId) {
      sendJson(response, 409, { ok: false, error: "Conflicting request IDs" });
      return;
    }
    const requestId = headerRequestId || bodyRequestId;
    if (!requestId) {
      sendJson(response, 400, { ok: false, error: "Request ID required" });
      return;
    }

    if (isCallbackPost) {
      let callback;
      try {
        callback = parseCallbackRequest({ ...body, request_id: requestId });
      } catch {
        sendJson(response, 400, { ok: false, error: "Invalid callback request" });
        return;
      }
      try {
        const { booking, duplicate } = await callbackStore.book(callback);
        logger.info({
          requestId,
          bookingId: booking.booking_id,
          status: booking.status,
        });
        sendJson(response, duplicate ? 200 : 201, {
          ok: true,
          bookingId: booking.booking_id,
          status: booking.status,
          duplicate,
        });
      } catch {
        logger.error({ requestId, status: "callback_store_error" });
        sendJson(response, 503, { ok: false, error: "Callback booking unavailable" });
      }
      return;
    }

    let parsed;
    try {
      parsed = parseMessageRequest({ ...body, request_id: requestId });
    } catch {
      sendJson(response, 400, { ok: false, error: "Invalid message request" });
      return;
    }

    const previous = store.get(requestId);
    if (previous) {
      sendJson(response, 200, { ...previous, duplicate: true });
      return;
    }

    if (inFlight.has(requestId)) {
      const pending = await inFlight.get(requestId);
      sendJson(response, 200, { ...pending, duplicate: true });
      return;
    }

    const delivery = (async () => {
      const message = formatMessage(parsed, {
        architectureImagePath,
        resumePath,
        implementationNote,
      });
      await transport.send({ to: parsed.to, ...message });
      const result = { ok: true, requestId };
      await store.put(requestId, result);
      logger.info({ requestId, stage: parsed.stage, status: "delivered" });
      return result;
    })();
    inFlight.set(requestId, delivery);

    try {
      const result = await delivery;
      sendJson(response, 202, { ...result, duplicate: false });
    } catch {
      logger.error({ requestId, stage: parsed.stage, status: "transport_error" });
      sendJson(response, 503, { ok: false, error: "WhatsApp delivery unavailable" });
    } finally {
      inFlight.delete(requestId);
    }
  });
}
