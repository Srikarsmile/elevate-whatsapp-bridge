import pino from "pino";

import { createBaileysTransport } from "./baileys-transport.js";
import { createCallbackScheduler } from "./callback-scheduler.js";
import { PersistentCallbackStore } from "./callback-store.js";
import { loadConfig } from "./config.js";
import { createEvaluationQueue } from "./evaluation-queue.js";
import { createEventProcessor } from "./event-processor.js";
import { createFeedbackLoop } from "./feedback-loop.js";
import { PersistentIdempotencyStore } from "./idempotency.js";
import { PersistentRecordStore } from "./persistent-record-store.js";
import { createSarvamAnalyticsClient } from "./sarvam-analytics.js";
import { createSarvamOutboundClient } from "./sarvam-outbound.js";
import { createBridgeServer } from "./server.js";

process.umask(0o077);

const required = ["BRIDGE_SECRET", "IMPLEMENTATION_NOTE", "REPOSITORY_URL"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(`Missing required environment: ${missing.join(", ")}`);
}

const host = process.env.BRIDGE_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.BRIDGE_PORT || "3218", 10);
const stateDir = process.env.BRIDGE_STATE_DIR || "/var/lib/elevate-whatsapp-bridge";
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const config = loadConfig();

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
const callEventStore = await PersistentRecordStore.open({
  filePath: process.env.OUTBOUND_EVENTS_PATH || `${stateDir}/outbound-events.json`,
  idField: "event_id",
  maxRecords: 1000,
});
const evaluationJobStore = await PersistentRecordStore.open({
  filePath: process.env.EVALUATION_JOBS_PATH || `${stateDir}/evaluation-jobs.json`,
  idField: "job_id",
  maxRecords: 1000,
});
const feedbackStore = await PersistentRecordStore.open({
  filePath: process.env.FEEDBACK_PATH || `${stateDir}/feedback.json`,
  idField: "feedback_id",
  maxRecords: 1000,
});
const caseStore = await PersistentRecordStore.open({
  filePath: process.env.EVALUATION_CASES_PATH || `${stateDir}/evaluation-cases.json`,
  idField: "case_id",
  maxRecords: 1000,
});
const recommendationStore = await PersistentRecordStore.open({
  filePath: process.env.RECOMMENDATIONS_PATH || `${stateDir}/recommendations.json`,
  idField: "recommendation_id",
  maxRecords: 1000,
});
const feedbackLoop = createFeedbackLoop({
  eventStore: callEventStore,
  feedbackStore,
  caseStore,
  recommendationStore,
});
const evaluationQueue = createEvaluationQueue({
  store: evaluationJobStore,
  eventStore: callEventStore,
  feedbackLoop,
});
const outboundClient = config.sarvam
  ? createSarvamOutboundClient({ config: config.sarvam })
  : null;
const analyticsClient = config.sarvam
  ? createSarvamAnalyticsClient({ config: config.sarvam })
  : null;
const callbackScheduler = createCallbackScheduler({
  mode: config.callbackDispatchMode,
  store: callbackStore,
  outboundClient,
  outboundEventStore: callEventStore,
  appVersion: config.sarvam?.appVersion || null,
  logger,
});
const eventProcessor = createEventProcessor({
  eventStore: callEventStore,
  evaluationJobStore,
  callbackStore,
  analyticsClient,
  feedbackLoop,
  logger,
});
const server = createBridgeServer({
  secret: process.env.BRIDGE_SECRET,
  transport,
  store,
  callbackStore,
  callEventStore,
  webhookToken: config.webhookToken,
  phoneHashSalt: config.phoneHashSalt,
  feedbackLoop,
  feedbackWorkerToken: config.feedbackWorkerToken,
  evaluationQueue,
  healthStatus: () => ({
    callbackScheduler: callbackScheduler.status(),
    callbackDispatchMode: config.callbackDispatchMode,
    sarvamConfigured: config.sarvamConfigured,
    pendingCallbacks: callbackStore.countPending(),
    pendingEvaluations: evaluationJobStore.count((job) =>
      ["pending", "leased"].includes(job.status)
    ),
  }),
  architectureImagePath:
    process.env.ARCHITECTURE_IMAGE_PATH || `${stateDir}/assets/architecture.png`,
  resumePath:
    process.env.RESUME_PATH || `${stateDir}/assets/Srikar-Reddy-Software-Engineer-CV.pdf`,
  repositoryUrl: process.env.REPOSITORY_URL,
  implementationNote: process.env.IMPLEMENTATION_NOTE,
  logger,
});

await transport.start();
await callbackScheduler.start();
await eventProcessor.start();
server.listen(port, host, () => logger.info({ service: "listening", host, port }));

async function shutdown(signal) {
  logger.info({ service: "stopping", signal });
  await new Promise((resolve) => server.close(resolve));
  await callbackScheduler.stop();
  await eventProcessor.stop();
  await transport.stop();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
