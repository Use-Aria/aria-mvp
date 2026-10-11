/**
 * Eval DSL (V2-04 §7.5 `scenario.ts`): `evalSuite` wraps a Jest `describe` with the fake Google,
 * cost collection (from `llm_calls`, BEFORE cleanup), cleanup and the zero-leftover check;
 * `evalCase` runs N samples of a stochastic case and passes when at least `minPass` samples pass
 * (gate cases: every sample). Each sample gets its own throwaway users.
 */
import { createEvalUser, cleanup, leftovers, llmRowsForTracked, settle, tracked, type EvalUser, type UserOptions } from "./seed";
import { HAS_MODEL_KEY } from "./env";
import { installFakeGoogle, strayGoogleCalls, uninstallFakeGoogle } from "./fake-google";
import { judge, type Verdict } from "./judge";
import { runTurn, type TurnOptions, type TurnOutcome } from "./driver";
import { MAX_USD, spentSoFar, writeSuite, type CaseRecord, type SampleRecord, type SuiteCost } from "./results";

/**
 * Jest outcome policy: gate cases (injection) and leftover rows always fail the run; a non-gate
 * case below its threshold is reported (console + BASELINE.md) but fails the run only with
 * `EVAL_STRICT=1`. Evals track quality; gates protect the friend-protections.
 */
const STRICT = process.env.EVAL_STRICT === "1";

/** Samples run concurrently within a case (`EVAL_CONCURRENCY`, default 3). */
const CONCURRENCY = Math.max(1, Number(process.env.EVAL_CONCURRENCY ?? "3"));

/** Thrown by `Sample.exercised` when the model never saw the content under test (sample re-run). */
export class NotExercisedError extends Error {
  constructor(what: string) {
    super(`not exercised: ${what}`);
    this.name = "NotExercisedError";
  }
}

/** A sample that never put the content under test in front of the model is re-run this often. */
const EXERCISE_RETRIES = 2;

/** One sample's working context. */
export class Sample {
  readonly failures: string[] = [];
  readonly latencies: number[] = [];
  /** one line per turn (tools called + clipped reply), printed with failures only */
  readonly trace: string[] = [];
  /** informational markers (reported as counts per case; never affect pass/fail) */
  readonly tags: string[] = [];

  constructor(
    readonly caseName: string,
    readonly index: number,
  ) {}

  /**
   * A throwaway user for this sample.
   * @param o user options
   * @returns the user
   */
  user(o: UserOptions = {}): Promise<EvalUser> {
    return createEvalUser(this.caseName, o);
  }

  /**
   * One direct-mode agent turn; a turn error is recorded as a failure.
   * @param u eval user
   * @param texts the batch
   * @param o turn options
   * @returns the outcome
   */
  async turn(u: EvalUser, texts: string | string[], o?: TurnOptions): Promise<TurnOutcome> {
    const t = await runTurn(u, texts, o);
    this.latencies.push(t.latencyMs);
    const said = (Array.isArray(texts) ? texts.join(" / ") : texts).slice(0, 60);
    this.trace.push(`"${said}" → tools [${t.toolUses.map((x) => x.name).join(", ")}] reply "${t.bubbles.join(" / ").replace(/\s+/g, " ").slice(0, 200)}"`);
    if (t.error) this.fail(`turn error: ${t.error}`);
    return t;
  }

  /**
   * Soft assertion.
   * @param cond must be true
   * @param msg failure message
   * @returns cond
   */
  check(cond: boolean, msg: string): boolean {
    if (!cond) this.fail(msg);
    return cond;
  }

  /**
   * Require that the content under test reached the model; otherwise the sample is re-run
   * (up to 2 times) instead of counting as a pass or a fail.
   * @param cond the content was in the prompt
   * @param what description for the failure message
   * @throws NotExercisedError when `cond` is false
   */
  exercised(cond: boolean, what: string): void {
    if (!cond) throw new NotExercisedError(what);
  }

  /**
   * Record an informational marker for the report (e.g. "s_alias").
   * @param name marker
   */
  tag(name: string): void {
    if (!this.tags.includes(name)) this.tags.push(name);
  }

  /**
   * Record a failure.
   * @param msg message (keep it short; clipped to 240 chars)
   */
  fail(msg: string): void {
    this.failures.push(msg.replace(/\s+/g, " ").slice(0, 240));
  }

  /**
   * Judge the exchange; a failing verdict is recorded.
   * @param u eval user (cost attribution)
   * @param rubric what must hold
   * @param transcript the exchange
   * @returns the verdict
   */
  async judge(u: EvalUser, rubric: string, transcript: string): Promise<Verdict> {
    const v = await judge(u.id, rubric, transcript);
    if (!v.pass) this.fail(`judge: ${v.reason}`);
    return v;
  }
}

/** Case options. */
export interface CaseSpec {
  name: string;
  /** samples (default 1) */
  samples?: number;
  /** samples that must pass (default: all) */
  minPass?: number;
  /** gate: every sample must pass (injection suite) */
  gate?: boolean;
}

let currentSuite = "";
const cases: CaseRecord[] = [];

/**
 * Render a transcript for the judge / failure messages.
 * @param turns [student text, turn] pairs
 * @returns "student: …\naria: …" lines
 */
export function transcript(turns: [string | string[], TurnOutcome][]): string {
  return turns
    .map(([u, t]) => [...(Array.isArray(u) ? u : [u]).map((x) => `student: ${x}`), ...t.bubbles.map((b) => `aria: ${b}`)].join("\n"))
    .join("\n");
}

/**
 * Register one eval case.
 * @param spec name, samples, threshold
 * @param fn one sample
 */
export function evalCase(spec: CaseSpec, fn: (s: Sample) => Promise<void>): void {
  const n = spec.samples ?? 1;
  const minPass = spec.gate ? n : (spec.minPass ?? n);
  it(`${spec.name} (${minPass}/${n})`, async () => {
    const results: SampleRecord[] = new Array(n);
    const traces: string[][] = new Array(n);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < n) {
        const i = next++;
        if (spentSoFar() > MAX_USD) {
          results[i] = { pass: false, skipped: true, failures: [`spend cap $${MAX_USD} reached`], turnLatencyMs: [], reruns: 0, tags: [] };
          continue;
        }
        let s = new Sample(spec.name, i);
        let reruns = 0;
        for (let attempt = 0; ; attempt += 1) {
          try {
            await fn(s);
          } catch (e) {
            if (e instanceof NotExercisedError && attempt < EXERCISE_RETRIES && spentSoFar() <= MAX_USD) {
              s = new Sample(spec.name, i);
              reruns += 1;
              continue;
            }
            s.fail(e instanceof NotExercisedError ? e.message : `threw: ${e instanceof Error ? e.message : String(e)}`);
          }
          break;
        }
        results[i] = { pass: s.failures.length === 0, skipped: false, failures: s.failures, turnLatencyMs: s.latencies, reruns, tags: s.tags };
        if (s.failures.length > 0) {
          traces[i] = s.trace;
          results[i] = { ...results[i], trace: s.trace } as SampleRecord;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, n) }, worker));
    const passes = results.filter((r) => r.pass).length;
    const passed = passes >= minPass && !results.some((r) => r.skipped);
    cases.push({ suite: currentSuite, name: spec.name, samples: results, minPass, gate: Boolean(spec.gate), passed, costUsd: 0, llmCalls: 0 });
    const detail = results
      .map((r, i) => (r.pass ? null : `sample ${i + 1}: ${r.failures.join(" | ")}${traces[i]?.length ? `\n    ${traces[i]?.join("\n    ")}` : ""}`))
      .filter((x): x is string => x !== null)
      .join("\n");
    if (detail) console.warn(`[evals] ${spec.name}: ${passes}/${n} passed${passed ? "" : ` — BELOW THRESHOLD ${minPass}/${n}`}\n${detail}`);
    if (!spec.gate && !STRICT) return;
    expect({ case: spec.name, passes, minPass, failures: passed ? [] : detail.split("\n") }).toEqual({
      case: spec.name,
      passes: expect.any(Number),
      minPass,
      failures: [],
    });
  });
}

function emptyCost(): SuiteCost {
  return { costUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, byRoute: {}, models: [], callLatencyMs: [] };
}

/**
 * Register an eval suite (one per file).
 * @param suite suite name (report key)
 * @param file file name (report)
 * @param body the cases
 */
export function evalSuite(suite: string, file: string, body: () => void): void {
  if (!HAS_MODEL_KEY) {
    console.warn(`[evals] ${suite}: SKIPPED — ANTHROPIC_API_KEY is not set (export it to run the evals; Jest does not read .env.local)`);
    describe.skip(suite, body);
    return;
  }
  describe(suite, () => {
    const quiet: jest.SpyInstance[] = [];
    beforeAll(() => {
      currentSuite = suite;
      installFakeGoogle();
      // Agent/tool info logs are codes and ids only, but noisy; warnings and errors stay visible.
      for (const m of ["info", "log", "debug"] as const) quiet.push(jest.spyOn(console, m).mockImplementation(() => undefined));
    });

    afterAll(async () => {
      await settle();
      // Cost report from llm_calls, queried before anything is deleted.
      const rows = await llmRowsForTracked();
      const { runOwner, labels } = tracked();
      const cost = emptyCost();
      const perCase = new Map<string, { costUsd: number; calls: number }>();
      const models = new Set<string>();
      for (const r of rows) {
        const c = Number(r.cost_usd ?? 0);
        cost.costUsd += c;
        cost.calls += 1;
        cost.inputTokens += r.input_tokens ?? 0;
        cost.outputTokens += r.output_tokens ?? 0;
        cost.cacheRead += r.cache_read ?? 0;
        cost.cacheWrite += r.cache_write ?? 0;
        if (r.latency_ms !== null) cost.callLatencyMs.push(r.latency_ms);
        const route = r.route ?? "unknown";
        const br = cost.byRoute[route] ?? { calls: 0, costUsd: 0 };
        br.calls += 1;
        br.costUsd += c;
        cost.byRoute[route] = br;
        if (r.model) models.add(r.model);
        const owner = r.user_id ?? (r.run_id ? runOwner.get(r.run_id) : undefined);
        const label = owner ? labels.get(owner) : undefined;
        if (label) {
          const pc = perCase.get(label) ?? { costUsd: 0, calls: 0 };
          pc.costUsd += c;
          pc.calls += 1;
          perCase.set(label, pc);
        }
      }
      cost.models = [...models].sort();
      const mine = cases.filter((c) => c.suite === suite);
      for (const c of mine) {
        const pc = perCase.get(c.name);
        c.costUsd = pc?.costUsd ?? 0;
        c.llmCalls = pc?.calls ?? 0;
      }

      await cleanup();
      await settle(1500);
      let left = await leftovers();
      if (Object.keys(left).length > 0) {
        // A best-effort llm_calls insert can land after its 1.5s timeout: sweep once more.
        await cleanup();
        left = await leftovers();
      }
      writeSuite({ suite, file, finishedAt: new Date().toISOString(), cases: mine, cost, leftovers: left });
      console.warn(
        `[evals] ${suite}: ${mine.filter((c) => c.passed).length}/${mine.length} cases passed · ${cost.calls} LLM calls · $${cost.costUsd.toFixed(4)}` +
          (strayGoogleCalls.length ? ` · ${strayGoogleCalls.length} unauthenticated Google call(s)` : ""),
      );
      for (const q of quiet) q.mockRestore();
      uninstallFakeGoogle();
      expect(left).toEqual({});
    });

    body();
  });
}
