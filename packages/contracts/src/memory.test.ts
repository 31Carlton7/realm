import { describe, expect, it } from "vitest";
import { AGENT_MEMORY_CHANNEL, MemorySourcesSchema, memorySupportNote } from "./memory";
import { AgentKindSchema } from "./entities";

describe("AGENT_MEMORY_CHANNEL", () => {
  it("covers every agent kind", () => {
    for (const kind of AgentKindSchema.options) expect(AGENT_MEMORY_CHANNEL[kind]).toBeDefined();
  });

  it("matches what was proven live: Claude and Codex have a channel, ACP agents and the fake do not", () => {
    expect(AGENT_MEMORY_CHANNEL.claude).toBe("systemPrompt");
    expect(AGENT_MEMORY_CHANNEL.codex).toBe("developerInstructions");
    expect(AGENT_MEMORY_CHANNEL["acp:cursor"]).toBe("none");
    expect(AGENT_MEMORY_CHANNEL["acp:gemini"]).toBe("none");
    expect(AGENT_MEMORY_CHANNEL.fake).toBe("none");
  });
});

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

describe("MemorySourcesSchema", () => {
  it("accepts the three honest shapes", () => {
    for (const r of [
      { agent: "claude", channel: "systemPrompt", basis: "modeled", note: "n", realmMemoryInjected: true, sources: [{ path: "/a", origin: "user", exists: true, via: "realm" }] },
      { agent: "codex", channel: "developerInstructions", basis: "reported", note: "n", realmMemoryInjected: false, sources: [{ path: "/b", origin: "reported", exists: false, via: "cli" }] },
      { agent: "acp:cursor", channel: "none", basis: "none", note: "n", realmMemoryInjected: false, sources: [] },
    ]) {
      expect(MemorySourcesSchema.safeParse(r).success).toBe(true);
    }
  });

  it("rejects a source that does not say how it reaches the session", () => {
    const r = MemorySourcesSchema.safeParse({ agent: "claude", channel: "systemPrompt", basis: "modeled", note: "n", realmMemoryInjected: false, sources: [{ path: "/a", origin: "user", exists: true }] });
    expect(r.success).toBe(false);
  });
});
