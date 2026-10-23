import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { KEY_PATTERN, probeWritable, randomKey, type Storage } from "./types.js";

/** S3-compatible private bucket (Cloudflare R2, MinIO, AWS S3). The bucket must NOT be public. */
export class S3Storage implements Storage {
  readonly driver = "s3" as const;
  private client: S3Client;
  constructor(private cfg: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean }) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  newKey(userId: string) {
    return randomKey("u", userId);
  }

  async ping() {
    await probeWritable(this);
  }

  private key(key: string) {
    if (!KEY_PATTERN.test(key)) throw new Error("invalid storage key");
    return key;
  }

  async put(key: string, data: Uint8Array, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(key), Body: data, ContentType: contentType, ServerSideEncryption: undefined }));
  }

  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(key) }));
    return new Uint8Array(await res.Body!.transformToByteArray());
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(key) }));
  }

  async signedDownloadUrl(key: string, filename: string, ttlSeconds: number) {
    const safe = filename.replace(/["\\\r\n]/g, "_");
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(key),
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`,
        ResponseContentType: "application/octet-stream",
      }),
      { expiresIn: ttlSeconds },
    );
  }
}
