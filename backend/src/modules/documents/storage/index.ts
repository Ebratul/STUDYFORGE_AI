import { getEnv } from "../../../config/env.js";
import { LocalStorage } from "./local.js";
import { S3Storage } from "./s3.js";
import type { Storage } from "./types.js";

export type { Storage } from "./types.js";
export { KEY_PATTERN } from "./types.js";

export function createStorage(): Storage {
  const env = getEnv();
  if (env.STORAGE_DRIVER === "s3") {
    return new S3Storage({
      endpoint: env.S3_ENDPOINT!,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET!,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }
  return new LocalStorage(env.LOCAL_STORAGE_DIR);
}
