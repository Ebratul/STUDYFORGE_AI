import { describe, expect, it } from "vitest";
import { parseSseBlock } from "../../src/clients/rag-agent.js";

describe("SSE parsing", () => {
  it("parses event and JSON data", () => {
    expect(parseSseBlock('event: delta\ndata: {"text":"hi"}')).toEqual({ event: "delta", data: { text: "hi" } });
  });
  it("joins multi-line data and tolerates CRLF", () => {
    expect(parseSseBlock('event: final\r\ndata: {"a":\r\ndata: 1}')).toEqual({ event: "final", data: { a: 1 } });
  });
  it("ignores comments, empty blocks and malformed JSON", () => {
    expect(parseSseBlock(": ping")).toBeNull();
    expect(parseSseBlock("event: delta\ndata: {nope")).toBeNull();
  });
});
