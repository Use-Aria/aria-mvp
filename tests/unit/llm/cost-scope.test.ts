/**
 * `withLlmCostScope` / `reportLlmCost` (Wave 5 task 5.3, follow-up a): the agent loop attributes
 * the LLM calls a tool logs while it runs to the run's `cost_usd`.
 */
import { reportLlmCost, withLlmCostScope } from "@/server/llm/cost-scope";

describe("llm cost scope", () => {
  it("collects costs reported anywhere in the scope's async call tree", async () => {
    const got: number[] = [];
    await withLlmCostScope(
      (usd) => got.push(usd),
      async () => {
        reportLlmCost(0.01);
        await new Promise((r) => setTimeout(r, 1));
        await Promise.all([Promise.resolve().then(() => reportLlmCost(0.02)), (async () => reportLlmCost(0.03))()]);
      },
    );
    expect([...got].sort()).toEqual([0.01, 0.02, 0.03]);
  });

  it("is a no-op outside a scope and ignores zero / negative / non-finite costs", async () => {
    expect(() => reportLlmCost(1)).not.toThrow();
    const got: number[] = [];
    await withLlmCostScope(
      (usd) => got.push(usd),
      async () => {
        for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) reportLlmCost(v);
      },
    );
    expect(got).toEqual([]);
  });

  it("the innermost scope wins; scopes don't leak into sibling work", async () => {
    const outer: number[] = [];
    const inner: number[] = [];
    await withLlmCostScope(
      (u) => outer.push(u),
      async () => {
        reportLlmCost(1);
        await withLlmCostScope(
          (u) => inner.push(u),
          async () => reportLlmCost(2),
        );
        reportLlmCost(3);
      },
    );
    reportLlmCost(4);
    expect(outer).toEqual([1, 3]);
    expect(inner).toEqual([2]);
  });

  it("a throwing sink never breaks the caller; the scope returns fn's value", async () => {
    const v = await withLlmCostScope(
      () => {
        throw new Error("sink failed");
      },
      async () => {
        reportLlmCost(0.5);
        return 42;
      },
    );
    expect(v).toBe(42);
  });
});
