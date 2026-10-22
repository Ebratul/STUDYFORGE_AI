import { resetEnvCache } from "../../src/config/env.js";

/** Runs `fn` with temporary environment overrides (the env cache is reset before and after). */
export async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  resetEnvCache();
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEnvCache();
  }
}
