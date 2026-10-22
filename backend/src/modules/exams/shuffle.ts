import { createHash } from "node:crypto";

/**
 * Deterministic, participant-specific ordering (PART4_SPEC §6).
 * seed = SHA-256(text); a counter-mode SHA-256 byte stream drives an unbiased Fisher–Yates shuffle (rejection sampling).
 */
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest();

class ByteStream {
  private buf = Buffer.alloc(0);
  private counter = 0;
  constructor(private readonly seed: Buffer) {}
  private fill(n: number) {
    while (this.buf.length < n) {
      const c = Buffer.alloc(4);
      c.writeUInt32BE(this.counter++);
      this.buf = Buffer.concat([this.buf, sha(Buffer.concat([this.seed, c]))]);
    }
  }
  uint32(): number {
    this.fill(4);
    const v = this.buf.readUInt32BE(0);
    this.buf = this.buf.subarray(4);
    return v;
  }
  /** Uniform integer in [0, n) without modulo bias. */
  below(n: number): number {
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    for (;;) {
      const v = this.uint32();
      if (v < limit) return v % n;
    }
  }
}

export function seededShuffle<T>(items: readonly T[], seedText: string): T[] {
  const out = [...items];
  const rnd = new ByteStream(sha(seedText));
  for (let i = out.length - 1; i > 0; i--) {
    const j = rnd.below(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export const questionSeed = (examVersionId: string, userId: string, attemptNo: number) => `sf-exam-order-v1|${examVersionId}|${userId}|${attemptNo}`;

export function orderQuestions(ids: readonly string[], v: { examVersionId: string; userId: string; attemptNo: number }, shuffle: boolean): string[] {
  return shuffle ? seededShuffle(ids, questionSeed(v.examVersionId, v.userId, v.attemptNo)) : [...ids];
}

export function orderOptions(optionIds: readonly string[], questionId: string, v: { examVersionId: string; userId: string; attemptNo: number }, shuffle: boolean): string[] {
  return shuffle ? seededShuffle(optionIds, `${questionSeed(v.examVersionId, v.userId, v.attemptNo)}|${questionId}`) : [...optionIds];
}
