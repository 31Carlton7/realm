import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  it("signed + a stored notarytool Keychain profile runs without raw Apple credentials", () => {
    expect(notarizeDecision({ CSC_NAME: "Developer ID Application: …", APPLE_KEYCHAIN_PROFILE: "realm-notary" }))
      .toEqual({ run: true });
  });

  it("an empty Keychain profile does not bypass the raw credential checks", () => {
    const d = notarizeDecision({ CSC_NAME: "Developer ID Application: …", APPLE_KEYCHAIN_PROFILE: "" });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("APPLE_ID");
  });
});

/**
 * The two packaging inputs that decide whether a macOS consent dialog can EXIST. Both fail silently
 * when wrong — no build error, no runtime error, just a prompt that never appears and a Permissions
 * page that looks broken — so they are pinned here rather than trusted to survive a tidy-up.
 */
describe("macOS consent packaging (Settings → Permissions can only work if these hold)", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const entitlements = read("../resources/entitlements.mac.plist");
  const builder = read("../electron-builder.yml");

  it("signed builds carry the apple-events entitlement — without it macOS answers -1743 and never offers the dialog", () => {
    expect(entitlements).toContain("com.apple.security.automation.apple-events");
    // The build that consumes it: hardened runtime, pointed at this exact file.
    expect(builder).toContain("hardenedRuntime: true");
    expect(builder).toContain("entitlements: resources/entitlements.mac.plist");
  });

  it("every TCC grant the mac CLI needs has its usage string — macOS refuses the EventKit/Contacts requests outright when the key is absent", () => {
    for (const key of ["NSAppleEventsUsageDescription", "NSCalendarsUsageDescription", "NSRemindersUsageDescription", "NSContactsUsageDescription"]) {
      expect(builder, `${key} missing from mac.extendInfo`).toContain(`${key}:`);
    }
  });

  it("carries macOS 14's Full* variants — with only the plain Calendars/Reminders keys the grant comes back add-only (writes land, reads return nothing)", () => {
    expect(builder).toContain("NSCalendarsFullAccessUsageDescription:");
    expect(builder).toContain("NSRemindersFullAccessUsageDescription:");
  });

  it("each usage string says what REALM does with the access — the dialog quotes it verbatim to the user", () => {
    // The mutant: Electron's boilerplate ("This app needs access to …"), which tells nobody anything.
    expect(builder).not.toMatch(/This app needs access to/);
    const strings = builder.match(/NS\w+UsageDescription: >-\n(?:\s{6}.+\n)+/g) ?? [];
    expect(strings).toHaveLength(6);
    for (const s of strings) expect(s).toContain("Realm");
  });
});
