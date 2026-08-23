import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function bookingId(requestId) {
  return `cb-${createHash("sha256").update(requestId).digest("hex").slice(0, 16)}`;
}

export class PersistentCallbackStore {
  static async open({ filePath, maxRecords = 1000 }) {
    const store = new PersistentCallbackStore({ filePath, maxRecords });
    await store.load();
    return store;
  }

  constructor({ filePath, maxRecords }) {
    this.filePath = filePath;
    this.maxRecords = maxRecords;
    this.records = new Map();
    this.requestIds = new Map();
  }

  async load() {
    try {
      const content = await readFile(this.filePath, "utf8");
      const records = JSON.parse(content);
      if (!Array.isArray(records)) throw new Error("Callback state must be an array");
      for (const booking of records.slice(-this.maxRecords)) {
        this.records.set(booking.booking_id, booking);
        this.requestIds.set(booking.request_id, booking.booking_id);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  get(id) {
    return this.records.get(id);
  }

  async book(request) {
    const existingId = this.requestIds.get(request.request_id);
    if (existingId) {
      return { booking: this.records.get(existingId), duplicate: true };
    }

    const booking = {
      booking_id: bookingId(request.request_id),
      ...request,
      status: "scheduled",
      created_at: new Date().toISOString(),
    };
    this.records.set(booking.booking_id, booking);
    this.requestIds.set(booking.request_id, booking.booking_id);

    while (this.records.size > this.maxRecords) {
      const oldestId = this.records.keys().next().value;
      const oldest = this.records.get(oldestId);
      this.records.delete(oldestId);
      this.requestIds.delete(oldest.request_id);
    }
    await this.persist();
    return { booking, duplicate: false };
  }

  listDue(now = new Date()) {
    return [...this.records.values()].filter(
      (booking) =>
        booking.status === "scheduled" &&
        Date.parse(booking.callback_time_iso) <= now.getTime()
    );
  }

  async persist() {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify([...this.records.values()])}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
