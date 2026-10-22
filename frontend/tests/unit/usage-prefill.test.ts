import { describe, expect, it } from "vitest";
import { readPrefill } from "@/lib/prefill";
import { readUsage, taskLabel, usageBar } from "@/lib/usage";

describe("usage bars", () => {
  it("treats a limit of 0 as unlimited (empty bar, explicit wording)", () => {
    const b = usageBar(1200, 0);
    expect(b).toMatchObject({ pct: 0, unlimited: true, nearLimit: false });
    expect(b.label).toMatch(/no limit/);
  });
  it("computes the share, caps at 100 and flags 'almost at the limit' from 90%", () => {
    expect(usageBar(250, 1000)).toMatchObject({ pct: 25, unlimited: false, nearLimit: false });
    expect(usageBar(900, 1000).nearLimit).toBe(true);
    expect(usageBar(5000, 1000).pct).toBe(100);
    expect(usageBar(0, 1000).pct).toBe(0);
  });
  it("reads the extended response and the older flat one, and always carries the no-cost note", () => {
    const u = readUsage({ daily: { tokens: 10, requests: 2, tokenLimit: 100, requestLimit: 10, resetsAt: "2026-01-02T00:00:00Z" }, monthly: { tokens: 50, requests: 9, tokenLimit: 0, requestLimit: 0, resetsAt: null }, byTask: [{ task: "ANALYSIS", requests: 3, tokens: 400 }, {}], note: "" });
    expect(u!.daily.tokenLimit).toBe(100);
    expect(u!.monthly!.tokenLimit).toBe(0);
    expect(u!.byTask).toHaveLength(2);
    expect(u!.note).toMatch(/no cost estimate/);
    const flat = readUsage({ tokens: 5, requests: 1, tokenLimit: 0, requestLimit: 0, resetsAt: "x" });
    expect(flat!.daily.tokens).toBe(5);
    expect(flat!.monthly).toBeNull();
    expect(readUsage(null)).toBeNull();
    expect(taskLabel("ANALYSIS")).toMatch(/feedback/i);
    expect(taskLabel("SOMETHING_NEW")).toBe("something new");
  });
});

describe("generator prefill", () => {
  it("reads topic, subject and a valid grounding", () => {
    expect(readPrefill({ topic: "Photosynthesis", subject: "Biology", grounding: "general" })).toEqual({ topic: "Photosynthesis", subject: "Biology", grounding: "GENERAL" });
  });
  it("sanitises: control characters, length, unknown grounding, arrays", () => {
    const p = readPrefill({ topic: ["A\u0000B\nC", "ignored"], subject: "x".repeat(500), grounding: "ROOT" });
    expect(p.topic).toBe("A B C");
    expect(p.subject).toHaveLength(120);
    expect(p.grounding).toBeNull();
    expect(readPrefill(undefined)).toEqual({ topic: "", subject: "", grounding: null });
    expect(readPrefill({ topic: "t".repeat(1000) }).topic).toHaveLength(300);
  });
});
