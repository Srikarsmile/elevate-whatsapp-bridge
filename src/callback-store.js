import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CALLBACK_STATES,
  freezeCallbackRecord,
  transitionRecord,
} from "./callback-state.js";

function bookingId(requestId) {
  return `cb-${createHash("sha256").update(requestId).digest("hex").slice(0, 16)}`;
}

export class PersistentCallbackStore {
  static async open({ filePath, maxRecords = 1000, clock = () => new Date() }) {
    const store = new PersistentCallbackStore({ filePath, maxRecords, clock });
    await store.load();
    return store;
  }

  constructor({ filePath, maxRecords, clock }) {
    this.filePath = filePath;
    this.maxRecords = maxRecords;
    this.clock = clock;
    this.records = new Map();
    this.requestIds = new Map();
    this.attemptIds = new Map();
    this.interactionIds = new Map();
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const content = await readFile(this.filePath, "utf8");
      const records = JSON.parse(content);
      if (!Array.isArray(records)) throw new Error("Callback state must be an array");
      for (const value of records.slice(-this.maxRecords)) {
        const booking = this.normalizeLoaded(value);
        this.records.set(booking.booking_id, booking);
        this.index(booking);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  get(id) {
    return this.records.get(id);
  }

  getByAttemptId(id) {
    return this.records.get(this.attemptIds.get(id));
  }

  getByInteractionId(id) {
    return this.records.get(this.interactionIds.get(id));
  }

  async book(request) {
    return this.enqueue(async () => {
      const existingId = this.requestIds.get(request.request_id);
      if (existingId) {
        return { booking: this.records.get(existingId), duplicate: true };
      }

      const createdAt = this.clock().toISOString();
      const booking = freezeCallbackRecord({
        booking_id: bookingId(request.request_id),
        ...request,
        status: "scheduled",
        created_at: createdAt,
        updated_at: createdAt,
        history: [
          { status: "scheduled", at: createdAt, reason: "callback_confirmed" },
        ],
      });
      this.records.set(booking.booking_id, booking);
      this.index(booking);
      this.evictOldest();
      await this.persist();
      return { booking, duplicate: false };
    });
  }

  async transition(bookingIdValue, to, transition) {
    return this.enqueue(async () => {
      const current = this.records.get(bookingIdValue);
      if (!current) throw new Error(`Callback booking not found: ${bookingIdValue}`);
      const next = transitionRecord(current, to, transition);
      this.unindex(current);
      this.records.set(bookingIdValue, next);
      this.index(next);
      await this.persist();
      return next;
    });
  }

  async recover(now = new Date()) {
    return this.enqueue(async () => {
      const at = now.toISOString();
      const recovered = [];
      for (const current of this.records.values()) {
        let next = null;
        if (current.status === "dispatching") {
          next = transitionRecord(current, "dispatch_unknown", {
            at,
            reason: "restart_during_dispatch",
          });
        } else if (
          current.status === "scheduled" &&
          now.getTime() - Date.parse(current.callback_time_iso) > 10 * 60 * 1000
        ) {
          next = transitionRecord(current, "expired", {
            at,
            reason: "overdue_after_restart",
          });
        }
        if (next) {
          this.unindex(current);
          this.records.set(next.booking_id, next);
          this.index(next);
          recovered.push(next);
        }
      }
      if (recovered.length > 0) await this.persist();
      return recovered;
    });
  }

  listDue(now = new Date()) {
    return [...this.records.values()].filter(
      (booking) =>
        booking.status === "scheduled" &&
        Date.parse(booking.callback_time_iso) <= now.getTime()
    );
  }

  countPending() {
    return [...this.records.values()].filter((booking) =>
      ["scheduled", "dispatching", "dialing"].includes(booking.status)
    ).length;
  }

  normalizeLoaded(value) {
    if (!value || typeof value !== "object") throw new Error("Invalid callback record");
    if (!/^cb-[a-f0-9]{16}$/.test(value.booking_id || "")) {
      throw new Error("Invalid callback booking ID");
    }
    if (typeof value.request_id !== "string" || !CALLBACK_STATES.includes(value.status)) {
      throw new Error("Invalid callback record state");
    }
    const history = Array.isArray(value.history)
      ? value.history
      : [
          {
            status: value.status,
            at: value.created_at,
            reason: "legacy_import",
          },
        ];
    return freezeCallbackRecord({ ...value, history });
  }

  index(booking) {
    this.requestIds.set(booking.request_id, booking.booking_id);
    if (booking.attempt_id) this.attemptIds.set(booking.attempt_id, booking.booking_id);
    if (booking.interaction_id) {
      this.interactionIds.set(booking.interaction_id, booking.booking_id);
    }
  }

  unindex(booking) {
    this.requestIds.delete(booking.request_id);
    if (booking.attempt_id) this.attemptIds.delete(booking.attempt_id);
    if (booking.interaction_id) this.interactionIds.delete(booking.interaction_id);
  }

  evictOldest() {
    while (this.records.size > this.maxRecords) {
      const oldestId = this.records.keys().next().value;
      const oldest = this.records.get(oldestId);
      this.records.delete(oldestId);
      this.unindex(oldest);
    }
  }

  enqueue(operation) {
    const queued = this.writeChain.then(operation);
    this.writeChain = queued.catch(() => undefined);
    return queued;
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
