import type { RagAgentClient } from "../../clients/rag-agent.js";
import type { Handlers } from "../jobs/worker.js";
import { runPlanJob } from "./plan.js";
import { runAnalysisJob } from "./service.js";

/** Handlers for the AI feedback jobs. They need the rag_agent client, which the server injects at start-up. */
export function analysisHandlers(rag: RagAgentClient): Handlers {
  return {
    "exam.analysis": (job, signal) => runAnalysisJob(rag, job, signal),
    "study-plan": (job, signal) => runPlanJob(rag, job, signal),
  };
}
