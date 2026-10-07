import { describe, expect, it } from "vitest";
import { memorySupportNote } from "./memory";

describe("memorySupportNote", () => {
  it("always names the agent, so a note rendered for the wrong session is visibly wrong", () => {
    expect(memorySupportNote("claude")).toContain("Claude");
    expect(memorySupportNote("codex")).toContain("Codex");
    expect(memorySupportNote("acp:cursor")).toContain("Cursor");
  });

  it("states the Cursor reality outright rather than hedging", () => {
    expect(memorySupportNote("acp:cursor")).toMatch(/no per-session context/);
  });
});

