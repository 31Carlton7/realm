import { describe, expect, it } from "vitest";
import { CREDENTIAL_2FA_LIMITS_NOTE } from "./browser-agent";
import { SECURITY_CODES_NOTE } from "./security-codes";

// browser_fill_code is preapproved behind Let agents finish sign-ins, so no agent's code fill waits on a card.
describe("what Settings says about an agent filling a code", () => {
  it("says it fills one while agent sign-ins are on, not after a card is approved", () => {
    expect(SECURITY_CODES_NOTE).not.toMatch(/approve/);
    expect(SECURITY_CODES_NOTE).toMatch(/An agent can fill a code only while Let agents finish sign-ins is on, and is never told the code\.$/);
  });

  it("says the same in the two-factor limits", () => {
    expect(CREDENTIAL_2FA_LIMITS_NOTE).not.toMatch(/approve/);
    expect(CREDENTIAL_2FA_LIMITS_NOTE).toMatch(/for an agent, only while Let agents finish sign-ins is on\./);
  });
});
