import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_FILLS_KEPT } from "@realm/contracts";
import { tempDir } from "@realm/test-utils";
import { AgentSignins } from "./agent-signins";

/**
 * The mutants: the switch on by default, or on for a file that says anything but `true`; a log that
 * grows without end, or keeps the oldest; a fill that loses the switch, or the switch the fills.
 */
const file = () => join(tempDir("realm-agent-signins-"), "agent-signins.json");

describe("AgentSignins", () => {
  it("is off by default, with nothing filled", () => {
    expect(new AgentSignins(file()).status()).toEqual({ enabled: false, fills: [] });
  });

  it("treats a file that says anything but true as off", () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ enabled: "yes", fills: [{ site: "https://example.com", kind: "password", at: 1, sessionId: "s1" }, { site: 7 }] }));
    expect(new AgentSignins(f).status()).toEqual({ enabled: false, fills: [{ site: "https://example.com", kind: "password", at: 1, sessionId: "s1" }] });
  });

  it("keeps the switch and the newest fills across a relaunch", () => {
    const f = file();
    let t = 0;
    const signins = new AgentSignins(f, () => ++t);
    signins.setEnabled(true);
    for (let i = 0; i < AGENT_FILLS_KEPT + 5; i++) signins.record({ site: `https://site${i}.example`, kind: "code", sessionId: "s1" });
    const relaunched = new AgentSignins(f).status();
    expect(relaunched.enabled).toBe(true);
    expect(relaunched.fills).toHaveLength(AGENT_FILLS_KEPT);
    expect(relaunched.fills[0]).toEqual({ site: `https://site${AGENT_FILLS_KEPT + 4}.example`, kind: "code", at: AGENT_FILLS_KEPT + 5, sessionId: "s1" });
    expect(relaunched.fills.at(-1)!.site).toBe("https://site5.example");
    // Turning it off keeps the record of what was filled while it was on.
    signins.setEnabled(false);
    expect(new AgentSignins(f).status().fills).toHaveLength(AGENT_FILLS_KEPT);
    expect(Object.keys(JSON.parse(readFileSync(f, "utf8")).fills[0]).sort()).toEqual(["at", "kind", "sessionId", "site"]);
  });
});
