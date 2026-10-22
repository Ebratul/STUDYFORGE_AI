import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { S3Storage } from "../../src/modules/documents/storage/s3.js";

// Runs only when an S3-compatible endpoint is available:
//   docker compose -f infra/docker-compose.yml --profile s3 up -d s3mock
//   S3_TEST_ENDPOINT=http://127.0.0.1:9090 pnpm test
const endpoint = process.env.S3_TEST_ENDPOINT;

describe.skipIf(!endpoint)("S3-compatible storage driver", () => {
  const storage = () =>
    new S3Storage({ endpoint: endpoint!, region: "us-east-1", bucket: process.env.S3_TEST_BUCKET ?? "studyforge", accessKeyId: "test", secretAccessKey: "test", forcePathStyle: true });
  const key = () => `u/user1/${randomBytes(16).toString("hex")}`;

  it("stores, reads back and deletes objects", async () => {
    const s = storage();
    const k = key();
    await s.put(k, new TextEncoder().encode("hello s3"), "text/plain");
    expect(new TextDecoder().decode(await s.get(k))).toBe("hello s3");
    await s.delete(k);
    await expect(s.get(k)).rejects.toThrow();
  });

  it("creates short-lived attachment download URLs", async () => {
    const s = storage();
    const k = key();
    await s.put(k, new Uint8Array([1, 2, 3]), "application/octet-stream");
    const url = (await s.signedDownloadUrl(k, 'evil"name.pdf', 60))!;
    expect(url).toContain("X-Amz-Expires=60");
    expect(url).toContain("response-content-disposition=attachment");
    expect(url).not.toContain("evil%22name"); // quotes are neutralised in the filename
    await s.delete(k);
  });

  it("refuses keys it did not generate (no traversal)", async () => {
    const s = storage();
    await expect(s.get("../../etc/passwd")).rejects.toThrow("invalid storage key");
    await expect(s.put("u/x/../../y", new Uint8Array(), "text/plain")).rejects.toThrow("invalid storage key");
  });
});
