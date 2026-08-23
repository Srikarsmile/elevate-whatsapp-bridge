import pino from "pino";

import { createBaileysTransport } from "./baileys-transport.js";
import { PersistentCallbackStore } from "./callback-store.js";
import { PersistentIdempotencyStore } from "./idempotency.js";
import { createBridgeServer } from "./server.js";

process.umask(0o077);

const required = ["BRIDGE_SECRET", "RESUME_PATH", "IMPLEMENTATION_NOTE"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(`Missing required environment: ${missing.join(", ")}`);
}

const host = process.env.BRIDGE_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.BRIDGE_PORT || "3218", 10);
const stateDir = process.env.BRIDGE_STATE_DIR || "/var/lib/elevate-whatsapp-bridge";
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const transport = createBaileysTransport({
  authDir: process.env.WHATSAPP_AUTH_DIR || `${stateDir}/auth`,
  qrPath: process.env.WHATSAPP_QR_PATH || `${stateDir}/qr.png`,
  logger,
});
const store = await PersistentIdempotencyStore.open({
  filePath: process.env.IDEMPOTENCY_PATH || `${stateDir}/idempotency.json`,
  maxRecords: 1000,
});
const callbackStore = await PersistentCallbackStore.open({
  filePath: process.env.CALLBACKS_PATH || `${stateDir}/callbacks.json`,
  maxRecords: 1000,
});
const server = createBridgeServer({
  secret: process.env.BRIDGE_SECRET,
  transport,
  store,
  callbackStore,
  architectureImagePath:
    process.env.ARCHITECTURE_IMAGE_PATH || `${stateDir}/assets/architecture.png`,
  resumePath: process.env.RESUME_PATH,
  implementationNote: process.env.IMPLEMENTATION_NOTE,
  logger,
});

await transport.start();
server.listen(port, host, () => logger.info({ service: "listening", host, port }));

async function shutdown(signal) {
  logger.info({ service: "stopping", signal });
  await new Promise((resolve) => server.close(resolve));
  await transport.stop();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
