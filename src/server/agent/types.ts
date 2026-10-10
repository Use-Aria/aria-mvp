import "server-only";
// OWNER: 0.2 (frozen contract; only the orchestrator edits this file — master plan §1.0.2)

/**
 * Agent tool context and alias contracts (master plan §1.4).
 * Every id the model sees or sends is an alias (`AliasTable`); tools never accept raw UUIDs.
 */
import type { ChannelContext } from "@/server/channels/types";
import type { AgentTrigger } from "@/server/pipeline/types";
import type { UntrustedSource } from "@/server/agent/untrusted";

export type { UntrustedSource } from "@/server/agent/untrusted";
export type { AgentTrigger } from "@/server/pipeline/types";

export type AliasKind = "m" | "x" | "t" | "a" | "p" | "f" | "r" | "e" | "s";
/** alias = `${kind}_` + first 8 hex (uuid without dashes, or sha256(id) for non-uuid ids like Gmail ids);
 *  +2 hex on collision. Attachments: `m_xxxxxxxx:<index>`. */
export interface AliasTable {
  mint(kind: AliasKind, id: string): string;
  resolve(alias: string, kind?: AliasKind): string | null;
  shown(alias: string): boolean;
}
export interface LinkSlots {
  /** returns a handle like "L1" */
  add(url: string): string;
  resolve(handle: string): string | null;
}
export interface ToolCtx {
  userId: string;
  runId: string;
  now: Date;
  timezone: string;
  channel: ChannelContext;
  trigger: AgentTrigger;
  aliases: AliasTable;
  /** m_/x_ aliases of this run's user-authored batch */
  evidence: ReadonlySet<string>;
  /** concatenated user-authored inbound text of this run (V2-07 recipient check) */
  userText: string;
  taint: { readonly tainted: boolean; mark(source: UntrustedSource): void };
  links: LinkSlots;
  interim: { readonly sent: boolean; send(text: string): Promise<boolean> };
  signal: AbortSignal;
  log(event: string, data?: Record<string, string | number | boolean>): void;
}
