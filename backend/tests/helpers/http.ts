import { createApp } from "../../src/app.js";
import { FakeRag } from "./fake-rag.js";
import { MemoryStorage } from "./memory-storage.js";
import { TEST_ORIGIN, type TestUser } from "./users.js";

export function makeApp() {
  const rag = new FakeRag();
  const storage = new MemoryStorage();
  const app = createApp({ rag, storage });
  return { app, rag, storage };
}
export type TestApp = ReturnType<typeof makeApp>;

/** Calls the Hono app in-process as `user` (or anonymously), with the browser-like Origin header on mutations. */
export function client(t: TestApp, user?: Pick<TestUser, "headers">) {
  async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers = new Headers(user?.headers);
    headers.set("origin", TEST_ORIGIN);
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    let payload: RequestInit["body"] | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers.set("content-type", "application/json");
      payload = JSON.stringify(body);
    }
    return t.app.request(path, { method, headers, body: payload });
  }
  return {
    get: (p: string) => call("GET", p),
    post: (p: string, b?: unknown, h?: Record<string, string>) => call("POST", p, b ?? {}, h),
    put: (p: string, b?: unknown) => call("PUT", p, b ?? {}),
    patch: (p: string, b?: unknown) => call("PATCH", p, b ?? {}),
    delete: (p: string) => call("DELETE", p),
    raw: call,
  };
}

export async function readSse(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith(":"))
    .map((b) => {
      const event = /^event: (.*)$/m.exec(b)?.[1] ?? "message";
      const data = JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? "null");
      return { event, data };
    });
}

/** Gives `user` a (mock) provider key plus default-chat and embedding preferences. */
export async function setupAi(t: TestApp, user: Pick<TestUser, "headers">, opts: { embedding?: boolean } = {}) {
  const c = client(t, user);
  expectOk(await c.put("/api/ai/credentials/mock", { apiKey: "mock-valid-key" }));
  expectOk(
    await c.put("/api/ai/preferences", {
      default: { provider: "mock", modelId: "mock-chat" },
      tasks: opts.embedding === false ? {} : { EMBEDDING: { provider: "mock", modelId: "mock-embed" } },
    }),
  );
}

function expectOk(res: Response) {
  if (!res.ok) throw new Error(`setup request failed: ${res.status}`);
}
