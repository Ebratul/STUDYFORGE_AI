import { describe, expect, it } from "vitest";
import { AutosaveQueue, backoffDelay, SaveFailure, type SaveItem, type SaveResponse } from "@/lib/exams";

type Sent = SaveItem[];
function harness(opts: { initial?: Record<string, { optionId: string | null; marked: boolean; seq: number; savedAt: string }>; fail?: (n: number) => Error | null; stale?: Set<string> } = {}) {
  const sent: Sent[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let calls = 0;
  const q = new AutosaveQueue({
    initial: opts.initial ?? {},
    send: async (items): Promise<SaveResponse> => {
      calls++;
      const err = opts.fail?.(calls);
      if (err) throw err;
      sent.push(items);
      return { saved: items.map((i) => ({ questionId: i.questionId, seq: i.seq, savedAt: "2026-10-23T10:00:00Z", stale: opts.stale?.has(i.questionId) ?? false })), serverNow: "x", deadlineAt: "y", remainingMs: 1234 };
    },
    schedule: (fn, ms) => { const t = { fn, ms }; timers.push(t); return () => { t.fn = () => undefined; }; },
  });
  return { q, sent, timers };
}

describe("AutosaveQueue", () => {
  it("a change is NOT saved until the server confirms it", async () => {
    const { q, sent } = harness();
    q.change("q1", { optionId: "a" });
    expect(q.pendingCount).toBe(1);
    expect(q.isSaved("q1")).toBe(false);
    const p = q.flush();
    expect(q.status).toBe("saving");
    expect(q.isSaved("q1")).toBe(false); // still unconfirmed while in flight
    await p;
    expect(sent).toEqual([[{ questionId: "q1", optionId: "a", marked: false, seq: 1 }]]);
    expect(q.isSaved("q1")).toBe(true);
    expect(q.pendingCount).toBe(0);
    expect(q.status).toBe("idle");
  });
  it("seq increases per question and the latest value wins", async () => {
    const { q, sent } = harness();
    q.change("q1", { optionId: "a" });
    q.change("q1", { optionId: "b" });
    q.change("q2", { marked: true });
    await q.flush();
    expect(sent[0]).toEqual([
      { questionId: "q1", optionId: "b", marked: false, seq: 2 },
      { questionId: "q2", optionId: null, marked: true, seq: 1 },
    ]);
  });
  it("continues numbering from the server's stored seq", async () => {
    const { q, sent } = harness({ initial: { q1: { optionId: "a", marked: false, seq: 7, savedAt: "t" } } });
    expect(q.isSaved("q1")).toBe(true);
    q.change("q1", { optionId: "b" });
    await q.flush();
    expect(sent[0]![0]!.seq).toBe(8);
  });
  it("an edit made while a save is in flight is not falsely confirmed by the first response, and is sent in the same flush", async () => {
    const sent: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const q = new AutosaveQueue({
      initial: {}, schedule: () => () => undefined,
      send: async (items) => {
        sent.push(items[0]!.seq);
        if (first) { first = false; await gate; }
        return { saved: items.map((i) => ({ questionId: i.questionId, seq: i.seq, savedAt: "t" })), serverNow: "", deadlineAt: "", remainingMs: 1 };
      },
    });
    q.change("q1", { optionId: "a" });
    const p = q.flush();
    q.change("q1", { optionId: "b" }); // seq 2 while seq 1 is in flight
    expect(q.isSaved("q1")).toBe(false);
    release();
    await p;
    expect(sent).toEqual([1, 2]);
    expect(q.isSaved("q1")).toBe(true);
    expect(q.answers.get("q1")).toMatchObject({ optionId: "b", seq: 2, confirmedSeq: 2 });
  });
  it("network failure: stays unsaved, reports offline, retries with backoff and then confirms", async () => {
    const { q, sent, timers } = harness({ fail: (n) => (n <= 2 ? new SaveFailure("network", "down") : null) });
    q.change("q1", { optionId: "a" });
    await q.flush();
    expect(q.status).toBe("offline");
    expect(q.isSaved("q1")).toBe(false);
    expect(q.pendingCount).toBe(1);
    expect(timers.at(-1)!.ms).toBe(backoffDelay(1));
    await q.flush();
    expect(q.status).toBe("offline");
    expect(timers.at(-1)!.ms).toBe(backoffDelay(2));
    expect(backoffDelay(2)).toBeGreaterThan(backoffDelay(1));
    await q.flush();
    expect(q.status).toBe("idle");
    expect(q.isSaved("q1")).toBe(true);
    expect(sent).toHaveLength(1);
  });
  it("backoff is capped", () => {
    expect(backoffDelay(50)).toBeLessThanOrEqual(30_000 * 1.25);
    expect(backoffDelay(1, 0.5)).toBe(1000);
  });
  it("expiry stops saving and nothing more is ever sent", async () => {
    const { q, sent } = harness({ fail: () => new SaveFailure("expired", "over") });
    q.change("q1", { optionId: "a" });
    await q.flush();
    expect(q.status).toBe("expired");
    q.change("q1", { optionId: "b" });
    await q.flush();
    expect(sent).toHaveLength(0);
    expect(q.isSaved("q1")).toBe(false); // honest: it was never confirmed
  });
  it("a rejected save surfaces an error and doesn't loop", async () => {
    const { q, timers } = harness({ fail: () => new SaveFailure("rejected", "That option isn't valid.") });
    q.change("q1", { optionId: "zzz" });
    const before = timers.length;
    await q.flush();
    expect(q.status).toBe("error");
    expect(q.lastError).toBe("That option isn't valid.");
    expect(timers.length).toBe(before); // no retry is scheduled for a rejection
  });
  it("a stale response is treated as handled and asks for a re-sync", async () => {
    const { q } = harness({ stale: new Set(["q1"]) });
    q.change("q1", { optionId: "a" });
    await q.flush();
    expect(q.needsResync).toBe(true);
    expect(q.pendingCount).toBe(0);
    q.mergeServer({ q1: { optionId: "z", marked: false, seq: 9, savedAt: "t" } });
    expect(q.answers.get("q1")).toMatchObject({ optionId: "z", seq: 9, confirmedSeq: 9 });
    expect(q.needsResync).toBe(false);
  });
  it("restoring after a reconnect keeps local unconfirmed edits and adopts newer server answers", () => {
    const { q } = harness();
    q.change("q1", { optionId: "mine" }); // seq 1, unconfirmed
    q.change("q2", { optionId: "old" }); // seq 1, unconfirmed
    q.mergeServer({
      q1: { optionId: "server-q1", marked: false, seq: 1, savedAt: "t" }, // same seq: ours is still unconfirmed locally; server holds seq 1 so it is confirmed
      q2: { optionId: "server-q2", marked: true, seq: 5, savedAt: "t" }, // server is ahead
      q3: { optionId: "only-server", marked: false, seq: 2, savedAt: "t" },
    });
    expect(q.answers.get("q2")).toMatchObject({ optionId: "server-q2", marked: true, seq: 5 });
    expect(q.answers.get("q3")).toMatchObject({ optionId: "only-server" });
    expect(q.answers.get("q1")!.confirmedSeq).toBe(1);
  });
  it("sends at most maxBatch items per request", async () => {
    const sent: number[] = [];
    const q = new AutosaveQueue({
      initial: {}, maxBatch: 2, schedule: () => () => undefined,
      send: async (items) => { sent.push(items.length); return { saved: items.map((i) => ({ questionId: i.questionId, seq: i.seq, savedAt: "t" })), serverNow: "", deadlineAt: "", remainingMs: 1 }; },
    });
    for (const id of ["a", "b", "c", "d", "e"]) q.change(id, { optionId: "x" });
    await q.flush();
    expect(sent).toEqual([2, 2, 1]);
  });
  it("calls onResponse so the countdown re-syncs from every confirmation", async () => {
    const seen: number[] = [];
    const q = new AutosaveQueue({
      initial: {}, schedule: () => () => undefined, onResponse: (r) => seen.push(r.remainingMs),
      send: async (items) => ({ saved: items.map((i) => ({ questionId: i.questionId, seq: i.seq, savedAt: "t" })), serverNow: "", deadlineAt: "", remainingMs: 4242 }),
    });
    q.change("a", { optionId: "x" });
    await q.flush();
    expect(seen).toEqual([4242]);
  });
});
