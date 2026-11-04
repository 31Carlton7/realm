import { describe, expect, it } from "vitest";
import { sessionModelLabel } from "./agents";

describe("sessionModelLabel", () => {
  const marked = [{ kind: "claude" as const, models: [{ id: "claude-fable-5-1", label: "Claude Fable 5.1" }, { id: "claude-opus-5-5", label: "Claude Opus 5.5", isDefault: true }] }];

  it("names an unpinned session by its handshake, then the probe's marked default, then Default", () => {
    expect(sessionModelLabel("claude", null, [])).toBe("Default");
    expect(sessionModelLabel("claude", null, marked)).toBe("Opus 5.5");
    expect(sessionModelLabel("claude", null, marked, "claude-sonnet-5-5[1m]")).toBe("Sonnet 5.5");
  });

  it("names a pinned model as modelLabel does, whatever an earlier turn reported", () => {
    expect(sessionModelLabel("claude", "claude-haiku-4-5", [], "claude-opus-5-5")).toBe("Haiku 4.5");
  });

  it("keeps the harness's own default name for an agent Realm lists no models for", () => {
    expect(sessionModelLabel("codex", null, [])).toBe("GPT-5.6");
    expect(sessionModelLabel("acp:cursor", null, [])).toBe("Composer");
  });
});
