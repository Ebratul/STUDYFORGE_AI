import type { Storage } from "../../src/modules/documents/storage/types.js";

export class MemoryStorage implements Storage {
  readonly driver = "local" as const;
  files = new Map<string, Uint8Array>();
  failDelete = false;
  async put(key: string, data: Uint8Array) {
    this.files.set(key, data);
  }
  async get(key: string) {
    const f = this.files.get(key);
    if (!f) throw new Error("missing");
    return f;
  }
  async delete(key: string) {
    if (this.failDelete) throw new Error("storage down");
    this.files.delete(key);
  }
  async signedDownloadUrl() {
    return null;
  }
}
