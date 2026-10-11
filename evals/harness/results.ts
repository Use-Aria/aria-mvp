/**
 * Eval results on disk. Each eval file writes one JSON file per suite into a run directory
 * (`os.tmpdir()/aria-evals`, cleared by global setup); the global teardown (`report.ts`) reads them
 * to print the cost report and write `evals/BASELINE.md`. Results hold names, counts, timings and
 * costs only — never prompts, replies or secrets.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Directory shared by global setup, the eval files and the teardown. */
export const RESULTS_DIR = process.env.EVAL_RESULTS_DIR ?? path.join(os.tmpdir(), "aria-evals");

/** One sample of one case. */
export interface SampleRecord {
  pass: boolean;
  skipped: boolean;
  /** short failure codes / messages (no model text beyond a clipped excerpt) */
  failures: string[];
  /** wall-clock latency of each agent turn in the sample (ms) */
  turnLatencyMs: number[];
  /** times the sample was re-run because the content under test never reached the model */
  reruns: number;
  /** informational markers a case records per sample (e.g. which path the model took) */
  tags: string[];
  /** failed samples only: per turn, tools called + a clipped reply (local results dir; never in BASELINE.md) */
  trace?: string[];
}

/** One case: its samples and the pass threshold. */
export interface CaseRecord {
  suite: string;
  name: string;
  samples: SampleRecord[];
  minPass: number;
  /** gate cases must pass every sample */
  gate: boolean;
  passed: boolean;
  costUsd: number;
  llmCalls: number;
}

/** Cost rollup of one suite, from `llm_calls` (queried before cleanup). */
export interface SuiteCost {
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  byRoute: Record<string, { calls: number; costUsd: number }>;
  models: string[];
  /** model call latencies (ms) from llm_calls */
  callLatencyMs: number[];
}

/** Everything one eval file reports. */
export interface SuiteRecord {
  suite: string;
  file: string;
  finishedAt: string;
  cases: CaseRecord[];
  cost: SuiteCost;
  leftovers: Record<string, number>;
}

/** Run metadata written by global setup. */
export interface RunMeta {
  startedAt: string;
  hasKey: boolean;
  maxUsd: number;
}

/** Per-run spend cap (USD); `EVAL_MAX_USD` overrides. */
export const MAX_USD = Number(process.env.EVAL_MAX_USD ?? "1.5");

/**
 * Write one suite's results.
 * @param r suite record
 */
export function writeSuite(r: SuiteRecord): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, `suite-${r.suite}.json`), JSON.stringify(r, null, 2));
}

/**
 * Read every suite written in this run.
 * @returns suite records (sorted by suite name)
 */
export function readSuites(): SuiteRecord[] {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  return fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith("suite-") && f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf8")) as SuiteRecord)
    .sort((a, b) => a.suite.localeCompare(b.suite));
}

/**
 * Read run metadata.
 * @returns metadata, or null when global setup didn't run
 */
export function readMeta(): RunMeta | null {
  const p = path.join(RESULTS_DIR, "meta.json");
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as RunMeta) : null;
}

const SPEND_FILE = (): string => path.join(RESULTS_DIR, "spend.json");

/**
 * Model spend tracked in-process so far in this run (all files).
 * @returns USD
 */
export function spentSoFar(): number {
  try {
    return (JSON.parse(fs.readFileSync(SPEND_FILE(), "utf8")) as { usd: number }).usd;
  } catch {
    return 0;
  }
}

/**
 * Add model spend to the run ledger (best-effort; Jest runs in band, so no lock is needed).
 * @param usd amount
 */
export function addSpend(usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(SPEND_FILE(), JSON.stringify({ usd: spentSoFar() + usd }));
}

/**
 * Percentile of a sample (nearest rank).
 * @param xs values
 * @param p 0–100
 * @returns the value, or null for an empty sample
 */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[k] ?? null;
}
