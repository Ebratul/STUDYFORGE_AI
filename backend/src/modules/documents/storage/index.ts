import { getEnv, type Env } from "../../../config/env.js";
import { CloudinaryStorage } from "./cloudinary.js";
import { LocalStorage } from "./local.js";
import { RoutedStorage } from "./router.js";
import { S3Storage } from "./s3.js";
import type { Storage } from "./types.js";

export type { Storage } from "./types.js";
export { KEY_PATTERN, StorageError } from "./types.js";

export function createStorage(env: Env = getEnv()): Storage {
  // `u/...` keys (documents uploaded before Cloudinary was enabled, or while using local/S3) stay with their original backend.
  const legacy: Storage =
    env.STORAGE_DRIVER === "s3"
      ? new S3Storage({
          endpoint: env.S3_ENDPOINT!,
          region: env.S3_REGION,
          bucket: env.S3_BUCKET!,
          accessKeyId: env.S3_ACCESS_KEY_ID!,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
        })
      : new LocalStorage(env.LOCAL_STORAGE_DIR);

  // Existing `cld/...` documents stay readable and deletable if the driver is switched back, as long as the credentials are still set.
  // The driver being "cloudinary" with missing credentials is already rejected at startup (parseEnv), never silently downgraded.
  const hasCredentials = Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
  const cloudinary =
    env.STORAGE_DRIVER === "cloudinary" || hasCredentials
      ? new CloudinaryStorage({
          cloudName: env.CLOUDINARY_CLOUD_NAME!,
          apiKey: env.CLOUDINARY_API_KEY!,
          apiSecret: env.CLOUDINARY_API_SECRET!,
          folder: env.CLOUDINARY_FOLDER,
          maxFileBytes: env.CLOUDINARY_MAX_FILE_BYTES,
          maxReadBytes: env.MAX_UPLOAD_BYTES,
        })
      : null;

  return new RoutedStorage(env.STORAGE_DRIVER === "cloudinary" ? cloudinary! : legacy, { u: legacy, cld: cloudinary });
}
