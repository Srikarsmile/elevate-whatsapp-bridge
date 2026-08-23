import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function freezeRecord(record) {
  return Object.freeze({ ...record });
}

export class PersistentRecordStore {
  static async open({ filePath, idField, maxRecords = 1000 }) {
    const store = new PersistentRecordStore({ filePath, idField, maxRecords });
    await store.load();
    return store;
  }

  constructor({ filePath, idField, maxRecords }) {
    if (!filePath || !idField) throw new Error("Record store path and ID field are required");
    this.filePath = filePath;
    this.idField = idField;
    this.maxRecords = maxRecords;
    this.records = new Map();
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const content = await readFile(this.filePath, "utf8");
      const records = JSON.parse(content);
      if (!Array.isArray(records)) throw new Error("Record state must be an array");
      for (const value of records.slice(-this.maxRecords)) {
        const record = this.validate(value);
        this.records.set(record[this.idField], record);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  get(id) {
    return this.records.get(id);
  }

  list(predicate = () => true) {
    return [...this.records.values()].filter(predicate);
  }

  count(predicate = () => true) {
    return this.list(predicate).length;
  }

  async put(value) {
    return this.enqueue(async () => {
      const record = this.validate(value);
      const id = record[this.idField];
      const existing = this.records.get(id);
      if (existing) return { record: existing, duplicate: true };
      this.records.set(id, record);
      this.evictOldest();
      await this.persist();
      return { record, duplicate: false };
    });
  }

  async update(id, updater) {
    return this.enqueue(async () => {
      const existing = this.records.get(id);
      if (!existing) throw new Error(`Record not found: ${id}`);
      const updated = this.validate(updater(existing));
      if (updated[this.idField] !== id) throw new Error(`Record update cannot change ${this.idField}`);
      this.records.set(id, updated);
      await this.persist();
      return updated;
    });
  }

  async deleteWhere(predicate) {
    return this.enqueue(async () => {
      let deleted = 0;
      for (const [id, record] of this.records) {
        if (predicate(record)) {
          this.records.delete(id);
          deleted += 1;
        }
      }
      if (deleted > 0) await this.persist();
      return deleted;
    });
  }

  validate(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Record must be an object");
    }
    const id = value[this.idField];
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error(`Record requires ${this.idField}`);
    }
    return freezeRecord(value);
  }

  evictOldest() {
    while (this.records.size > this.maxRecords) {
      this.records.delete(this.records.keys().next().value);
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
