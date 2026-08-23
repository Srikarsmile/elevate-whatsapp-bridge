import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class PersistentIdempotencyStore {
  static async open({ filePath, maxRecords = 1000 }) {
    const store = new PersistentIdempotencyStore({ filePath, maxRecords });
    await store.load();
    return store;
  }

  constructor({ filePath, maxRecords }) {
    this.filePath = filePath;
    this.maxRecords = maxRecords;
    this.records = new Map();
  }

  async load() {
    try {
      const content = await readFile(this.filePath, "utf8");
      const entries = JSON.parse(content);
      if (!Array.isArray(entries)) throw new Error("Idempotency state must be an array");
      this.records = new Map(entries.slice(-this.maxRecords));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  get(key) {
    return this.records.get(key);
  }

  async put(key, result) {
    this.records.delete(key);
    this.records.set(key, result);
    while (this.records.size > this.maxRecords) {
      this.records.delete(this.records.keys().next().value);
    }
    await this.persist();
  }

  async persist() {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify([...this.records])}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
