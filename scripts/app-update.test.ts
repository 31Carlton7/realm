import { describe, expect, it } from "vitest";
import { localSigningEnv, parseEnvFile } from "./app-update.mjs";

/**
 * `pnpm app:update` signing a local build with the owner's Developer ID, from the release's own
 * signing file. What must die: a local build left unsigned when the file names an identity (the
 * owner's grants reset on every install), and a local build notarized (every build uploaded to Apple).
 */
const FILE = `# Realm signing — the release reads this too
export CSC_NAME="Developer ID Application: Carlton Aikins (FY9QB79VAP)"
export APPLE_KEYCHAIN_PROFILE=realm-notary
`;

describe("the environment a local build is made in", () => {
  it("reads export lines, strips quotes, and skips comments", () => {
    expect(parseEnvFile(FILE)).toEqual({ CSC_NAME: "Developer ID Application: Carlton Aikins (FY9QB79VAP)", APPLE_KEYCHAIN_PROFILE: "realm-notary" });
    expect(parseEnvFile("A='one'\nB=two\n  # C=three\nnot a line")).toEqual({ A: "one", B: "two" });
  });

  it("signs with the file's identity and never notarizes", () => {
    const { env, signing } = localSigningEnv(FILE, { PATH: "/usr/bin", APPLE_ID: "me@example.com" });
    // THE MUTANT: leave the identity out. The build is unsigned and every install resets the grants.
    expect(signing).toBe(true);
    expect(env.CSC_NAME).toBe("Developer ID Application: Carlton Aikins (FY9QB79VAP)");
    // THE MUTANT: pass the notary profile through. notarize.cjs would upload every local build.
    expect(env.APPLE_KEYCHAIN_PROFILE).toBeUndefined();
    expect(env.APPLE_ID).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("keeps an identity already in the environment, and is unsigned with none anywhere", () => {
    expect(localSigningEnv(FILE, { CSC_NAME: "Mine" }).env.CSC_NAME).toBe("Mine");
    expect(localSigningEnv("", {})).toEqual({ env: {}, signing: false });
    expect(localSigningEnv("export APPLE_KEYCHAIN_PROFILE=x\n", {}).signing).toBe(false);
  });
});
