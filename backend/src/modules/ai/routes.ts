import { Hono } from "hono";
import { z } from "zod";
import type { RagAgentClient } from "../../clients/rag-agent.js";
import { RagAgentError } from "../../clients/rag-agent.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { AppError } from "../../lib/errors.js";
import { requireAuth } from "../../http/middleware.js";
import type { AppEnv } from "../../http/context.js";
import { readJson } from "../../http/body.js";
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

  r.get("/preferences", async (c) => c.json(await getPreferences(c.get("user"))));

  r.put("/preferences", async (c) => {
    const user = c.get("user");
    await enforceRateLimit({ key: `ai-prefs:${user.id}`, limit: 30, windowSec: 60 });
    const input = await readJson(c.req.raw, preferencesInput);
    try {
      return c.json(await setPreferences(rag, user, input));
    } catch (err) {
      return mapRagError(err);
    }
  });

  // Daily fields stay at the top level (existing clients); `daily`, `monthly`, `byTask` and `note` are the Part 5 additions.
  r.get("/usage", async (c) => c.json(await getUsageOverview(c.get("user").id)));

  return r;
}
