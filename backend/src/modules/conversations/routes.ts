import { Hono } from "hono";
import { z } from "zod";
import type { RagAgentClient } from "../../clients/rag-agent.js";
import { requireAuth } from "../../http/middleware.js";
import type { AppEnv } from "../../http/context.js";
import { parseWith, readJson } from "../../http/body.js";
import { prepareChat, sendSchema } from "./chat.js";
import { createConversation, createSchema, deleteConversation, getConversation, listConversations, listMessages, updateConversation, updateSchema } from "./service.js";

const idSchema = z.string().min(1).max(64);
const enc = new TextEncoder();
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export function conversationRoutes(rag: RagAgentClient) {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);

  r.get("/", async (c) => {
    const q = parseWith(z.object({ q: z.string().max(100).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), {
      q: c.req.query("q"),
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    return c.json(await listConversations(c.get("user"), q));
  });

  r.post("/", async (c) => c.json({ conversation: await createConversation(c.get("user"), await readJson(c.req.raw, createSchema)) }, 201));

  r.get("/:id", async (c) => c.json({ conversation: await getConversation(c.get("user"), parseWith(idSchema, c.req.param("id"))) }));

  r.patch("/:id", async (c) =>
    c.json({ conversation: await updateConversation(c.get("user"), parseWith(idSchema, c.req.param("id")), await readJson(c.req.raw, updateSchema)) }),
  );

  r.delete("/:id", async (c) => {
    await deleteConversation(c.get("user"), parseWith(idSchema, c.req.param("id")));
    return c.json({ ok: true });
  });

  r.get("/:id/messages", async (c) => {
    const q = parseWith(z.object({ before: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), {
      before: c.req.query("before"),
      limit: c.req.query("limit"),
    });
    return c.json(await listMessages(c.get("user"), parseWith(idSchema, c.req.param("id")), q));
  });

  // Streams the assistant reply as Server-Sent Events. Validation/quota/config errors are returned as normal JSON errors
  // (before any streaming starts); once streaming starts, failures arrive as an `error` event.
  r.post("/:id/messages", async (c) => {
    const body = await readJson(c.req.raw, sendSchema, 64 * 1024);
    const turn = await prepareChat(rag, c.get("user"), parseWith(idSchema, c.req.param("id")), body);

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    c.req.raw.signal.addEventListener("abort", onAbort);
    let ping: NodeJS.Timeout | undefined;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        ping = setInterval(() => {
          try {
            controller.enqueue(enc.encode(": ping\n\n"));
          } catch {
            /* closed */
          }
        }, 15_000);
        try {
          for await (const ev of turn.events(abort.signal)) controller.enqueue(sse(ev.event, ev.data));
        } finally {
          clearInterval(ping);
          c.req.raw.signal.removeEventListener("abort", onAbort);
          try {
            controller.close();
          } catch {
            /* already closed by cancel */
          }
        }
      },
      cancel() {
        abort.abort(); // client pressed Stop / navigated away
        clearInterval(ping);
      },
    });

    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
    });
  });

  return r;
}
