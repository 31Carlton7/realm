import { describe, expect, it } from "vitest";
import { fastestModel, quickChatModelOf } from "./quick-chat";

const claude = { kind: "claude" as const, available: true, loggedIn: true,
  models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }, { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" }, { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }] };
const codex = { kind: "codex" as const, available: true, loggedIn: true,
  models: [{ id: "gpt-6", label: "GPT-6" }, { id: "gpt-6-mini", label: "GPT-6 mini" }] };
const both = ["claude", "codex"] as const;

describe("quickChatModelOf", () => {
  it("starts on Claude's newest Haiku when Claude is signed in", () => {
    expect(quickChatModelOf(undefined, [claude, codex], both)).toEqual({ agentKind: "claude", model: "claude-haiku-5-5" });
  });

  it("starts on the next ready agent's quick model when Claude is signed out", () => {
    expect(quickChatModelOf(null, [{ ...claude, loggedIn: false }, codex], both)).toEqual({ agentKind: "codex", model: "gpt-6-mini" });
  });

  it("takes the stored choice over the default, null model included", () => {
    expect(quickChatModelOf({ agentKind: "codex", model: "gpt-6" }, [claude, codex], both)).toEqual({ agentKind: "codex", model: "gpt-6" });
    expect(quickChatModelOf({ agentKind: "codex", model: null }, [claude, codex], both)).toEqual({ agentKind: "codex", model: null });
  });

  it("falls back to the default when the stored agent is not registered", () => {
    expect(quickChatModelOf({ agentKind: "acp:gemini", model: "x" }, [claude], ["claude"])).toEqual({ agentKind: "claude", model: "claude-haiku-5-5" });
    expect(quickChatModelOf({ agentKind: "nope" }, [claude], ["claude"])).toEqual({ agentKind: "claude", model: "claude-haiku-5-5" });
  });
});

describe("fastestModel", () => {
  it("reads Claude's curated list before its probe answers", () => {
    expect(fastestModel("claude", [])).toBe("claude-haiku-5-5");
  });

  it("is the CLI's default when the catalog names no quick model", () => {
    expect(fastestModel("codex", [{ ...codex, models: [{ id: "gpt-6", label: "GPT-6" }] }])).toBeNull();
  });
});
