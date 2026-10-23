import { StorageError, type Storage } from "./types.js";

/**
 * Serves each stored object from the backend its key names, so switching STORAGE_DRIVER for NEW uploads never strands
 * existing documents (no migration, no rewrite): `u/...` keys belong to the local/S3 store, `cld/...` keys to Cloudinary.
 * A backend that isn't configured fails with a clear NOT_CONFIGURED error instead of falling back to another one.
 */
export class RoutedStorage implements Storage {
  constructor(
    /** Receives all new uploads. */
    private primary: Storage,
    private routes: { u: Storage; cld: Storage | null },
  ) {}

  get driver() {
    return this.primary.driver;
  }

  private route(key: string): Storage {
    const prefix = key.split("/", 1)[0] as "u" | "cld";
    if (prefix !== "u" && prefix !== "cld") throw new Error("invalid storage key");
    const target = this.routes[prefix];
    if (!target) throw new StorageError("NOT_CONFIGURED", "The file storage service is not available right now. Please contact the administrator.");
    return target;
  }

  newKey(userId: string) {
    return this.primary.newKey(userId);
  }
  async put(key: string, data: Uint8Array, contentType: string) {
    return this.route(key).put(key, data, contentType);
  }
  async get(key: string) {
    return this.route(key).get(key);
  }
  async delete(key: string) {
    return this.route(key).delete(key);
  }
  async signedDownloadUrl(key: string, filename: string, ttlSeconds: number) {
    return this.route(key).signedDownloadUrl(key, filename, ttlSeconds);
  }
  ping() {
    return this.primary.ping();
  }
}
