import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { KEY_PATTERN, probeWritable, randomKey, type Storage } from "./types.js";

/** Private on-disk store for development/self-hosting. Files are never served statically. */
export class LocalStorage implements Storage {
  readonly driver = "local" as const;
  private root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }

  private path(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error("invalid storage key");
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error("invalid storage key");
    return full;
  }

  newKey(userId: string) {
    return randomKey("u", userId);
  }

  async ping() {
    await probeWritable(this);
  }

  async put(key: string, data: Uint8Array) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(p, data, { mode: 0o600 });
  }

  async get(key: string) {
    return new Uint8Array(await readFile(this.path(key)));
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }

  async signedDownloadUrl() {
    return null;
  }
}
