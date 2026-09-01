import { describe, expect, it } from "vitest";
import { packPlan } from "./pack.mjs";
// @ts-expect-error — CJS hook module; vitest interops the named export fine.
import { notarizeDecision } from "./notarize.cjs";

describe("packPlan — sign iff a credential is in the env (Plan 15 W3)", () => {
  const argv = ["--mac", "dmg", "zip", "--publish", "never"];

  it("no credentials: UNSIGNED — identity=null appended, argv otherwise untouched", () => {
    const p = packPlan({}, argv);
    expect(p.signing).toBe(false);
    expect(p.args).toEqual([...argv, "-c.mac.identity=null"]);
  });

  it("empty-string credentials count as absent — an empty CSC_LINK must not flip the build to signing", () => {
    expect(packPlan({ CSC_LINK: "", CSC_NAME: "" }, argv).signing).toBe(false);
  });

  it("CSC_LINK alone enables signing and drops the identity override", () => {
    const p = packPlan({ CSC_LINK: "base64…" }, argv);
    expect(p.signing).toBe(true);
    expect(p.args).toEqual(argv);
  });

  it("CSC_NAME (keychain identity) also enables signing", () => {
    expect(packPlan({ CSC_NAME: "Developer ID Application: Carlton Aikins (TEAM)" }, argv).signing).toBe(true);
  });

  it("does not mutate the argv it was given", () => {
    const original = [...argv];
    packPlan({}, argv);
    expect(argv).toEqual(original);
  });
});

describe("notarizeDecision — no-op loudly unless EVERYTHING needed is present", () => {
  const apple = { APPLE_ID: "carlton@charmtechnologies.co", APPLE_APP_SPECIFIC_PASSWORD: "xxxx-xxxx", APPLE_TEAM_ID: "TEAMID1234" };

  it("unsigned build: skips, and the reason says an unsigned app cannot be notarized (not a var list)", () => {
    const d = notarizeDecision({ ...apple });
    expect(d.run).toBe(false);
    expect(d.reason).toMatch(/not being signed/);
  });

  it("signed but missing Apple vars: skips, naming EVERY missing var — not just the first", () => {
    const d = notarizeDecision({ CSC_LINK: "x", APPLE_ID: "a@b.c" });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("APPLE_APP_SPECIFIC_PASSWORD");
    expect(d.reason).toContain("APPLE_TEAM_ID");
    expect(d.reason).not.toContain("APPLE_ID,");
  });

  it("empty-string Apple vars count as missing", () => {
    const d = notarizeDecision({ CSC_LINK: "x", ...apple, APPLE_TEAM_ID: "" });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("APPLE_TEAM_ID");
  });

  it("signed + all three Apple vars: runs — this is the zero-code-change activation", () => {
    expect(notarizeDecision({ CSC_LINK: "x", ...apple })).toEqual({ run: true });
    expect(notarizeDecision({ CSC_NAME: "Developer ID Application: …", ...apple })).toEqual({ run: true });
  });
});
