import assert from "node:assert/strict";
import test from "node:test";

import { createBridgeServer } from "../src/server.js";

const secret = "test-bridge-secret-with-enough-entropy";
const webhookToken = "test-webhook-token-with-enough-entropy";
const phoneHashSalt = "test-phone-hash-salt-with-enough-entropy";
const validBody = {
  request_id: "call-123:mid-call",
  to: "918688664337",
  stage: "mid_call",
  classification: "Hot",
  business: "books",
};

function createMemoryStore() {
  const values = new Map();
  return {
    get: (key) => values.get(key),
    put: async (key, value) => values.set(key, value),
  };
}

async function withServer(options, callback) {
  const server = createBridgeServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

async function post(baseUrl, body, options = {}) {
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.secret ?? secret}`,
      "content-type": "application/json",
      ...(options.idempotencyKey
        ? { "idempotency-key": options.idempotencyKey }
        : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function postCallback(baseUrl, body, options = {}) {
  return fetch(`${baseUrl}/v1/callbacks`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.secret ?? secret}`,
      "content-type": "application/json",
      ...(options.idempotencyKey
        ? { "idempotency-key": options.idempotencyKey }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

async function postWebhook(baseUrl, route, body, token = webhookToken) {
  return fetch(`${baseUrl}/v1/sarvam/${route}/${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function createMemoryCallbackStore() {
  const byId = new Map();
  const byRequestId = new Map();
  const transitions = [];
  return {
    async book(request) {
      const existingId = byRequestId.get(request.request_id);
      if (existingId) return { booking: byId.get(existingId), duplicate: true };
      const booking = {
        booking_id: `cb-${String(byId.size + 1).padStart(16, "0")}`,
        ...request,
        status: "scheduled",
      };
      byId.set(booking.booking_id, booking);
      byRequestId.set(request.request_id, booking.booking_id);
      return { booking, duplicate: false };
    },
    get(id) {
      return byId.get(id);
    },
    async transition(id, status, { at, reason, metadata = {} }) {
      const current = byId.get(id);
      if (!current) throw new Error("Callback not found");
      const next = { ...current, ...metadata, status, updated_at: at };
      byId.set(id, next);
      transitions.push({ id, status, reason });
      return next;
    },
    countPending() {
      return [...byId.values()].filter((booking) =>
        ["scheduled", "dispatching", "dialing"].includes(booking.status)
      ).length;
    },
    transitions,
  };
}

function createMemoryCallEventStore(operationOrder = []) {
  const values = new Map();
  return {
    get: (id) => values.get(id),
    list: (predicate = () => true) => [...values.values()].filter(predicate),
    count: (predicate = () => true) => [...values.values()].filter(predicate).length,
    async put(value) {
      const existing = values.get(value.event_id);
      if (existing) return { record: existing, duplicate: true };
      operationOrder.push(`persist:${value.status}`);
      values.set(value.event_id, value);
      return { record: value, duplicate: false };
    },
  };
}

function baseOptions(overrides = {}) {
  const calls = [];
  const logs = [];
  const operationOrder = [];
  const callbackStore = createMemoryCallbackStore();
  const originalTransition = callbackStore.transition;
  callbackStore.transition = async (...args) => {
    operationOrder.push(`transition:${args[1]}`);
    return originalTransition(...args);
  };
  const callEventStore = createMemoryCallEventStore(operationOrder);
  const transport = {
    status: () => "connected",
    send: async (message) => {
      calls.push(message);
      return { messageId: "wamid.1" };
    },
  };
  return {
    secret,
    transport,
    store: createMemoryStore(),
    callbackStore,
    callEventStore,
    webhookToken,
    phoneHashSalt,
    healthStatus: () => ({
      callbackScheduler: "disabled",
      callbackDispatchMode: "disabled",
      sarvamConfigured: true,
      pendingCallbacks: callbackStore.countPending(),
      pendingEvaluations: callEventStore.count(
        (event) => event.evaluation_status === "pending"
      ),
    }),
    architectureImagePath: "/private/architecture.png",
    logger: { info: (entry) => logs.push(entry), error: (entry) => logs.push(entry) },
    calls,
    logs,
    operationOrder,
    ...overrides,
  };
}

const callbackTimeIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const confirmedAtIso = new Date(Date.now() - 1000).toISOString();
const validCallback = {
  request_id: "call-123:callback",
  to: "918688664337",
  callback_time_iso: callbackTimeIso,
  callback_time_human: "in one hour",
  timezone: "Asia/Kolkata",
  prospect_name: "ElevateBox hiring team",
  context_summary: "Requested a callback after discussing an online store.",
  confirmed_by_user: true,
  confirmed_at: confirmedAtIso,
  source_interaction_id: "interaction-123",
};

function outboundEvent(bookingId, overrides = {}) {
  return {
    attempt_id: "attempt-123",
    status: "connected",
    channel_info: {
      channel_type: "v2v",
      channel_provider: "vobiz",
      agent_phone_number: "+918071581315",
    },
    duration: 42,
    interaction_id: "20260823/interaction-123",
    failure_reason: null,
    final_agent_variables: { intent_level: "Hot" },
    webhook_config: {
      url: `https://example.test/v1/sarvam/outbound-events/${webhookToken}`,
      metadata: { booking_id: bookingId, request_id: validCallback.request_id },
    },
    interaction_transcript: [
      { role: "agent", en_text: "Hello, is now a good time?" },
      { role: "user", en_text: "Yes, go ahead." },
    ],
    ...overrides,
  };
}

function onEndEvent(overrides = {}) {
  return {
    interaction_id: "20260823/on-end-123",
    app_id: "app-test",
    app_version: 7,
    status: "connected",
    duration: 57,
    user_phone_number: "+918639885985",
    final_agent_variables: { intent_level: "Warm" },
    interaction_transcript: [
      { role: "agent", en_text: "What would you like to improve?" },
      { role: "user", en_text: "I need a faster website." },
    ],
    tool_results: [],
    ...overrides,
  };
}

test("health reports transport state without authentication", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      whatsapp: "connected",
      callbackScheduler: "disabled",
      callbackDispatchMode: "disabled",
      sarvamConfigured: true,
      pendingCallbacks: 0,
      pendingEvaluations: 0,
    });
  });
});

test("rejects missing and incorrect bearer credentials", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/v1/messages`, { method: "POST" });
    assert.equal(missing.status, 401);
    const incorrect = await post(baseUrl, validBody, { secret: "wrong-secret" });
    assert.equal(incorrect.status, 401);
    assert.equal(options.calls.length, 0);
  });
});

test("accepts a body request ID and sends a formatted message once", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    const response = await post(baseUrl, validBody);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      requestId: "call-123:mid-call",
      duplicate: false,
    });
    assert.equal(options.calls.length, 1);
    assert.equal(options.calls[0].to, "918688664337");
    assert.match(options.calls[0].text, /Business: books/);
  });
});

test("suppresses duplicate sends and returns the original result", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    const first = await post(baseUrl, validBody);
    const second = await post(baseUrl, validBody);
    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), {
      ok: true,
      requestId: "call-123:mid-call",
      duplicate: true,
    });
    assert.equal(options.calls.length, 1);
  });
});

test("rejects conflicting header and body request IDs", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    const response = await post(baseUrl, validBody, {
      idempotencyKey: "call-999:mid-call",
    });
    assert.equal(response.status, 409);
    assert.equal(options.calls.length, 0);
  });
});

test("rejects oversized payloads before transport delivery", async () => {
  const options = baseOptions({ bodyLimitBytes: 256 });
  await withServer(options, async (baseUrl) => {
    const response = await post(baseUrl, "x".repeat(300));
    assert.equal(response.status, 413);
    assert.equal(options.calls.length, 0);
  });
});

test("rate limits authenticated message requests", async () => {
  const options = baseOptions({ rateLimit: { max: 1, windowMs: 60_000 } });
  await withServer(options, async (baseUrl) => {
    const first = await post(baseUrl, validBody);
    const second = await post(baseUrl, {
      ...validBody,
      request_id: "call-124:mid-call",
    });
    assert.equal(first.status, 202);
    assert.equal(second.status, 429);
    assert.equal(options.calls.length, 1);
  });
});

test("returns 503 when WhatsApp transport is disconnected", async () => {
  const options = baseOptions({
    transport: {
      status: () => "disconnected",
      send: async () => {
        throw new Error("WhatsApp transport is disconnected");
      },
    },
  });
  await withServer(options, async (baseUrl) => {
    const response = await post(baseUrl, validBody);
    assert.equal(response.status, 503);
  });
});

test("logs delivery metadata without message or secret content", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    await post(baseUrl, validBody);
    const serialized = JSON.stringify(options.logs);
    assert.match(serialized, /call-123:mid-call/);
    assert.doesNotMatch(serialized, /books/);
    assert.doesNotMatch(serialized, new RegExp(secret));
  });
});

test("books and returns a redacted callback status", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    const booked = await postCallback(baseUrl, validCallback);
    assert.equal(booked.status, 201);
    assert.deepEqual(await booked.json(), {
      ok: true,
      bookingId: "cb-0000000000000001",
      status: "scheduled",
      duplicate: false,
    });

    const status = await fetch(`${baseUrl}/v1/callbacks/cb-0000000000000001`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.deepEqual(body, {
      ok: true,
      bookingId: "cb-0000000000000001",
      status: "scheduled",
      callbackTimeIso,
      callbackTimeHuman: "in one hour",
    });
    assert.doesNotMatch(JSON.stringify(body), /online store/);
  });
});

test("suppresses a duplicate callback booking", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    const first = await postCallback(baseUrl, validCallback);
    const duplicate = await postCallback(baseUrl, validCallback);
    assert.equal(first.status, 201);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), {
      ok: true,
      bookingId: "cb-0000000000000001",
      status: "scheduled",
      duplicate: true,
    });
  });
});

test("rejects unauthorized callback booking and status lookup", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    const booking = await postCallback(baseUrl, validCallback, { secret: "wrong" });
    assert.equal(booking.status, 401);

    const status = await fetch(`${baseUrl}/v1/callbacks/cb-0000000000000001`);
    assert.equal(status.status, 401);
  });
});

test("rejects an invalid or past callback time", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    const response = await postCallback(baseUrl, {
      ...validCallback,
      callback_time_iso: "2020-01-01T10:30:00+05:30",
    });
    assert.equal(response.status, 400);
  });
});

test("returns not found for an unknown callback booking", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/callbacks/cb-ffffffffffffffff`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(response.status, 404);
  });
});

test("accepts a correlated Sarvam outbound event and persists it before callback state", async () => {
  const options = baseOptions();
  const { booking } = await options.callbackStore.book(validCallback);
  await options.callbackStore.transition(booking.booking_id, "dispatching", {
    at: new Date().toISOString(),
    reason: "scheduler_claimed",
  });
  options.operationOrder.length = 0;

  await withServer(options, async (baseUrl) => {
    const response = await postWebhook(
      baseUrl,
      "outbound-events",
      outboundEvent(booking.booking_id)
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, duplicate: false });
  });

  const current = options.callbackStore.get(booking.booking_id);
  assert.equal(current.status, "connected");
  assert.equal(current.attempt_id, "attempt-123");
  assert.equal(current.interaction_id, "20260823/interaction-123");
  assert.deepEqual(options.operationOrder, [
    "persist:connected",
    "transition:dialing",
    "transition:connected",
  ]);
  const event = options.callEventStore.list()[0];
  assert.equal(event.phone_last4, "4337");
  assert.doesNotMatch(JSON.stringify(event), /918688664337|test-webhook-token/);
});

test("maps Sarvam non-connected outcomes onto callback state", async () => {
  for (const status of ["no_answer", "busy", "failed"]) {
    const options = baseOptions();
    const request = { ...validCallback, request_id: `call-${status}:callback` };
    const { booking } = await options.callbackStore.book(request);
    await options.callbackStore.transition(booking.booking_id, "dispatching", {
      at: new Date().toISOString(),
      reason: "scheduler_claimed",
    });
    await options.callbackStore.transition(booking.booking_id, "dialing", {
      at: new Date().toISOString(),
      reason: "sarvam_accepted",
      metadata: { attempt_id: `attempt-${status}` },
    });
    await withServer(options, async (baseUrl) => {
      const response = await postWebhook(
        baseUrl,
        "outbound-events",
        outboundEvent(booking.booking_id, {
          attempt_id: `attempt-${status}`,
          status,
          interaction_id: null,
          duration: null,
          failure_reason: status === "failed" ? "provider rejected call" : null,
          interaction_transcript: null,
        })
      );
      assert.equal(response.status, 200);
    });
    assert.equal(options.callbackStore.get(booking.booking_id).status, status);
  }
});

test("hides webhook endpoints behind their path token", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    const wrong = await postWebhook(baseUrl, "on-end", onEndEvent(), "wrong-token");
    assert.equal(wrong.status, 404);
    const missing = await fetch(`${baseUrl}/v1/sarvam/on-end`, { method: "POST" });
    assert.equal(missing.status, 404);
  });
  assert.equal(options.callEventStore.list().length, 0);
});

test("stores a valid on-end event without changing callback state", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    const first = await postWebhook(baseUrl, "on-end", onEndEvent());
    const duplicate = await postWebhook(baseUrl, "on-end", onEndEvent());
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, duplicate: false });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { ok: true, duplicate: true });
  });
  assert.equal(options.callEventStore.list().length, 1);
  assert.equal(options.callbackStore.transitions.length, 0);
});

test("rejects malformed, oversized, unknown, and uncorrelated webhook payloads", async () => {
  const options = baseOptions({ webhookBodyLimitBytes: 2048 });
  await withServer(options, async (baseUrl) => {
    assert.equal((await postWebhook(baseUrl, "on-end", "not-json")).status, 400);
    assert.equal(
      (await postWebhook(baseUrl, "on-end", `{"padding":"${"x".repeat(2200)}"}`))
        .status,
      413
    );
    assert.equal((await postWebhook(baseUrl, "on-end", { unexpected: true })).status, 400);
    assert.equal(
      (
        await postWebhook(
          baseUrl,
          "outbound-events",
          outboundEvent("cb-ffffffffffffffff")
        )
      ).status,
      404
    );
  });
  assert.equal(options.callEventStore.list().length, 0);
});

test("webhook logs omit tokens, transcripts, and full phone numbers", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    assert.equal((await postWebhook(baseUrl, "on-end", onEndEvent())).status, 200);
  });
  const serialized = JSON.stringify(options.logs);
  assert.doesNotMatch(serialized, new RegExp(webhookToken));
  assert.doesNotMatch(serialized, /faster website|918639885985/);
  assert.match(serialized, /20260823\/on-end-123/);
});
