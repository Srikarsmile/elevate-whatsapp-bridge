import assert from "node:assert/strict";
import test from "node:test";

import { createBridgeServer } from "../src/server.js";

const secret = "test-bridge-secret-with-enough-entropy";
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

function createMemoryCallbackStore() {
  const byId = new Map();
  const byRequestId = new Map();
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
  };
}

function baseOptions(overrides = {}) {
  const calls = [];
  const logs = [];
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
    callbackStore: createMemoryCallbackStore(),
    architectureImagePath: "/private/architecture.png",
    logger: { info: (entry) => logs.push(entry), error: (entry) => logs.push(entry) },
    calls,
    logs,
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

test("health reports transport state without authentication", async () => {
  const options = baseOptions();
  await withServer(options, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, whatsapp: "connected" });
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
