import "server-only";
// OWNER: 1.3

/**
 * Per-run alias table (master plan §1.0.4, §1.4 `AliasTable`; V2-04 §2.5). Pure.
 *
 * alias = `<kind>_` + first 8 hex of the id (a UUID without dashes; any other id — e.g. a Gmail id —
 * via sha256), +2 hex on collision. Aliases are stable across turns (cached history stays
 * byte-identical) and only aliases minted in this run ("shown") resolve, which blocks hallucinated
 * ids and cross-user guessing. Attachments are `m_xxxxxxxx:<index>` and resolve to `<id>:<index>`.
 */
import { createHash } from "node:crypto";
import type { AliasKind, AliasTable as AliasTableContract } from "@/server/agent/types";

const KINDS: ReadonlySet<string> = new Set<AliasKind>(["m", "x", "t", "a", "p", "f", "r", "e", "s"]);
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const ALIAS_RE = /^([a-z])_([0-9a-f]{8,10})(?::(\d{1,3}))?$/;
const BASE_HEX = 8;
const COLLISION_HEX = 10;

/** Hex digest used for an id: the UUID's own hex, or sha256 of anything else. */
function hexOf(id: string): string {
  if (UUID_RE.test(id)) return id.replace(/-/g, "").toLowerCase();
  return createHash("sha256").update(id, "utf8").digest("hex");
}

/** Resolved attachment reference. */
export interface AttachmentRef {
  messageId: string;
  index: number;
}

/** In-memory alias table for one agent run. */
export class AliasTable implements AliasTableContract {
  private readonly byAlias = new Map<string, { kind: AliasKind; id: string }>();
  private readonly byKey = new Map<string, string>();

  /**
   * Alias for `id` (same alias every time for the same kind + id). Marks it shown.
   * @param kind alias kind prefix
   * @param id row UUID or external id
   * @returns e.g. `t_1a2b3c4d` (10 hex on a collision)
   * @throws Error on an unknown kind, empty id, or a 10-hex collision
   */
  mint(kind: AliasKind, id: string): string {
    if (!KINDS.has(kind)) throw new Error(`AliasTable.mint: unknown kind "${kind}"`);
    if (id.length === 0) throw new Error("AliasTable.mint: empty id");
    const key = `${kind}\u0000${UUID_RE.test(id) ? id.toLowerCase() : id}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const hex = hexOf(id);
    for (const len of [BASE_HEX, COLLISION_HEX]) {
      const alias = `${kind}_${hex.slice(0, len)}`;
      if (!this.byAlias.has(alias)) {
        this.byAlias.set(alias, { kind, id });
        this.byKey.set(key, alias);
        return alias;
      }
    }
    throw new Error("AliasTable.mint: unresolvable alias collision");
  }

  /**
   * Id behind an alias shown in this run. Attachment aliases (`m_xxxxxxxx:<i>`) resolve to `<id>:<i>`.
   * @param alias alias as sent by the model (surrounding whitespace / case tolerated)
   * @param kind expected kind; a mismatch resolves to null
   * @returns the id, or null when unknown, unshown or of the wrong kind
   */
  resolve(alias: string, kind?: AliasKind): string | null {
    const m = ALIAS_RE.exec(alias.trim().toLowerCase());
    if (!m) return null;
    const [, k, hex, index] = m;
    if (kind && k !== kind) return null;
    const entry = this.byAlias.get(`${k}_${hex}`);
    if (!entry) return null;
    if (index !== undefined) return entry.kind === "m" ? `${entry.id}:${Number(index)}` : null;
    return entry.id;
  }

  /**
   * Resolve an attachment alias `m_xxxxxxxx:<index>`.
   * @param alias attachment alias
   * @returns message id + index, or null
   */
  resolveAttachment(alias: string): AttachmentRef | null {
    const m = ALIAS_RE.exec(alias.trim().toLowerCase());
    if (!m || m[1] !== "m" || m[3] === undefined) return null;
    const messageId = this.resolve(`m_${m[2]}`, "m");
    return messageId ? { messageId, index: Number(m[3]) } : null;
  }

  /**
   * Whether an alias was shown (minted) in this run.
   * @param alias alias (attachment suffix allowed)
   * @returns true if it resolves
   */
  shown(alias: string): boolean {
    return this.resolve(alias) !== null;
  }
}
