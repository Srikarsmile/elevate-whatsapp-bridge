import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PersistentRecordStore } from "../src/persistent-record-store.js";

async function storeAt(maxRecords = 1000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "elevate-records-"));
  const filePath = path.join(directory, "records.json");
  return {
    filePath,
    store: await PersistentRecordStore.open({ filePath, idField: "event_id", maxRecords }),
  };
}

test("persists records with private permissions and reopens them", async () => {
  const { filePath, store } = await storeAt();
  const result = await store.put({ event_id: "evt-1", status: "pending" });

  assert.equal(result.duplicate, false);
  assert.deepEqual(result.record, { event_id: "evt-1", status: "pending" });
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const reopened = await PersistentRecordStore.open({
    filePath,
    idField: "event_id",
    maxRecords: 1000,
  });
  assert.deepEqual(reopened.get("evt-1"), result.record);
});

test("deduplicates stable IDs without overwriting the original", async () => {
  const { store } = await storeAt();
  await store.put({ event_id: "evt-1", status: "pending" });
  const duplicate = await store.put({ event_id: "evt-1", status: "changed" });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.status, "pending");
});

test("updates records durably without changing their IDs", async () => {
  const { filePath, store } = await storeAt();
  await store.put({ event_id: "evt-1", status: "pending" });
  const updated = await store.update("evt-1", (record) => ({
    ...record,
    status: "complete",
  }));

  assert.equal(updated.status, "complete");
  const reopened = await PersistentRecordStore.open({
    filePath,
    idField: "event_id",
    maxRecords: 1000,
  });
  assert.equal(reopened.get("evt-1").status, "complete");
  await assert.rejects(
    () => store.update("evt-1", (record) => ({ ...record, event_id: "evt-2" })),
    /cannot change/
  );
});

test("serializes concurrent writes and keeps the newest bounded records", async () => {
  const { filePath, store } = await storeAt(2);
  await Promise.all([
    store.put({ event_id: "evt-1", sequence: 1 }),
    store.put({ event_id: "evt-2", sequence: 2 }),
    store.put({ event_id: "evt-3", sequence: 3 }),
  ]);

  assert.equal(store.get("evt-1"), undefined);
  assert.deepEqual(
    store.list().map((record) => record.event_id),
    ["evt-2", "evt-3"]
  );
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).length, 2);
});

test("counts and deletes matching records atomically", async () => {
  const { store } = await storeAt();
  await store.put({ event_id: "evt-1", status: "expired" });
  await store.put({ event_id: "evt-2", status: "active" });
  await store.put({ event_id: "evt-3", status: "expired" });

  assert.equal(store.count((record) => record.status === "expired"), 2);
  assert.equal(await store.deleteWhere((record) => record.status === "expired"), 2);
  assert.deepEqual(store.list(), [{ event_id: "evt-2", status: "active" }]);
});

test("fails closed on corrupt state and invalid records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "elevate-records-"));
  const filePath = path.join(directory, "records.json");
  await writeFile(filePath, JSON.stringify({ event_id: "not-an-array" }));

  await assert.rejects(
    () => PersistentRecordStore.open({ filePath, idField: "event_id", maxRecords: 10 }),
    /array/
  );

  const { store } = await storeAt();
  await assert.rejects(() => store.put({ status: "missing-id" }), /event_id/);
  await assert.rejects(() => store.update("missing", (record) => record), /not found/);
});
