import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { cloudRunOutcome, exportOptionsPlist, ipaProblems, isBetaXcode, marketingVersion, nextBuildNumber, parseIosReleaseArgs } from "./ios-release.mjs";

describe("parseIosReleaseArgs", () => {
  it("defaults to asking App Store Connect, uploading, for real, with the selected Xcode", () => {
    expect(parseIosReleaseArgs([])).toEqual({ build: null, notes: null, xcode: null, cloud: false, skipUpload: false, dryRun: false });
  });
  it("takes a build number, an Xcode, notes, and the two switches", () => {
    expect(parseIosReleaseArgs(["--build", "12", "--xcode", "/Applications/Xcode-27.0.0.app/", "--notes", "Pairing from Settings", "--skip-upload", "--dry-run"])).toEqual({
      build: 12, xcode: "/Applications/Xcode-27.0.0.app", notes: "Pairing from Settings", cloud: false, skipUpload: true, dryRun: true,
    });
  });
  it("takes --cloud with --dry-run, and refuses what only a build on this Mac could use", () => {
    expect(parseIosReleaseArgs(["--cloud", "--dry-run"])).toMatchObject({ cloud: true, dryRun: true });
    expect(() => parseIosReleaseArgs(["--cloud", "--build", "3"])).toThrow(/--cloud builds in Xcode Cloud, so --build cannot apply/);
    expect(() => parseIosReleaseArgs(["--cloud", "--xcode", "/Applications/Xcode.app"])).toThrow(/so --xcode cannot apply/);
    expect(() => parseIosReleaseArgs(["--cloud", "--notes", "hi", "--skip-upload"])).toThrow(/so --notes and --skip-upload cannot apply/);
  });
  it("refuses a build number that is not a whole number above 0", () => {
    for (const bad of ["0", "-3", "1.5", "07", "seven"]) expect(() => parseIosReleaseArgs(["--build", bad])).toThrow(/--build must be/);
  });
  it("refuses a flag left without its value, and unknown flags", () => {
    expect(() => parseIosReleaseArgs(["--build"])).toThrow(/--build needs a value/);
    expect(() => parseIosReleaseArgs(["--notes", "--dry-run"])).toThrow(/--notes needs a value/);
    expect(() => parseIosReleaseArgs(["--xcode"])).toThrow(/--xcode needs a value/);
    expect(() => parseIosReleaseArgs(["--upload"])).toThrow(/unknown flag --upload/);
  });
});

describe("nextBuildNumber", () => {
  const builds = (...versions: unknown[]) => versions.map((version) => ({ attributes: { version } }));
  it("starts at 1 for an app with no builds", () => {
    expect(nextBuildNumber([])).toBe(1);
  });
  it("is one past the highest, compared as numbers, across every version and state", () => {
    expect(nextBuildNumber(builds("3", "12", "9"))).toBe(13);
  });
  it("ignores build numbers it did not make", () => {
    expect(nextBuildNumber(builds("4", "1.2.3", null, undefined))).toBe(5);
    expect(nextBuildNumber([{}, null, { attributes: {} }])).toBe(1);
  });
});

describe("marketingVersion", () => {
  it("reads MARKETING_VERSION, quoted or not", () => {
    expect(marketingVersion('settings:\n  base:\n    MARKETING_VERSION: "0.1"\n')).toBe("0.1");
    expect(marketingVersion("    MARKETING_VERSION: 1.2.0\n")).toBe("1.2.0");
  });
  it("refuses a project with none, or with two", () => {
    expect(() => marketingVersion("name: Realm\n")).toThrow(/found 0/);
    expect(() => marketingVersion('MARKETING_VERSION: "0.1"\nMARKETING_VERSION: "0.2"\n')).toThrow(/found 2/);
  });
});

describe("isBetaXcode", () => {
  it("knows a beta by its name on disk", () => {
    expect(isBetaXcode("/Applications/Xcode-27.0.0-Beta.6.app/Contents/Developer")).toBe(true);
    expect(isBetaXcode("/Applications/Xcode-beta.app/Contents/Developer")).toBe(true);
    expect(isBetaXcode("/Applications/Xcode.app/Contents/Developer")).toBe(false);
  });
});

describe("exportOptionsPlist", () => {
  const plist = exportOptionsPlist("FY9QB79VAP");
  it.runIf(process.platform === "darwin")("is a property list Xcode can read, exporting an App Store Connect IPA locally", () => {
    const parsed = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: plist, encoding: "utf8" }));
    expect(parsed).toEqual({
      method: "app-store-connect", destination: "export", teamID: "FY9QB79VAP", signingStyle: "automatic",
      uploadSymbols: true, manageAppVersionAndBuildNumber: false,
    });
  });
});

describe("ipaProblems", () => {
  const expected = { version: "0.1", build: 4, teamId: "FY9QB79VAP" };
  const good = {
    version: "0.1", build: "4", hasExtension: true, apsEnvironment: "production",
    authority: "Apple Distribution: Carlton Aikins (FY9QB79VAP)", encryptionDeclared: false,
  };
  it("passes a distribution-signed production build with its extension", () => {
    expect(ipaProblems(good, expected)).toEqual([]);
  });
  it("names each thing that would make the upload wrong", () => {
    const cases: Array<[Partial<typeof good> & Record<string, unknown>, RegExp]> = [
      [{ version: "0.2" }, /version is 0.2, expected 0.1/],
      [{ build: "1" }, /build number is 1, expected 4/],
      [{ hasExtension: false }, /notification extension/],
      [{ apsEnvironment: "development" }, /aps-environment is development/],
      [{ apsEnvironment: null }, /aps-environment is missing/],
      [{ authority: "Apple Development: Carlton Aikins (2ZNEBDL6TW)" }, /signed by Apple Development/],
      [{ authority: "Apple Development: Carlton Aikins (FY9QB79VAP)" }, /signed by Apple Development/],
      [{ authority: "Apple Distribution: Someone Else (AAAAAAAAAA)" }, /expected the team's Apple Distribution/],
      [{ authority: null }, /signed by nobody/],
      [{ encryptionDeclared: null }, /ITSAppUsesNonExemptEncryption/],
      [{ encryptionDeclared: true }, /ITSAppUsesNonExemptEncryption/],
    ];
    for (const [change, problem] of cases) {
      const problems = ipaProblems({ ...good, ...change }, expected);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(problem);
    }
  });
});

describe("cloudRunOutcome", () => {
  // As asc 3.5.1 prints it (build run 2, trimmed).
  const run = (completionStatus: string | undefined) => ({ buildRunId: "8c26f312", buildNumber: 2, executionProgress: "COMPLETE", completionStatus, startReason: "MANUAL" });
  it("reads the run asc started, and that it built", () => {
    expect(cloudRunOutcome(run("SUCCEEDED"))).toEqual({ runId: "8c26f312", number: 2, status: "SUCCEEDED", succeeded: true });
  });
  it("reads the API's own shape too", () => {
    expect(cloudRunOutcome({ data: { id: "4400c480", attributes: { number: 1, completionStatus: "SUCCEEDED" } } })).toEqual({ runId: "4400c480", number: 1, status: "SUCCEEDED", succeeded: true });
  });
  it("calls anything but SUCCEEDED a failure, including no answer yet", () => {
    for (const status of ["FAILED", "ERRORED", "CANCELED", "SKIPPED", undefined]) expect(cloudRunOutcome(run(status)).succeeded).toBe(false);
  });
  it("refuses output that names no run", () => {
    expect(() => cloudRunOutcome({})).toThrow(/did not say which Xcode Cloud run/);
  });
});
