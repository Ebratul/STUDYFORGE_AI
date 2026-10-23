import { Hono } from "hono";
import { z } from "zod";
import type { RagAgentClient } from "../../clients/rag-agent.js";
import { RagAgentError } from "../../clients/rag-agent.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { AppError } from "../../lib/errors.js";
import { requireAuth } from "../../http/middleware.js";
import type { AppEnv } from "../../http/context.js";
import { readJson } from "../../http/body.js";
import { connectionInput, getConnection, saveConnection, testConnection } from "./connection.js";
import { publicModelsQuery, searchPublicModels } from "./public-models.js";
import { cancelEmbeddingReindex, retryEmbeddingReindex } from "./reindex.js";
import { apiKeySchema, deleteCredential, listCredentials, saveCredential, testCandidate, testStored } from "./credentials.js";
import { getModels } from "./models.js";
import { getPreferences, LIMITS, preferencesInput, setPreferences, TASKS } from "./preferences.js";
import { enabledProviders, parseProvider, toWire } from "./providers.js";
import { getUsageOverview } from "./usage.js";

function mapRagError(err: unknown): never {
  if (err instanceof RagAgentError) {
    throw new AppError(err.code === "UPSTREAM_UNAVAILABLE" ? "UPSTREAM_UNAVAILABLE" : "PROVIDER_ERROR", err.message, {
      providerCode: err.code,
      retryable: err.retryable,
      retryAfterSec: err.retryAfterSeconds ?? undefined,
    });
  }
  throw err;
}

export function aiRoutes(rag: RagAgentClient) {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);

  // Catalogue (names, docs links, capability *kinds*) merged with this user's credential status. No models here.
  r.get("/providers", async (c) => {
    const user = c.get("user");
    const [catalog, creds] = await Promise.all([rag.providers().catch(mapRagError), listCredentials(user)]);
    const enabled = new Set(enabledProviders().map(toWire));
    return c.json({
      providers: catalog
        .filter((p) => enabled.has(p.id))
        .map((p) => {
          const cred = creds.find((x) => toWire(x.provider) === p.id);
          return { ...p, credential: cred ?? null };
        }),
      tasks: TASKS,
      limits: LIMITS,
    });
  });

  r.get("/credentials", async (c) => c.json({ items: await listCredentials(c.get("user")) }));

  // Save a new key or rotate an existing one. The response carries only the masked form.
  r.put("/credentials/:provider", async (c) => {
    const user = c.get("user");
    await enforceRateLimit({ key: `cred-save:${user.id}`, limit: 20, windowSec: 60 });
    const provider = parseProvider(c.req.param("provider"));
    const { apiKey } = await readJson(c.req.raw, z.object({ apiKey: apiKeySchema }));
    return c.json({ credential: await saveCredential(user, provider, apiKey) });
  });

  r.delete("/credentials/:provider", async (c) => {
    const provider = parseProvider(c.req.param("provider"));
    await deleteCredential(c.get("user"), provider);
    return c.json({ ok: true });
  });

  // Test a key before saving it (nothing is stored).
  r.post("/credentials/test", async (c) => {
    const user = c.get("user");
    await enforceRateLimit({ key: `cred-test:${user.id}`, limit: 10, windowSec: 60 });
    const { provider, apiKey } = await readJson(c.req.raw, z.object({ provider: z.string().min(1).max(20), apiKey: apiKeySchema }));
    return c.json(await testCandidate(rag, parseProvider(provider), apiKey));
  });

  r.post("/credentials/:provider/test", async (c) => {
    const user = c.get("user");
    await enforceRateLimit({ key: `cred-test:${user.id}`, limit: 10, windowSec: 60 });
    return c.json(await testStored(rag, user, parseProvider(c.req.param("provider"))));
  });

  r.get("/credentials/:provider/models", async (c) => {
    const user = c.get("user");
    await enforceRateLimit({ key: `models:${user.id}`, limit: 20, windowSec: 60 });
    const provider = parseProvider(c.req.param("provider"));
    try {
      return c.json(await getModels(rag, user, provider, c.req.query("refresh") === "1"));
    } catch (err) {
      return mapRagError(err);
    }
  });

  // The single, simplified configuration (AI_CONNECTION_SPEC): API key + chat model id + embedding model id. Responses are masked.
  r.get("/connection", async (c) => c.json({ connection: await getConnection(c.get("user")) }));

  r.put("/connection", async (c) => c.json(await saveConnection(rag, c.get("user"), await readJson(c.req.raw, connectionInput))));

  // "Test configuration": the same checks as saving, explicitly requested, nothing written. May make tiny provider requests (free for :free models).
  r.post("/connection/test", async (c) => c.json(await testConnection(rag, c.get("user"), await readJson(c.req.raw, connectionInput))));

  // Staged embedding re-index (EMBEDDING_SETTINGS_SPEC §5): the old index keeps serving; these only end or restart the build.
  r.post("/embedding-reindex/cancel", async (c) => {
    const user = c.get("user");
    await enforceRateLimit({ key: `embedding-reindex:${user.id}`, limit: 10, windowSec: 60 });
    await cancelEmbeddingReindex(user.id);
    return c.json({ connection: await getConnection(user) });
  });

  r.post("/embedding-reindex/retry", async (c) => {
    const user = c.get("user");
    await enforceRateLimit({ key: `embedding-reindex:${user.id}`, limit: 10, windowSec: 60 });
    await retryEmbeddingReindex(user.id);
    return c.json({ connection: await getConnection(user) });
  });

  // Optional suggestions from the provider's PUBLIC model list (no key used). Typing any model id stays possible.
  r.get("/public-models", async (c) => {
    const user = c.get("user");
    await enforceRateLimit({ key: `public-models:${user.id}`, limit: 30, windowSec: 60 });
    const parsed = publicModelsQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!parsed.success) throw new AppError("VALIDATION", "Invalid query.", { fields: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? "query"), i.message])) });
    return c.json(await searchPublicModels(rag, parsed.data));
  });

  r.get("/preferences", async (c) => c.json(await getPreferences(c.get("user"))));

  r.put("/preferences", async (c) => {
    const user = c.get("user");
    await enforceRateLimit({ key: `ai-prefs:${user.id}`, limit: 30, windowSec: 60 });
    const input = await readJson(c.req.raw, preferencesInput);
    try {
      const view = await setPreferences(rag, user, input);
      if (input.tasks?.EMBEDDING === null) await cancelEmbeddingReindex(user.id); // nothing left to switch to
      return c.json(view);
    } catch (err) {
      return mapRagError(err);
    }
  });

  // Daily fields stay at the top level (existing clients); `daily`, `monthly`, `byTask` and `note` are the Part 5 additions.
  r.get("/usage", async (c) => c.json(await getUsageOverview(c.get("user").id)));

  return r;
}
