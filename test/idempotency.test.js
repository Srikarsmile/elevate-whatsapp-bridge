import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PersistentIdempotencyStore } from "../src/idempotency.js";

test("persists idempotency results across store instances", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "elevate-idempotency-"));
  const filePath = path.join(directory, "requests.json");
  const first = await PersistentIdempotencyStore.open({ filePath, maxRecords: 3 });

  await first.put("call-1:mid-call", { ok: true, requestId: "call-1:mid-call" });

  const second = await PersistentIdempotencyStore.open({ filePath, maxRecords: 3 });
  assert.deepEqual(second.get("call-1:mid-call"), {
    ok: true,
    requestId: "call-1:mid-call",
  });
  assert.doesNotMatch(await readFile(filePath, "utf8"), /message body/i);
});

test("keeps only the newest bounded number of records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "elevate-idempotency-"));
  const filePath = path.join(directory, "requests.json");
  const store = await PersistentIdempotencyStore.open({ filePath, maxRecords: 2 });

  await store.put("call-1:mid-call", { sequence: 1 });
  await store.put("call-2:mid-call", { sequence: 2 });
  await store.put("call-3:mid-call", { sequence: 3 });

  assert.equal(store.get("call-1:mid-call"), undefined);
  assert.deepEqual(store.get("call-2:mid-call"), { sequence: 2 });
  assert.deepEqual(store.get("call-3:mid-call"), { sequence: 3 });
});
