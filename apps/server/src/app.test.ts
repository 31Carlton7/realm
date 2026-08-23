import { describe, it, expect } from "vitest";
import { defaultAdapters } from "./app";

describe("defaultAdapters", () => {
  it("registers claude and codex by default", () => {
    const reg = defaultAdapters();
    expect(Object.keys(reg).sort()).toContain("codex");
    expect(reg.codex?.kind).toBe("codex");
  });
  it("only registers the fake agent behind the env flag", () => {
    const before = process.env.REALM_ENABLE_FAKE_AGENT;
    try {
      delete process.env.REALM_ENABLE_FAKE_AGENT;
      expect(defaultAdapters().fake).toBeUndefined();
      process.env.REALM_ENABLE_FAKE_AGENT = "1";
      expect(defaultAdapters().fake).toBeDefined();
    } finally {
      // A failed assertion would otherwise leave the flag set for every later test in this process.
      if (before === undefined) delete process.env.REALM_ENABLE_FAKE_AGENT;
      else process.env.REALM_ENABLE_FAKE_AGENT = before;
    }
  });

  it("registers both ACP agents with their own launch commands", () => {
    const reg = defaultAdapters();
    expect(reg["acp:cursor"]?.kind).toBe("acp:cursor");
    expect(reg["acp:gemini"]?.kind).toBe("acp:gemini");
  });
});
