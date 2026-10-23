import { describe, expect, it } from "vitest";
import { CloudinaryStorage } from "../../src/modules/documents/storage/cloudinary.js";

// OPT-IN live check against a real Cloudinary account (uploads ~100 bytes, then deletes it). Skipped unless all three are set; the
// regular suite never makes provider requests. The LIVE_ prefix is deliberate: setup-env.ts strips CLOUDINARY_* from test processes.
//   LIVE_CLOUDINARY_CLOUD_NAME=... LIVE_CLOUDINARY_API_KEY=... LIVE_CLOUDINARY_API_SECRET=... pnpm vitest run --project integration tests/integration/storage-cloudinary-live.test.ts
const cloud = process.env.LIVE_CLOUDINARY_CLOUD_NAME;
const key = process.env.LIVE_CLOUDINARY_API_KEY;
const secret = process.env.LIVE_CLOUDINARY_API_SECRET;

describe.skipIf(!cloud || !key || !secret)("Cloudinary (live account)", () => {
  const storage = () => new CloudinaryStorage({ cloudName: cloud!, apiKey: key!, apiSecret: secret!, folder: "studyforge-live-test", maxReadBytes: 25 * 1024 * 1024 });
  const pdf = new TextEncoder().encode("%PDF-1.4\n% StudyForge live storage check\n%%EOF");

  it("stores a PDF privately, reads it back through the signed API, and deletes it", async () => {
    const s = storage();
    await s.ping();
    const k = s.newKey("livecheck");
    await s.put(k, pdf, "application/pdf");
    try {
      expect(Buffer.from(await s.get(k)).equals(Buffer.from(pdf))).toBe(true);

      // The real question: can anyone WITHOUT a signature fetch it? Both unsigned delivery URLs must be refused.
      const id = `studyforge-live-test/livecheck/${k.split("/")[2]}`;
      for (const type of ["upload", "authenticated", "private"]) {
        const res = await fetch(`https://res.cloudinary.com/${cloud}/raw/${type}/${id}`);
        expect(res.status, `unsigned raw/${type} delivery must not serve the PDF`).not.toBe(200);
      }
    } finally {
      await s.delete(k);
    }
    await expect(s.get(k)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await s.delete(k); // idempotent
  }, 60_000);
});
