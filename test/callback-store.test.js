import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PersistentCallbackStore } from "../src/callback-store.js";

function request(overrides = {}) {
  return {
    request_id: "call-123:callback",
    to: "918688664337",
    callback_time_iso: "2026-08-23T10:30:00+05:30",
    callback_time_human: "tomorrow morning at ten thirty",
    timezone: "Asia/Kolkata",
    prospect_name: "ElevateBox hiring team",
    context_summary: "Requested a callback after discussing an online store.",
    confirmed_by_user: true,
    confirmed_at: "2026-08-23T04:59:00.000Z",
    source_interaction_id: "interaction-source-1",
    ...overrides,
  };
}

async function storeAt(maxRecords = 1000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "elevate-callbacks-"));
  const filePath = path.join(directory, "callbacks.json");
  return {
    filePath,
    store: await PersistentCallbackStore.open({ filePath, maxRecords }),
  };
}

test("persists a stable scheduled booking across store instances", async () => {
  const { filePath, store } = await storeAt();
  const first = await store.book(request());

  assert.equal(first.duplicate, false);
  assert.match(first.booking.booking_id, /^cb-[a-f0-9]{16}$/);
  assert.equal(first.booking.status, "scheduled");
  assert.deepEqual(first.booking.history, [
    {
      status: "scheduled",
      at: first.booking.created_at,
      reason: "callback_confirmed",
    },
  ]);

  const reopened = await PersistentCallbackStore.open({ filePath, maxRecords: 1000 });
  assert.deepEqual(reopened.get(first.booking.booking_id), first.booking);
});

test("persists transitions and indexes attempt and interaction IDs", async () => {
  const { filePath, store } = await storeAt();
  const { booking } = await store.book(request());
  await store.transition(booking.booking_id, "dispatching", {
    at: "2026-08-23T05:00:00.000Z",
    reason: "callback_due",
    metadata: { dispatched_agent_version: 7 },
  });
  const dialing = await store.transition(booking.booking_id, "dialing", {
    at: "2026-08-23T05:00:01.000Z",
    reason: "sarvam_accepted",
    metadata: { attempt_id: "attempt-1", interaction_id: "interaction-1" },
  });

  assert.equal(store.getByAttemptId("attempt-1").booking_id, booking.booking_id);
  assert.equal(store.getByInteractionId("interaction-1").booking_id, booking.booking_id);
  assert.equal(dialing.dispatched_agent_version, 7);

  const reopened = await PersistentCallbackStore.open({ filePath, maxRecords: 1000 });
  assert.deepEqual(reopened.get(booking.booking_id), dialing);
  assert.equal(reopened.getByAttemptId("attempt-1").booking_id, booking.booking_id);
});

test("recovers interrupted dispatches as unknown without redialing", async () => {
  const { filePath, store } = await storeAt();
  const { booking } = await store.book(request());
  await store.transition(booking.booking_id, "dispatching", {
    at: "2026-08-23T05:00:00.000Z",
    reason: "callback_due",
  });

  const reopened = await PersistentCallbackStore.open({ filePath, maxRecords: 1000 });
  const recovered = await reopened.recover(new Date("2026-08-23T05:00:30.000Z"));

  assert.equal(recovered.length, 1);
  assert.equal(reopened.get(booking.booking_id).status, "dispatch_unknown");
  assert.equal(reopened.listDue(new Date("2026-08-23T06:00:00.000Z")).length, 0);
});

test("quarantines stale dialing outcomes while preserving late reconciliation", async () => {
  const { filePath, store } = await storeAt();
  const stale = await store.book(request({ request_id: "call-stale:callback" }));
  await store.transition(stale.booking.booking_id, "dispatching", {
    at: "2026-08-23T05:00:00.000Z",
    reason: "callback_due",
  });
  await store.transition(stale.booking.booking_id, "dialing", {
    at: "2026-08-23T05:00:01.000Z",
    reason: "sarvam_accepted",
    metadata: { attempt_id: "attempt-stale" },
  });

  const recent = await store.book(request({ request_id: "call-recent-dialing:callback" }));
  await store.transition(recent.booking.booking_id, "dispatching", {
    at: "2026-08-23T05:09:30.000Z",
    reason: "callback_due",
  });
  await store.transition(recent.booking.booking_id, "dialing", {
    at: "2026-08-23T05:09:31.000Z",
    reason: "sarvam_accepted",
    metadata: { attempt_id: "attempt-recent" },
  });

  const reopened = await PersistentCallbackStore.open({ filePath, maxRecords: 1000 });
  const recovered = await reopened.recover(new Date("2026-08-23T05:10:01.001Z"));

  assert.equal(recovered.length, 1);
  assert.equal(reopened.get(stale.booking.booking_id).status, "outcome_unknown");
  assert.equal(
    reopened.get(stale.booking.booking_id).history.at(-1).reason,
    "outcome_webhook_timeout"
  );
  assert.equal(reopened.get(recent.booking.booking_id).status, "dialing");
  assert.equal(reopened.countPending(), 1);

  await reopened.transition(stale.booking.booking_id, "connected", {
    at: "2026-08-23T05:11:00.000Z",
    reason: "sarvam_connected",
  });
  assert.equal(reopened.get(stale.booking.booking_id).status, "connected");
});

test("expires callbacks more than ten minutes overdue on recovery", async () => {
  const { store } = await storeAt();
  const old = await store.book(
    request({ request_id: "call-old:callback", callback_time_iso: "2026-08-23T05:00:00.000Z" })
  );
  const recent = await store.book(
    request({ request_id: "call-recent:callback", callback_time_iso: "2026-08-23T05:10:30.000Z" })
  );

  await store.recover(new Date("2026-08-23T05:11:00.001Z"));

  assert.equal(store.get(old.booking.booking_id).status, "expired");
  assert.equal(store.get(recent.booking.booking_id).status, "scheduled");
});

test("serializes concurrent mutations without losing records", async () => {
  const { filePath, store } = await storeAt();
  await Promise.all([
    store.book(request({ request_id: "call-a:callback" })),
    store.book(request({ request_id: "call-b:callback" })),
    store.book(request({ request_id: "call-c:callback" })),
  ]);

  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(persisted.length, 3);
  assert.equal(store.countPending(), 3);
});

test("migrates a legacy scheduled booking with transition history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "elevate-callbacks-"));
  const filePath = path.join(directory, "callbacks.json");
  const legacy = {
    booking_id: "cb-1111111111111111",
    ...request(),
    status: "scheduled",
    created_at: "2026-08-23T04:59:00.000Z",
  };
  await writeFile(filePath, JSON.stringify([legacy]));

  const store = await PersistentCallbackStore.open({ filePath, maxRecords: 1000 });

  assert.deepEqual(store.get(legacy.booking_id).history, [
    {
      status: "scheduled",
      at: legacy.created_at,
      reason: "legacy_import",
    },
  ]);
});

test("returns the original booking for a duplicate request ID", async () => {
  const { store } = await storeAt();
  const first = await store.book(request());
  const duplicate = await store.book(
    request({ callback_time_iso: "2026-08-24T11:00:00+05:30" })
  );

  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.booking, first.booking);
});

test("lists only scheduled callbacks due at the supplied time", async () => {
  const { store } = await storeAt();
  const due = await store.book(
    request({
      request_id: "call-early:callback",
      callback_time_iso: "2026-08-23T10:30:00+05:30",
    })
  );
  await store.book(
    request({
      request_id: "call-later:callback",
      callback_time_iso: "2026-08-25T10:30:00+05:30",
    })
  );

  assert.deepEqual(
    store.listDue(new Date("2026-08-23T05:01:00.000Z")),
    [due.booking]
  );
});

test("keeps only the newest bounded number of callback records", async () => {
  const { store } = await storeAt(2);
  const first = await store.book(request({ request_id: "call-1:callback" }));
  const second = await store.book(request({ request_id: "call-2:callback" }));
  const third = await store.book(request({ request_id: "call-3:callback" }));

  assert.equal(store.get(first.booking.booking_id), undefined);
  assert.deepEqual(store.get(second.booking.booking_id), second.booking);
  assert.deepEqual(store.get(third.booking.booking_id), third.booking);
});
