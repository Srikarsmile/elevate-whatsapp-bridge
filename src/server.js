import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

import { parseOnEndEvent, parseOutboundEvent } from "./call-event.js";
import { parseCallbackRequest } from "./callback.js";
import { EvaluationQueueError } from "./evaluation-queue.js";
import { FeedbackLoopError } from "./feedback-loop.js";
import { formatMessage, parseMessageRequest } from "./message.js";
import { buildPostCallMessageRequest } from "./post-call-message.js";

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

function feedbackErrorStatus(error) {
  if (!(error instanceof FeedbackLoopError)) return 400;
  if (error.code === "not_found") return 404;
  if (error.code === "invalid_state") return 409;
  return 400;
}

function recommendationRoute(method, pathname) {
  if (method === "GET" && pathname === "/v1/recommendations") {
    return { action: "list", recommendationId: null };
  }
  const match = pathname.match(
    /^\/v1\/recommendations\/(rec-[a-f0-9]{24})(?:\/(approve|reject|promote))?$/
  );
  if (!match) return null;
  if (method === "GET" && !match[2]) {
    return { action: "show", recommendationId: match[1] };
  }
  if (method === "POST" && match[2]) {
    return { action: match[2], recommendationId: match[1] };
  }
  return null;
}

function isLoopbackAddress(value) {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function evaluationQueueErrorStatus(error) {
  if (!(error instanceof EvaluationQueueError)) return 400;
  if (error.code === "not_found") return 404;
  if (error.code === "lease_mismatch") return 409;
  return 400;
}

function sarvamToolRequestId(action, body) {
  const normalized = Object.fromEntries(
    Object.entries(body && typeof body === "object" ? body : {}).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
  const digest = createHash("sha256")
    .update(`${action}:${JSON.stringify(normalized)}`)
    .digest("hex")
    .slice(0, 24);
  return `sarvam:${action}:${digest}`;
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
  if (["dialing", "outcome_unknown"].includes(booking.status)) {
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
  feedbackLoop = null,
  feedbackWorkerToken = null,
  evaluationQueue = null,
  architectureImagePath = null,
  repositoryUrl = null,
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
  if (feedbackWorkerToken && feedbackWorkerToken.length < 24) {
    throw new Error("Feedback worker token must be at least 24 characters");
  }
  if (feedbackWorkerToken && !evaluationQueue) {
    throw new Error("Evaluation queue is required for the feedback worker");
  }
  const allowRequest = createRateLimiter(rateLimit);
  const inFlight = new Map();

  async function deliverMessage(parsed) {
    const requestId = parsed.request_id;
    const previous = store.get(requestId);
    if (previous) return { ...previous, duplicate: true };
    if (inFlight.has(requestId)) {
      return { ...(await inFlight.get(requestId)), duplicate: true };
    }

    const delivery = (async () => {
      const message = formatMessage(parsed, {
        architectureImagePath,
        repositoryUrl,
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
      return { ...(await delivery), duplicate: false };
    } finally {
      inFlight.delete(requestId);
    }
  }

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

    const internalEvaluationMatch =
      request.method === "POST"
        ? url.pathname.match(/^\/v1\/internal\/evaluations\/(claim|complete)$/)
        : null;
    if (internalEvaluationMatch) {
      if (!feedbackWorkerToken || !isLoopbackAddress(request.socket.remoteAddress)) {
        sendJson(response, 404, { ok: false, error: "Not found" });
        return;
      }
      if (!secureEqual(bearerToken(request), feedbackWorkerToken)) {
        sendJson(response, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      let body;
      try {
        body = await readJson(request, bodyLimitBytes);
      } catch (error) {
        sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
        return;
      }
      try {
        if (internalEvaluationMatch[1] === "claim") {
          if (!body || typeof body !== "object" || Object.keys(body).length !== 0) {
            throw new EvaluationQueueError("Claim body must be empty", "invalid_input");
          }
          const job = await evaluationQueue.claim();
          if (job) {
            logger.info({ jobId: job.job_id, status: "evaluation_leased" });
          }
          sendJson(response, 200, { ok: true, job });
          return;
        }

        if (
          !body ||
          typeof body !== "object" ||
          Object.keys(body).some(
            (key) => !["job_id", "lease_token", "result", "error_code"].includes(key)
          )
        ) {
          throw new EvaluationQueueError("Completion body is invalid", "invalid_input");
        }
        const completed = await evaluationQueue.complete({
          jobId: body.job_id,
          leaseToken: body.lease_token,
          ...(body.result === undefined ? {} : { result: body.result }),
          ...(body.error_code === undefined ? {} : { errorCode: body.error_code }),
        });
        logger.info({
          jobId: completed.job.job_id,
          status: `evaluation_${completed.job.status}`,
          duplicate: completed.duplicate,
        });
        sendJson(response, 200, {
          ok: true,
          status: completed.job.status,
          duplicate: completed.duplicate,
        });
      } catch (error) {
        sendJson(response, evaluationQueueErrorStatus(error), {
          ok: false,
          error:
            error instanceof EvaluationQueueError
              ? error.message
              : "Invalid evaluation worker request",
        });
      }
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
      let booking = null;
      try {
        if (sarvamWebhook.kind === "outbound-events") {
          bookingId = body?.webhook_config?.metadata?.booking_id;
          booking = typeof bookingId === "string" ? callbackStore.get(bookingId) : null;
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

      if (event.status === "connected") {
        let postCallRequest;
        try {
          postCallRequest = buildPostCallMessageRequest({
            event,
            recipientPhone:
              sarvamWebhook.kind === "on-end" ? body.user_phone_number : booking.to,
          });
          await deliverMessage(postCallRequest);
        } catch {
          logger.error({
            eventId: event.event_id,
            requestId: postCallRequest?.request_id,
            stage: "post_call",
            status: "transport_error",
          });
          sendJson(response, 503, { ok: false, error: "Post-call delivery unavailable" });
          return;
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

    const sarvamToolMatch =
      request.method === "POST"
        ? url.pathname.match(/^\/v1\/sarvam\/tools\/(messages|callbacks)$/)
        : null;
    const isMessagePost =
      request.method === "POST" &&
      (url.pathname === "/v1/messages" || sarvamToolMatch?.[1] === "messages");
    const isCallbackPost =
      request.method === "POST" &&
      (url.pathname === "/v1/callbacks" || sarvamToolMatch?.[1] === "callbacks");
    const isFeedbackPost = request.method === "POST" && url.pathname === "/v1/feedback";
    const recommendation = recommendationRoute(request.method, url.pathname);
    const callbackStatusMatch =
      request.method === "GET"
        ? url.pathname.match(/^\/v1\/callbacks\/(cb-[a-f0-9]{16})$/)
        : null;
    if (
      !isMessagePost &&
      !isCallbackPost &&
      !isFeedbackPost &&
      !recommendation &&
      !callbackStatusMatch
    ) {
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

    if (recommendation?.action === "list") {
      if (!feedbackLoop) {
        sendJson(response, 503, { ok: false, error: "Feedback service unavailable" });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        recommendations: feedbackLoop.listRecommendations(),
      });
      return;
    }

    if (recommendation?.action === "show") {
      const record = feedbackLoop?.getRecommendation(recommendation.recommendationId);
      if (!record) {
        sendJson(response, 404, { ok: false, error: "Recommendation not found" });
        return;
      }
      sendJson(response, 200, { ok: true, recommendation: record });
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

    if (recommendation) {
      if (!feedbackLoop) {
        sendJson(response, 503, { ok: false, error: "Feedback service unavailable" });
        return;
      }
      try {
        let record;
        if (recommendation.action === "approve") {
          if (!body || typeof body !== "object" || Object.keys(body).length !== 0) {
            throw new FeedbackLoopError("Approve body must be empty", "invalid_input");
          }
          record = await feedbackLoop.approve(recommendation.recommendationId);
        } else if (recommendation.action === "reject") {
          if (
            !body ||
            typeof body !== "object" ||
            Object.keys(body).some((key) => key !== "reason")
          ) {
            throw new FeedbackLoopError("Reject body is invalid", "invalid_input");
          }
          record = await feedbackLoop.reject(recommendation.recommendationId, body.reason);
        } else {
          if (
            !body ||
            typeof body !== "object" ||
            Object.keys(body).some((key) => !["version", "fixture_ids"].includes(key))
          ) {
            throw new FeedbackLoopError("Promote body is invalid", "invalid_input");
          }
          record = await feedbackLoop.recordPromotion(
            recommendation.recommendationId,
            body.version,
            body.fixture_ids
          );
        }
        logger.info({
          recommendationId: record.recommendation_id,
          state: record.state,
          status: "recommendation_updated",
        });
        sendJson(response, 200, { ok: true, recommendation: record });
      } catch (error) {
        sendJson(response, feedbackErrorStatus(error), {
          ok: false,
          error:
            error instanceof FeedbackLoopError
              ? error.message
              : "Invalid recommendation request",
        });
      }
      return;
    }

    const headerRequestId = request.headers["idempotency-key"]?.trim();
    const bodyRequestId = typeof body?.request_id === "string" ? body.request_id.trim() : "";
    if (headerRequestId && bodyRequestId && headerRequestId !== bodyRequestId) {
      sendJson(response, 409, { ok: false, error: "Conflicting request IDs" });
      return;
    }
    const requestId =
      headerRequestId ||
      bodyRequestId ||
      (sarvamToolMatch ? sarvamToolRequestId(sarvamToolMatch[1], body) : "");
    if (!requestId) {
      sendJson(response, 400, { ok: false, error: "Request ID required" });
      return;
    }

    if (isFeedbackPost) {
      if (!feedbackLoop) {
        sendJson(response, 503, { ok: false, error: "Feedback service unavailable" });
        return;
      }
      try {
        const result = await feedbackLoop.recordOperatorFeedback({
          ...body,
          request_id: requestId,
        });
        logger.info({
          feedbackId: result.feedback.feedback_id,
          eventId: result.feedback.event_id,
          category: result.feedback.category,
          severity: result.feedback.severity,
          status: "operator_feedback_recorded",
          duplicate: result.duplicate,
        });
        sendJson(response, result.duplicate ? 200 : 201, {
          ok: true,
          feedbackId: result.feedback.feedback_id,
          recommendationId: result.recommendation?.recommendation_id || null,
          duplicate: result.duplicate,
        });
      } catch (error) {
        sendJson(response, feedbackErrorStatus(error), {
          ok: false,
          error:
            error instanceof FeedbackLoopError ? error.message : "Invalid feedback request",
        });
      }
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

    try {
      const result = await deliverMessage(parsed);
      sendJson(response, result.duplicate ? 200 : 202, result);
    } catch {
      logger.error({ requestId, stage: parsed.stage, status: "transport_error" });
      sendJson(response, 503, { ok: false, error: "WhatsApp delivery unavailable" });
    }
  });
}
