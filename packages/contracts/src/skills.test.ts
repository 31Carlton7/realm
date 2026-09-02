import { describe, expect, it } from "vitest";
import { AGENT_SKILL_SUPPORT, SkillIdSchema, SkillSchema, skillSupportNote } from "./skills";
import { AGENT_META } from "./presets";
import { Methods } from "./rpc";
import type { AgentKind } from "./entities";

const kinds = Object.keys(AGENT_META) as AgentKind[];

describe("AGENT_SKILL_SUPPORT", () => {
  it("has a row for every agent kind", () => {
    expect(Object.keys(AGENT_SKILL_SUPPORT).sort()).toEqual(kinds.sort());
  });

  it("says injected only for the two agents with a proven per-invocation route", () => {
    // Cursor is the one that matters: it ships skills, so the tempting answer is `injected`. Its
    // cross-directory discovery is gated by a predicate Realm can neither read nor set, and it differed
    // between runs of the same binary — see the research §1.1.3 and the note in acp-adapter.ts.
    expect(Object.entries(AGENT_SKILL_SUPPORT).filter(([, v]) => v === "injected").map(([k]) => k).sort())
      .toEqual(["claude", "codex"]);
  });
});

describe("skillSupportNote", () => {
  it("names the agent, so a note rendered for the wrong session is visibly wrong", () => {
    for (const kind of kinds) expect(skillSupportNote(kind)).toContain(AGENT_META[kind].label);
  });

  it("says out loud that an unsupported agent will not see the library", () => {
    expect(skillSupportNote("acp:cursor")).toMatch(/will not see these skills/);
    // The injected note has to keep saying the set is CLOSED ("and only those") — that is the
    // isolation disclosure. What discovery changed is that the user's own skills can now be inside it.
    expect(skillSupportNote("claude")).toMatch(/and only those/);
    expect(skillSupportNote("claude")).toMatch(/your own installed directories/);
  });
});

describe("SkillIdSchema", () => {
  it("accepts plain directory names and rejects anything that is not one", () => {
    for (const ok of ["mac", "mac-cli", "mac_cli", "v1.2", "A1"]) expect(SkillIdSchema.safeParse(ok).success).toBe(true);
    // A path separator here would let a caller address anything on disk through `skills.setEnabled`.
    for (const bad of ["", ".hidden", "-leading", "has space", "a/b", "../escape", "a\\b"]) {
      expect(SkillIdSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("SkillSchema", () => {
  it("round-trips a listed skill and requires a reason slot even when valid", () => {
    const s = { id: "mac", name: "mac", description: "d", path: "/x/mac/SKILL.md", enabled: true, valid: true, reason: null,
      scope: { kind: "space" as const, spaceId: null },
      origin: { kind: "library" as const, key: "library", label: "Realm library", root: "/x" } };
    expect(SkillSchema.parse(s)).toEqual(s);
    expect(SkillSchema.safeParse({ ...s, reason: undefined }).success).toBe(false);
    // Origin is not optional: a row with no origin could not be grouped, and every caller now asks.
    expect(SkillSchema.safeParse({ ...s, origin: undefined }).success).toBe(false);
  });
});

describe("skills methods", () => {
  it("are registered with zod params like their neighbours", () => {
    expect(Methods["skills.list"].params.safeParse({ spaceId: "not-a-ulid" }).success).toBe(false);
    expect(Methods["skills.setEnabled"].params.safeParse({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", id: "../x", enabled: true }).success).toBe(false);
    expect(Methods["skills.setEnabled"].params.safeParse({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", id: "mac", enabled: false }).success).toBe(true);
  });
});
