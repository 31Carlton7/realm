import { describe, expect, it } from "vitest";
import { livePresenceStandIn } from "./live-presence";

const harness = { REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_PRESENCE_LOG: "/scratch/presence.log" };

describe("livePresenceStandIn", () => {
  it("answers yes and logs the reason in an unpackaged harness", async () => {
    const lines: string[] = [];
    const prompt = livePresenceStandIn({ packaged: false, env: harness, append: (file, line) => lines.push(`${file}:${line}`) });
    expect(prompt).not.toBeNull();
    expect(await prompt!("use REVENUECAT_SECRET_KEY")).toBe(true);
    expect(lines).toEqual(["/scratch/presence.log:use REVENUECAT_SECRET_KEY\n"]);
  });

  it("is ignored by a packaged build, whatever the environment says", () => {
    expect(livePresenceStandIn({ packaged: true, env: harness })).toBeNull();
  });

  it("needs both the harness flag and a log", () => {
    expect(livePresenceStandIn({ packaged: false, env: { REALM_LIVE_PRESENCE_LOG: "/x" } })).toBeNull();
    expect(livePresenceStandIn({ packaged: false, env: { REALM_ENABLE_FAKE_AGENT: "1" } })).toBeNull();
    expect(livePresenceStandIn({ packaged: false, env: {} })).toBeNull();
  });
});
