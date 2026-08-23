import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCallbackScheduler } from "../../src/callback-scheduler.js";
import { PersistentCallbackStore } from "../../src/callback-store.js";
import { parseCallbackRequest } from "../../src/callback.js";
import { createEvaluationQueue } from "../../src/evaluation-queue.js";
import { createEventProcessor } from "../../src/event-processor.js";
import { createFeedbackLoop } from "../../src/feedback-loop.js";
import { PersistentIdempotencyStore } from "../../src/idempotency.js";
import { PersistentRecordStore } from "../../src/persistent-record-store.js";
import { createSarvamOutboundClient } from "../../src/sarvam-outbound.js";
import { createBridgeServer } from "../../src/server.js";

const bridgeSecret = "integration-bridge-secret-with-enough-entropy";
const webhookToken = "integration-webhook-token-with-enough-entropy";
const workerToken = "integration-worker-token-with-enough-entropy";
const phoneHashSalt = "integration-phone-hash-salt-with-enough-entropy";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

function logger() {
  return { info() {}, error() {} };
}

async function openStores(directory) {
  const callbackStore = await PersistentCallbackStore.open({
    filePath: path.join(directory, "callbacks.json"),
  });
  const eventStore = await PersistentRecordStore.open({
    filePath: path.join(directory, "outbound-events.json"),
    idField: "event_id",
  });
  const evaluationJobStore = await PersistentRecordStore.open({
    filePath: path.join(directory, "evaluation-jobs.json"),
    idField: "job_id",
  });
  const feedbackStore = await PersistentRecordStore.open({
    filePath: path.join(directory, "feedback.json"),
    idField: "feedback_id",
  });
  const caseStore = await PersistentRecordStore.open({
    filePath: path.join(directory, "evaluation-cases.json"),
    idField: "case_id",
  });
  const recommendationStore = await PersistentRecordStore.open({
    filePath: path.join(directory, "recommendations.json"),
    idField: "recommendation_id",
  });
  return {
    callbackStore,
    eventStore,
    evaluationJobStore,
    feedbackStore,
    caseStore,
    recommendationStore,
  };
}

function sarvamConfig(webhookBaseUrl) {
  return {
    apiKey: "fake-sarvam-key",
    orgId: "org-test",
    workspaceId: "workspace-test",
    appId: "app-test",
    appVersion: 7,
    connectionId: "connection-test",
    agentPhoneNumber: "918071581315",
    webhookBaseUrl,
    webhookToken,
  };
}

const hermesResult = {
  scores: {
    listening: 94,
    concision: 92,
    naturalness: 90,
    intent_accuracy: 93,
    task_completion: 95,
  },
  evidence: [],
  failures: [],
  prompt_delta: "",
  confidence: 0.91,
  insufficient_evidence: false,
};

test("confirmed callback completes once through fake Sarvam and survives restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "elevate-lifecycle-"));
  const outboundRequests = [];
  const fakeSarvam = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    outboundRequests.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ attempt_id: "attempt-test-1" }));
  });
  const fakeSarvamUrl = await listen(fakeSarvam);
  const stores = await openStores(directory);
  const idempotencyStore = await PersistentIdempotencyStore.open({
    filePath: path.join(directory, "idempotency.json"),
  });
  const feedbackLoop = createFeedbackLoop({
    eventStore: stores.eventStore,
    feedbackStore: stores.feedbackStore,
    caseStore: stores.caseStore,
    recommendationStore: stores.recommendationStore,
  });
  const evaluationQueue = createEvaluationQueue({
    store: stores.evaluationJobStore,
    eventStore: stores.eventStore,
    randomToken: () => "integration-lease-token-with-enough-entropy",
  });
  const transport = { status: () => "connected", send: async () => ({}) };
  const bridge = createBridgeServer({
    secret: bridgeSecret,
    transport,
    store: idempotencyStore,
    callbackStore: stores.callbackStore,
    callEventStore: stores.eventStore,
    webhookToken,
    phoneHashSalt,
    feedbackLoop,
    feedbackWorkerToken: workerToken,
    evaluationQueue,
    logger: logger(),
  });
  const bridgeUrl = await listen(bridge);

  try {
    const bookedAt = new Date();
    const dueAt = new Date(bookedAt.getTime() + 5 * 60 * 1000);
    const bookingResponse = await fetch(`${bridgeUrl}/v1/callbacks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridgeSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        request_id: "integration-call:callback",
        to: "918639885985",
        callback_time_iso: dueAt.toISOString(),
        callback_time_human: "in five minutes",
        timezone: "Asia/Kolkata",
        prospect_name: "Fictional catalogue owner",
        context_summary: "Requested a callback about a fictional catalogue.",
        confirmed_by_user: true,
        confirmed_at: bookedAt.toISOString(),
        source_interaction_id: "source-interaction-1",
      }),
    });
    assert.equal(bookingResponse.status, 201);
    const bookingId = (await bookingResponse.json()).bookingId;

    const outboundClient = createSarvamOutboundClient({
      config: sarvamConfig(bridgeUrl),
      baseUrl: fakeSarvamUrl,
    });
    const scheduler = createCallbackScheduler({
      mode: "live",
      store: stores.callbackStore,
      outboundClient,
      outboundEventStore: stores.eventStore,
      appVersion: 7,
      clock: () => dueAt,
      logger: logger(),
    });
    assert.equal(await scheduler.runOnce(dueAt), 1);
    assert.equal(outboundRequests.length, 1);
    assert.equal(outboundRequests[0].body.app_config.app_version, 7);
    assert.equal(outboundRequests[0].body.user_config.user_phone_number, "+918639885985");
    assert.equal(stores.callbackStore.get(bookingId).status, "dialing");

    const webhookResponse = await fetch(
      `${bridgeUrl}/v1/sarvam/outbound-events/${webhookToken}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attempt_id: "attempt-test-1",
          status: "connected",
          channel_info: {
            channel_type: "v2v",
            channel_provider: "fake-vobiz",
            agent_phone_number: "+918071581315",
          },
          duration: 42,
          interaction_id: "20260823/integration-interaction-1",
          failure_reason: null,
          final_agent_variables: {
            business: "fictional retail",
            products: "catalogue",
            features: "checkout",
            budget: "unknown",
            timeline: "month",
            decision_maker: "owner",
            intent: "warm",
          },
          webhook_config: {
            url: `${bridgeUrl}/v1/sarvam/outbound-events/${webhookToken}`,
            metadata: {
              booking_id: bookingId,
              request_id: "integration-call:callback",
            },
          },
          interaction_transcript: [
            { role: "agent", en_text: "What should the fictional site improve?" },
            { role: "user", en_text: "The catalogue and checkout." },
          ],
        }),
      }
    );
    assert.equal(webhookResponse.status, 200);
    assert.equal(stores.callbackStore.get(bookingId).status, "connected");
    assert.equal(stores.eventStore.count(), 1);

    const processor = createEventProcessor({
      eventStore: stores.eventStore,
      evaluationJobStore: stores.evaluationJobStore,
      callbackStore: stores.callbackStore,
      feedbackLoop,
      logger: logger(),
    });
    assert.equal(await processor.runOnce(), 1);
    const event = stores.eventStore.list()[0];
    assert.equal(event.deterministic_evaluation.score, 100);
    assert.equal(stores.evaluationJobStore.count(), 1);

    const claimed = await evaluationQueue.claim();
    await evaluationQueue.complete({
      jobId: claimed.job_id,
      leaseToken: claimed.lease_token,
      result: hermesResult,
    });
    assert.deepEqual(stores.eventStore.get(event.event_id).hermes_evaluation, hermesResult);

    const reopened = await openStores(directory);
    const restartedScheduler = createCallbackScheduler({
      mode: "live",
      store: reopened.callbackStore,
      outboundClient,
      outboundEventStore: reopened.eventStore,
      appVersion: 7,
      logger: logger(),
    });
    await restartedScheduler.start(new Date(dueAt.getTime() + 60_000));
    await restartedScheduler.runOnce(new Date(dueAt.getTime() + 60_000));
    await restartedScheduler.stop();
    assert.equal(outboundRequests.length, 1);
    assert.equal(reopened.callbackStore.get(bookingId).status, "connected");
    assert.equal(reopened.eventStore.count(), 1);
  } finally {
    await close(bridge);
    await close(fakeSarvam);
  }
});

test("disabled, dry-run, disallowed, and interrupted states make zero outbound requests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "elevate-no-call-"));
  const stores = await openStores(directory);
  const dueAt = new Date(Date.now() + 60_000);
  const request = (id, to = "918639885985") => ({
    request_id: id,
    to,
    callback_time_iso: dueAt.toISOString(),
    callback_time_human: "in one minute",
    timezone: "Asia/Kolkata",
    prospect_name: "Fictional owner",
    context_summary: "A fictional no-call boundary test.",
    confirmed_by_user: true,
    confirmed_at: new Date().toISOString(),
    source_interaction_id: null,
  });
  const { booking: disabledBooking } = await stores.callbackStore.book(
    request("integration-disabled:callback")
  );
  let outboundCalls = 0;
  const outboundClient = {
    preview: () => ({
      app_config: {
        app_id: "app-test",
        app_version: 7,
        connection_config: {
          connection_id: "connection-test",
          agent_phone_number: "+918071581315",
        },
      },
      user_config: { user_phone_number: "+918639885985" },
    }),
    createCall: async () => {
      outboundCalls += 1;
      return { attemptId: "must-not-exist" };
    },
  };
  const disabled = createCallbackScheduler({
    mode: "disabled",
    store: stores.callbackStore,
    outboundClient,
    outboundEventStore: stores.eventStore,
    appVersion: 7,
    logger: logger(),
  });
  assert.equal(await disabled.runOnce(dueAt), 0);
  assert.equal(stores.callbackStore.get(disabledBooking.booking_id).status, "scheduled");

  const dryRun = createCallbackScheduler({
    mode: "dry_run",
    store: stores.callbackStore,
    outboundClient,
    outboundEventStore: stores.eventStore,
    appVersion: 7,
    logger: logger(),
  });
  assert.equal(await dryRun.runOnce(dueAt), 1);
  assert.equal(stores.callbackStore.get(disabledBooking.booking_id).status, "expired");
  assert.equal(outboundCalls, 0);

  const { booking: interrupted } = await stores.callbackStore.book(
    request("integration-interrupted:callback")
  );
  await stores.callbackStore.transition(interrupted.booking_id, "dispatching", {
    at: dueAt.toISOString(),
    reason: "callback_due",
  });
  const reopened = await openStores(directory);
  await reopened.callbackStore.recover(new Date(dueAt.getTime() + 1000));
  assert.equal(reopened.callbackStore.get(interrupted.booking_id).status, "dispatch_unknown");
  assert.equal(outboundCalls, 0);

  assert.throws(
    () =>
      parseCallbackRequest(
        request("integration-disallowed:callback", "919999999999"),
        new Date()
      ),
    /allowlist/
  );
  assert.equal(outboundCalls, 0);
});
