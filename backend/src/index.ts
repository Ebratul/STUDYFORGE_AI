import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { HttpRagAgentClient } from "./clients/rag-agent.js";
import { getEnv } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { ensureOpsScheduled, opsHandlers } from "./modules/admin/jobs.js";
import { examHandlers, ensureSweeperScheduled } from "./modules/exams/jobs.js";
import { startMetricsFlusher, stopMetricsFlusher } from "./lib/metrics.js";
import { ingestHandlers } from "./modules/jobs/ingest.js";
import { startWorker } from "./modules/jobs/worker.js";
import { createStorage } from "./modules/documents/storage/index.js";

const env = getEnv(); // fail fast with a value-free message if misconfigured
const rag = new HttpRagAgentClient();
const storage = createStorage();
const app = createApp({ rag, storage });

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  logger.info("backend.listening", { host: info.address, port: info.port, storage: storage.driver });
});
(server as import("node:http").Server).keepAliveTimeout = 65_000;

const stopWorker = env.JOB_WORKER_ENABLED ? startWorker({ ...ingestHandlers(rag, storage), ...examHandlers(rag), ...opsHandlers() }) : null;
startMetricsFlusher();
if (env.JOB_WORKER_ENABLED) void ensureOpsScheduled().catch((err) => logger.error("ops.schedule_failed", { err }));
if (env.JOB_WORKER_ENABLED) void ensureSweeperScheduled().catch((err) => logger.error("exam.sweeper_schedule_failed", { err }));

async function shutdown(signal: string) {
  logger.info("backend.shutdown", { signal });
  server.close();
  await stopWorker?.();
  await stopMetricsFlusher();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
