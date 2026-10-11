/**
 * Jest global setup for `npm run evals`: fresh results directory, run metadata, and a clear
 * message when the model key is missing (every eval file then skips).
 */
import fs from "node:fs";
import path from "node:path";
import { MAX_USD, RESULTS_DIR, type RunMeta } from "./results";

/** Prepare the results directory. */
export default async function globalSetup(): Promise<void> {
  fs.rmSync(RESULTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
  const meta: RunMeta = { startedAt: new Date().toISOString(), hasKey, maxUsd: MAX_USD };
  fs.writeFileSync(path.join(RESULTS_DIR, "meta.json"), JSON.stringify(meta));
  if (!hasKey) {
    console.warn("\n[evals] ANTHROPIC_API_KEY is not set: every eval suite will be skipped. Export it to run the evals.\n");
  }
}
