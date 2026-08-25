import assert from "node:assert/strict";
import test from "node:test";

import { createBaileysTransport } from "../src/baileys-transport.js";

function createHarness(overrides = {}) {
  const listeners = new Map();
  const sent = [];
  const logs = [];
  const qrWrites = [];
  const deleted = [];
  const signalLogs = [];
  const signalConsole = {
    info: (...entries) => signalLogs.push(entries),
  };
  let reconnect;
  const socket = {
    ev: {
      on(name, listener) {
        listeners.set(name, listener);
      },
    },
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `message-${sent.length}` } };
    },
    end: () => {},
  };
  const transport = createBaileysTransport({
    authDir: "/private/auth",
    qrPath: "/private/qr.png",
    socketFactory: async () => socket,
    authStateFactory: async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: async () => {},
    }),
    versionFactory: async () => ({ version: [2, 3000, 1] }),
    qrWriter: async (filePath, qr) => qrWrites.push({ filePath, qr }),
    removeFile: async (filePath) => deleted.push(filePath),
    scheduleReconnect: (callback) => {
      reconnect = callback;
      return 1;
    },
    cancelReconnect: () => {},
    logger: {
      info: (entry) => logs.push(entry),
      error: (entry) => logs.push(entry),
    },
    signalConsole,
    ...overrides,
  });
  return {
    transport,
    listeners,
    sent,
    logs,
    qrWrites,
    deleted,
    signalConsole,
    signalLogs,
    triggerReconnect: () => reconnect?.(),
  };
}

test("suppresses libsignal session dumps while preserving normal console info", () => {
  const harness = createHarness();

  harness.signalConsole.info("Closing session:", { privateKey: "secret-key-material" });
  harness.signalConsole.info("safe status", { connected: true });

  assert.deepEqual(harness.signalLogs, [["safe status", { connected: true }]]);
});

test("writes a private QR image without logging QR contents", async () => {
  const harness = createHarness();
  await harness.transport.start();

  await harness.listeners.get("connection.update")({ qr: "secret-qr-data" });

  assert.deepEqual(harness.qrWrites, [
    { filePath: "/private/qr.png", qr: "secret-qr-data" },
  ]);
  assert.equal(harness.transport.status(), "linking");
  assert.doesNotMatch(JSON.stringify(harness.logs), /secret-qr-data/);
});

test("marks the transport connected and removes the QR file", async () => {
  const harness = createHarness();
  await harness.transport.start();

  await harness.listeners.get("connection.update")({ connection: "open" });

  assert.equal(harness.transport.status(), "connected");
  assert.deepEqual(harness.deleted, ["/private/qr.png"]);
});

test("sends text, architecture image, and resume document in order", async () => {
  const harness = createHarness();
  await harness.transport.start();
  await harness.listeners.get("connection.update")({ connection: "open" });

  const result = await harness.transport.send({
    to: "918688664337",
    text: "Contextual follow-up",
    attachments: [
      {
        path: "/private/architecture.png",
        kind: "image",
        fileName: "elevatebox-architecture.png",
        mimetype: "image/png",
      },
      {
        path: "/private/resume.pdf",
        kind: "document",
        fileName: "Srikar-Reddy-Software-Engineer-CV.pdf",
        mimetype: "application/pdf",
      },
    ],
  });

  assert.deepEqual(harness.sent, [
    {
      jid: "918688664337@s.whatsapp.net",
      content: { text: "Contextual follow-up" },
    },
    {
      jid: "918688664337@s.whatsapp.net",
      content: {
        image: { url: "/private/architecture.png" },
        caption: "How the voice-to-WhatsApp prototype works",
      },
    },
    {
      jid: "918688664337@s.whatsapp.net",
      content: {
        document: { url: "/private/resume.pdf" },
        fileName: "Srikar-Reddy-Software-Engineer-CV.pdf",
        mimetype: "application/pdf",
      },
    },
  ]);
  assert.deepEqual(result, {
    messageIds: ["message-1", "message-2", "message-3"],
  });
});

test("sends to the controlled test recipient", async () => {
  const harness = createHarness();
  await harness.transport.start();
  await harness.listeners.get("connection.update")({ connection: "open" });

  await harness.transport.send({
    to: "918639885985",
    text: "Controlled test",
    attachments: [],
  });

  assert.deepEqual(harness.sent, [
    {
      jid: "918639885985@s.whatsapp.net",
      content: { text: "Controlled test" },
    },
  ]);
});

test("stops reconnecting after WhatsApp reports a logged-out session", async () => {
  let reconnects = 0;
  const harness = createHarness({
    scheduleReconnect: () => {
      reconnects += 1;
      return 1;
    },
  });
  await harness.transport.start();

  await harness.listeners.get("connection.update")({
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });

  assert.equal(harness.transport.status(), "logged_out");
  assert.equal(reconnects, 0);
});

test("schedules one reconnect after a transient disconnect", async () => {
  let reconnects = 0;
  const harness = createHarness({
    scheduleReconnect: () => {
      reconnects += 1;
      return 1;
    },
  });
  await harness.transport.start();

  await harness.listeners.get("connection.update")({
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 503 } } },
  });

  assert.equal(harness.transport.status(), "disconnected");
  assert.equal(reconnects, 1);
});

test("rejects sends while disconnected", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.transport.send({ to: "918688664337", text: "hello", attachments: [] }),
    /disconnected/
  );
});
