import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCallbackScheduler } from "../src/callback-scheduler.js";
import { PersistentCallbackStore } from "../src/callback-store.js";
import { PersistentRecordStore } from "../src/persistent-record-store.js";
import { SarvamOutboundError } from "../src/sarvam-outbound.js";

const dueAt = new Date("2026-08-23T05:00:00.000Z");

function request(overrides = {}) {
  return {
    request_id: "call-123:callback",
    to: "918639885985",
    callback_time_iso: dueAt.toISOString(),
    callback_time_human: "in five minutes",
    timezone: "Asia/Kolkata",
    prospect_name: "Srikar",
    context_summary: "Requested a five-minute callback",
    confirmed_by_user: true,
    confirmed_at: "2026-08-23T04:55:00.000Z",
    source_interaction_id: "interaction-source-1",
    ...overrides,
  };
}

async function stores() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "elevate-scheduler-"));
  const callbackStore = await PersistentCallbackStore.open({
    filePath: path.join(directory, "callbacks.json"),
    clock: () => new Date("2026-08-23T04:55:00.000Z"),
  });
  const outboundEventStore = await PersistentRecordStore.open({
    filePath: path.join(directory, "events.json"),
    idField: "event_id",
  });
  return { callbackStore, outboundEventStore };
}

function logger() {
  return { info() {}, error() {} };
}

test("disabled mode does not inspect or mutate due callbacks", async () => {
  let queries = 0;
  const scheduler = createCallbackScheduler({
    mode: "disabled",
    store: { listDue: () => (queries += 1) },
    outboundClient: null,
    outboundEventStore: null,
    appVersion: null,
    logger: logger(),
  });

  assert.equal(await scheduler.runOnce(dueAt), 0);
  assert.equal(queries, 0);
  assert.equal(scheduler.status(), "disabled");
});

test("dry-run persists one redacted preview and consumes the booking without a call", async () => {
  const { callbackStore, outboundEventStore } = await stores();
  const { booking } = await callbackStore.book(request());
  let calls = 0;
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
      webhook_config: { metadata: { booking_id: booking.booking_id } },
    }),
    createCall: async () => {
      calls += 1;
      return { attemptId: "attempt-test-1" };
    },
  };
  const scheduler = createCallbackScheduler({
    mode: "dry_run",
    store: callbackStore,
    outboundClient,
    outboundEventStore,
    appVersion: 7,
    logger: logger(),
  });

  assert.equal(await scheduler.runOnce(dueAt), 1);

  const updated = callbackStore.get(booking.booking_id);
  assert.equal(updated.status, "expired");
  assert.equal(updated.history.at(-1).reason, "dry_run_completed_without_call");
  assert.equal(calls, 0);
  assert.equal(outboundEventStore.count(), 1);
  const serialized = JSON.stringify(outboundEventStore.list()[0]);
  assert.match(serialized, /"agent_phone_last4":"1315"/);
  assert.match(serialized, /"user_phone_last4":"5985"/);
  assert.doesNotMatch(serialized, /918071581315|918639885985|five-minute callback/);

  assert.equal(await scheduler.runOnce(new Date("2026-08-23T05:01:00.000Z")), 0);
  assert.equal(outboundEventStore.count(), 1);
});

test("live mode persists dispatching before contacting Sarvam and then records dialing", async () => {
  const { callbackStore, outboundEventStore } = await stores();
  const { booking } = await callbackStore.book(request());
  const outboundClient = {
    createCall: async () => {
      assert.equal(callbackStore.get(booking.booking_id).status, "dispatching");
      return { attemptId: "attempt-test-1" };
    },
  };
  const scheduler = createCallbackScheduler({
    mode: "live",
    store: callbackStore,
    outboundClient,
    outboundEventStore,
    appVersion: 7,
    logger: logger(),
  });

  assert.equal(await scheduler.runOnce(dueAt), 1);
  const updated = callbackStore.get(booking.booking_id);
  assert.equal(updated.status, "dialing");
  assert.equal(updated.attempt_id, "attempt-test-1");
  assert.equal(updated.dispatched_agent_version, 7);
});

test("definitive rejection fails once while uncertain delivery becomes unknown", async () => {
  for (const [kind, expectedStatus, expectedReason] of [
    ["rejected", "failed", "sarvam_rejected"],
    ["unknown", "dispatch_unknown", "sarvam_delivery_uncertain"],
  ]) {
    const { callbackStore, outboundEventStore } = await stores();
    const { booking } = await callbackStore.book(request({ request_id: `call-${kind}:callback` }));
    let calls = 0;
    const scheduler = createCallbackScheduler({
      mode: "live",
      store: callbackStore,
      outboundClient: {
        createCall: async () => {
          calls += 1;
          throw new SarvamOutboundError("provider failure", { kind });
        },
      },
      outboundEventStore,
      appVersion: 7,
      logger: logger(),
    });

    await scheduler.runOnce(dueAt);
    assert.equal(callbackStore.get(booking.booking_id).status, expectedStatus);
    assert.equal(callbackStore.get(booking.booking_id).history.at(-1).reason, expectedReason);
    await scheduler.runOnce(new Date("2026-08-23T05:01:00.000Z"));
    assert.equal(calls, 1);
  }
});

test("coalesces overlapping polls and dispatches due jobs serially", async () => {
  const { callbackStore, outboundEventStore } = await stores();
  await callbackStore.book(request({ request_id: "call-a:callback" }));
  await callbackStore.book(request({ request_id: "call-b:callback" }));
  let active = 0;
  let maxActive = 0;
  let releases = [];
  let started = 0;
  let firstStartedResolve;
  let secondStartedResolve;
  const firstStarted = new Promise((resolve) => {
    firstStartedResolve = resolve;
  });
  const secondStarted = new Promise((resolve) => {
    secondStartedResolve = resolve;
  });
  const outboundClient = {
    createCall: async () => {
      active += 1;
      started += 1;
      maxActive = Math.max(maxActive, active);
      if (started === 1) firstStartedResolve();
      if (started === 2) secondStartedResolve();
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return { attemptId: `attempt-${started}` };
    },
  };
  const scheduler = createCallbackScheduler({
    mode: "live",
    store: callbackStore,
    outboundClient,
    outboundEventStore,
    appVersion: 7,
    logger: logger(),
  });

  const first = scheduler.runOnce(dueAt);
  const overlapping = scheduler.runOnce(dueAt);
  await firstStarted;
  assert.equal(releases.length, 1);
  releases[0]();
  await secondStarted;
  assert.equal(releases.length, 2);
  releases[1]();
  assert.equal(await first, 2);
  assert.equal(await overlapping, 2);
  assert.equal(maxActive, 1);
});

test("starts after recovery and stops its timer cleanly", async () => {
  const calls = [];
  let scheduled;
  const scheduler = createCallbackScheduler({
    mode: "dry_run",
    store: {
      recover: async () => calls.push("recover"),
      listDue: () => [],
    },
    outboundClient: { preview() {} },
    outboundEventStore: { put: async () => {} },
    appVersion: 7,
    setIntervalImpl: (callback, intervalMs) => {
      scheduled = callback;
      calls.push(`interval:${intervalMs}`);
      return 42;
    },
    clearIntervalImpl: (timer) => calls.push(`clear:${timer}`),
    logger: logger(),
  });

  await scheduler.start(dueAt);
  assert.equal(scheduler.status(), "running");
  await scheduled();
  await scheduler.stop();

  assert.deepEqual(calls, ["recover", "interval:1000", "recover", "clear:42"]);
  assert.equal(scheduler.status(), "stopped");
});

test("recovers stale provider outcomes during normal polling", async () => {
  const recoveredAt = [];
  const scheduler = createCallbackScheduler({
    mode: "live",
    store: {
      async recover(now) {
        recoveredAt.push(now.toISOString());
      },
      listDue: () => [],
    },
    outboundClient: {},
    outboundEventStore: {},
    appVersion: "1",
    logger: logger(),
  });

  const now = new Date("2026-08-23T05:10:01.001Z");
  assert.equal(await scheduler.runOnce(now), 0);
  assert.deepEqual(recoveredAt, [now.toISOString()]);
});
