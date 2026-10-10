/**
 * Manual prompt-cache check (task 1.3; V2-04 §11 T1): two identical-prefix Haiku calls through
 * `callModel` on the `chat` route (BP1 on the static system prompt, 1h TTL). The second call must
 * report `cache_read_input_tokens > 0`. Costs well under $0.001.
 *
 * Run: npx tsx --conditions=react-server --env-file=.env.local scripts/check-llm-cache.ts
 * (`react-server` lets `import "server-only"` resolve outside Next.)
 *
 * The two `llm_calls` rows it logs are tagged with a nonce and deleted at the end.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { callModel, type LlmResponse } from "@/server/llm";

const nonce = randomUUID();

/** ~2.5K-token static prefix (Haiku 5.5's minimum cacheable prefix is 512 tokens). The nonce forces a fresh write. */
const SYSTEM = [
  `Cache check ${nonce}.`,
  "You are a terse assistant used only for an automated prompt-cache check. Reply with one word.",
  ...Array.from(
    { length: 120 },
    (_, i) => `Rule ${i + 1}: keep replies short, never include dates or ids, and answer only the final question asked.`,
  ),
].join("\n");

function line(label: string, r: LlmResponse): string {
  const u = r.usage;
  return `${label}: in=${u.inputTokens} cache_write=${u.cacheWriteTokens} cache_read_input_tokens=${u.cacheReadTokens} out=${u.outputTokens} thinking=${u.thinkingTokens} cost=$${u.costUsd.toFixed(6)} ${r.latencyMs}ms stop=${r.stopReason}`;
}

async function main(): Promise<void> {
  const call = (q: string): Promise<LlmResponse> =>
    callModel({ route: "chat", system: SYSTEM, messages: [{ role: "user", content: q }], log: { meta: { script: "check-llm-cache", nonce } } });

  const first = await call("Say ok.");
  console.log(line("call 1", first));
  const second = await call("Say yes.");
  console.log(line("call 2", second));
  const total = first.usage.costUsd + second.usage.costUsd;
  console.log(`total cost=$${total.toFixed(6)}`);

  const { error } = await db().from("llm_calls").delete().eq("meta->>nonce", nonce);
  console.log(error ? `cleanup failed: ${error.code}` : "cleanup: llm_calls rows deleted");

  if (second.usage.cacheReadTokens > 0) {
    console.log("PASS: cache_read_input_tokens > 0 on the second call");
  } else {
    console.log("FAIL: no cache read on the second call");
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : "unknown error");
  process.exitCode = 1;
});
