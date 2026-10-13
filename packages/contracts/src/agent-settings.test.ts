import { describe, expect, it } from "vitest";
import { AGENT_SETTINGS } from "./agent-settings";

describe("the settings an agent may change", () => {
  it("are exactly these five keys", () => {
    // THE MUTANT: add a key here. Anything on this list is one approved card away from an agent
    // changing it; `AGENT_SETTINGS`'s comment says what must stay off it and why.
    expect(Object.values(AGENT_SETTINGS).map((s) => s.key)).toEqual(["ui.theme", "ui.reduceMotion", "ui.submitKey", "sessions.midTurnMode", "terminals.cursorBlink"]);
  });

  it("each take a closed list of values that holds their own fallback", () => {
    for (const s of Object.values(AGENT_SETTINGS)) expect((s.values as readonly unknown[]).includes(s.fallback)).toBe(true);
  });
});
