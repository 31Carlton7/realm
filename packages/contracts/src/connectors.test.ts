import { describe, expect, it } from "vitest";
import { CONNECTORS, OAUTH_RELAY_URL, relayState, relayTarget } from "./connectors";

describe("the OAuth relay", () => {
  it("bounces a relayed callback to the loopback port the state names, code and state intact", () => {
    const state = relayState(8788, "abcdefghijklmnop_ABC-123");
    expect(relayTarget(state, "c0de", null)).toBe(`http://127.0.0.1:8788/oauth/callback?state=${state}&code=c0de`);
    expect(relayTarget(state, null, "access_denied")).toBe(`http://127.0.0.1:8788/oauth/callback?state=${state}&error=access_denied`);
  });

  it("is not an open redirector: a state without a plausible port goes nowhere", () => {
    /* The page is public. The mutant: redirect wherever `state` says. Only a loopback port ever
       comes out of this, and only for a state shaped like the one Realm minted. */
    for (const bad of [null, "", "nonce-only", "80.abcdefghijklmnop", "70000.abcdefghijklmnop", "8788.short", "8788.abcdefghijklmnop/../x"]) {
      expect(relayTarget(bad, "c", null)).toBeNull();
    }
  });

  it("names the relay on every connector that needs an app of the user's own", () => {
    for (const c of CONNECTORS.filter((c) => c.oauth === "app")) {
      expect(c.app?.steps.some((s) => s.includes(OAUTH_RELAY_URL)), c.id).toBe(true);
    }
  });
});
