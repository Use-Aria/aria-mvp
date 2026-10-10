/**
 * AliasTable (master plan §1.0.4; V2-04 §10.1 aliases).
 */
import { createHash } from "node:crypto";
import { AliasTable } from "@/server/agent/context/aliases";

const U1 = "3f9a2c1b-0000-4000-8000-000000000001";
const U2 = "3f9a2c1b-ffff-4000-8000-000000000002"; // same first 8 hex as U1
const U3 = "a1b2c3d4-1111-4000-8000-000000000003";

describe("AliasTable", () => {
  it("mints stable aliases from UUIDs (kind + first 8 hex)", () => {
    const a = new AliasTable();
    expect(a.mint("t", U1)).toBe("t_3f9a2c1b");
    expect(a.mint("t", U1)).toBe("t_3f9a2c1b");
    expect(new AliasTable().mint("t", U1)).toBe("t_3f9a2c1b"); // stable across runs
    expect(a.mint("m", U1)).toBe("m_3f9a2c1b"); // kinds are separate
    expect(a.mint("t", U1.toUpperCase())).toBe("t_3f9a2c1b");
  });

  it("hashes non-UUID ids (e.g. Gmail ids) with sha256", () => {
    const a = new AliasTable();
    const gmailId = "18c2f0a9b7d3e4f1";
    const hex = createHash("sha256").update(gmailId).digest("hex").slice(0, 8);
    expect(a.mint("e", gmailId)).toBe(`e_${hex}`);
    expect(a.resolve(`e_${hex}`, "e")).toBe(gmailId);
  });

  it("extends by 2 hex on collision", () => {
    const a = new AliasTable();
    expect(a.mint("t", U1)).toBe("t_3f9a2c1b");
    expect(a.mint("t", U2)).toBe("t_3f9a2c1bff");
    expect(a.resolve("t_3f9a2c1b")).toBe(U1);
    expect(a.resolve("t_3f9a2c1bff")).toBe(U2);
  });

  it("unknown or unshown aliases resolve to null", () => {
    const a = new AliasTable();
    a.mint("t", U1);
    expect(a.resolve("t_a1b2c3d4")).toBeNull(); // valid shape, never shown in this run
    expect(a.shown("t_a1b2c3d4")).toBe(false);
    expect(a.resolve(U1)).toBeNull(); // raw UUIDs are never accepted
    expect(a.resolve("t_3f9a2c1")).toBeNull();
    expect(a.resolve("")).toBeNull();
    expect(a.shown("t_3f9a2c1b")).toBe(true);
    expect(a.resolve(" T_3F9A2C1B ")).toBe(U1); // whitespace/case tolerated
  });

  it("kind mismatch resolves to null", () => {
    const a = new AliasTable();
    a.mint("t", U1);
    expect(a.resolve("t_3f9a2c1b", "r")).toBeNull();
    expect(a.resolve("t_3f9a2c1b", "t")).toBe(U1);
    expect(a.resolve("r_3f9a2c1b", "r")).toBeNull();
  });

  it("resolves attachment aliases m_xxxxxxxx:<i> only for shown messages", () => {
    const a = new AliasTable();
    a.mint("m", U3);
    expect(a.resolve("m_a1b2c3d4:0", "m")).toBe(`${U3}:0`);
    expect(a.resolveAttachment("m_a1b2c3d4:2")).toEqual({ messageId: U3, index: 2 });
    expect(a.resolveAttachment("m_a1b2c3d4")).toBeNull();
    expect(a.resolveAttachment("m_00000000:0")).toBeNull();
    a.mint("t", U1);
    expect(a.resolve("t_3f9a2c1b:0")).toBeNull(); // only messages have attachments
  });

  it("rejects bad mint input", () => {
    const a = new AliasTable();
    expect(() => a.mint("t", "")).toThrow();
    expect(() => a.mint("z" as "t", U1)).toThrow();
  });
});
