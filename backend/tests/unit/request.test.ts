import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { assertSameOrigin, readJson } from "../../src/http/body.js";

beforeAll(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "x".repeat(40),
    APP_URL: "http://localhost:3100",
  });
});

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3100/api/x", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

describe("readJson", () => {
  const schema = z.object({ a: z.number() });
  it("parses valid JSON", async () => {
    expect(await readJson(post('{"a":1}'), schema)).toEqual({ a: 1 });
  });
  it("rejects invalid JSON and schema violations with VALIDATION", async () => {
    await expect(readJson(post("{nope"), schema)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(readJson(post('{"a":"x"}'), schema)).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it("enforces the byte limit by streaming, not by trusting Content-Length", async () => {
    const big = JSON.stringify({ a: 1, pad: "x".repeat(2000) });
    await expect(readJson(post(big), z.object({ a: z.number() }).passthrough(), 100)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    await expect(readJson(post(big, { "content-length": "5" }), z.object({ a: z.number() }).passthrough(), 100)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });
});

describe("assertSameOrigin (CSRF)", () => {
  const mk = (method: string, headers: Record<string, string>) => new Request("http://localhost:3100/api/x", { method, headers });
  it("allows safe methods without checks", () => {
    expect(() => assertSameOrigin(mk("GET", {}))).not.toThrow();
  });
  it("allows same-origin mutations", () => {
    expect(() => assertSameOrigin(mk("POST", { origin: "http://localhost:3100" }))).not.toThrow();
  });
  it("blocks cross-origin and origin-less mutations", () => {
    expect(() => assertSameOrigin(mk("POST", { origin: "https://evil.test" }))).toThrow();
    expect(() => assertSameOrigin(mk("DELETE", { "sec-fetch-site": "cross-site" }))).toThrow();
    expect(() => assertSameOrigin(mk("POST", {}))).toThrow();
  });
});
