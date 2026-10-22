import { describe, expect, it } from "vitest";
import { parseBlock, readSse } from "@/lib/sse";

function streamOf(chunks: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}
async function collect(chunks: string[]) {
  const out = [];
  for await (const e of readSse(streamOf(chunks))) out.push(e);
  return out;
}

describe("SSE reader", () => {
  it("parses events split arbitrarily across chunks", async () => {
    const events = await collect(['event: delta\ndata: {"text":"Hel', 'lo"}\n\nevent: final\nda', 'ta: {"ok":true}\n\n']);
    expect(events).toEqual([{ event: "delta", data: { text: "Hello" } }, { event: "final", data: { ok: true } }]);
  });
  it("handles CRLF, comments/pings and a final block without trailing blank line", async () => {
    const events = await collect([': ping\r\n\r\nevent: a\r\ndata: 1\r\n\r\n', "event: b\ndata: 2"]);
    expect(events).toEqual([{ event: "a", data: 1 }, { event: "b", data: 2 }]);
  });
  it("skips malformed JSON instead of throwing", async () => {
    expect(await collect(["event: x\ndata: {bad\n\nevent: y\ndata: 3\n\n"])).toEqual([{ event: "y", data: 3 }]);
  });
  it("parseBlock returns null for empty/comment-only blocks", () => {
    expect(parseBlock("")).toBeNull();
    expect(parseBlock(": ping")).toBeNull();
  });
});
