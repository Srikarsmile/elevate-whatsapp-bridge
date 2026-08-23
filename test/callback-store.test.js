import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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

  const reopened = await PersistentCallbackStore.open({ filePath, maxRecords: 1000 });
  assert.deepEqual(reopened.get(first.booking.booking_id), first.booking);
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
