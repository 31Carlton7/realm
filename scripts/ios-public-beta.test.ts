import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findGroup, findLocale, missingForSubmission, parsePublicBetaArgs, pickBuild, publicBetaPlan, reviewNotes, TEXT_LIMIT, textProblems,
} from "./ios-public-beta.mjs";

const dir = new URL("../apps/ios/testflight/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8").trim();
const committed = JSON.parse(read("test-information.json"));
const filled = {
  ...committed,
  feedbackEmail: "beta@example.com",
  reviewContact: { firstName: "Ada", lastName: "Lovelace", phone: "+1 555 0100", email: "review@example.com" },
  demoVideoUrl: "https://example.com/realm-for-iphone.mp4",
};
const build = (version: string, over: Record<string, unknown> = {}) =>
  ({ id: `build-${version}`, attributes: { version, processingState: "VALID", expired: false, usesNonExemptEncryption: false, ...over } });
const files = { description: "/t/beta-description.txt", whatToTest: "/t/what-to-test.txt", notes: "/tmp/x/review-notes.txt" };

describe("parsePublicBetaArgs", () => {
  it("is a dry run of the newest build unless told otherwise", () => {
    expect(parsePublicBetaArgs([])).toEqual({ build: null, confirm: false });
    expect(parsePublicBetaArgs(["--build", "3", "--confirm"])).toEqual({ build: 3, confirm: true });
  });
  it("refuses a build that is not a whole number above 0, a flag without its value, and unknown flags", () => {
    for (const bad of ["0", "-1", "2.5", "03", "latest"]) expect(() => parsePublicBetaArgs(["--build", bad])).toThrow(/--build must be/);
    expect(() => parsePublicBetaArgs(["--build"])).toThrow(/--build needs a value/);
    expect(() => parsePublicBetaArgs(["--submit"])).toThrow(/unknown flag --submit/);
  });
});

describe("the public beta's words, as committed", () => {
  it("fit App Store Connect's fields", () => {
    const texts = { description: read("beta-description.txt"), whatToTest: read("what-to-test.txt"), notes: reviewNotes(read("review-notes.txt"), filled.demoVideoUrl) };
    expect(textProblems(texts)).toEqual([]);
    expect(textProblems({ long: "x".repeat(TEXT_LIMIT + 1) })).toEqual([`long is ${TEXT_LIMIT + 1} characters, over App Store Connect's ${TEXT_LIMIT}`]);
  });

  it("tell a reviewer the app needs a paired Mac, where Realm for Mac comes from, and how to pair", () => {
    const notes = read("review-notes.txt");
    for (const claim of ["https://realm.computer", "Settings ▸ Devices", "Pair an iPhone", "Scan the code", "Paste the link", "no account, no sign-in and nothing to buy"]) {
      expect(notes, claim).toContain(claim);
    }
    expect(read("beta-description.txt")).toContain("Realm 2.4 or later");
  });

  it("put the demo video's address in the notes, and say so plainly while it is unset", () => {
    expect(reviewNotes("Watch it: {demoVideoUrl}", filled.demoVideoUrl)).toBe(`Watch it: ${filled.demoVideoUrl}`);
    expect(reviewNotes("Watch it: {demoVideoUrl}", null)).toBe("Watch it: <{demoVideoUrl} is not set>");
    expect(() => reviewNotes("No video here", filled.demoVideoUrl)).toThrow(/lost its \{demoVideoUrl\}/);
  });

  it("send no one anything while the owner's own details are unset", () => {
    expect(missingForSubmission(committed).map((m: string) => m.split(":")[0])).toEqual([
      "feedbackEmail", "reviewContact.firstName", "reviewContact.lastName", "reviewContact.phone", "reviewContact.email", "demoVideoUrl",
    ]);
    expect(missingForSubmission(filled)).toEqual([]);
    expect(missingForSubmission({ ...filled, privacyPolicyUrl: "http://realm.computer/docs/privacy" })).toEqual(["privacyPolicyUrl: an https URL"]);
  });

  it("point at the privacy policy and the site, and a public group with feedback on", () => {
    expect(committed).toMatchObject({
      locale: "en-US", marketingUrl: "https://realm.computer", privacyPolicyUrl: "https://realm.computer/docs/privacy",
      group: { name: "Public Beta", feedbackEnabled: true },
    });
    expect(committed.group.publicLinkLimit).toBeGreaterThanOrEqual(1);
    expect(committed.group.publicLinkLimit).toBeLessThanOrEqual(10_000);
  });
});

describe("pickBuild", () => {
  it("takes the newest valid build, compared as numbers", () => {
    expect(pickBuild([build("2"), build("10"), build("11", { processingState: "PROCESSING" }), build("9")], null).id).toBe("build-10");
  });
  it("takes the build named, and refuses one that is not ready or not there", () => {
    expect(pickBuild([build("2"), build("3")], 2).id).toBe("build-2");
    expect(() => pickBuild([build("3", { processingState: "PROCESSING" })], 3)).toThrow(/build 3 is PROCESSING, not VALID/);
    expect(() => pickBuild([build("3", { expired: true })], 3)).toThrow(/build 3 has expired/);
    expect(() => pickBuild([build("3")], 4)).toThrow(/no build 4/);
    expect(() => pickBuild([], null)).toThrow(/no valid build/);
  });
});

describe("publicBetaPlan", () => {
  const plan = (over: Record<string, unknown> = {}) =>
    publicBetaPlan({ app: "6820452196", info: filled, build: build("3"), localization: null, reviewDetailId: "6820452196", testNotes: null, group: null, files, ...over });

  it("writes everything a first public beta needs, makes the group, and only then submits", () => {
    const steps = plan();
    expect(steps.map((s: { args: string[] }) => s.args.slice(0, 3).join(" "))).toEqual([
      "testflight app-localizations create", "testflight review edit", "builds test-notes create", "testflight groups create", "builds add-groups --build-id",
    ]);
    // The one step that sends the build to Apple is the last, and the only one marked so.
    expect(steps.filter((s: { submits?: boolean }) => s.submits)).toEqual([steps.at(-1)]);
    expect(steps.at(-1).args).toEqual(["builds", "add-groups", "--build-id", "build-3", "--group", "Public Beta", "--submit", "--confirm", "--output", "json"]);
    expect(steps[0].args).toEqual(expect.arrayContaining(["--description", "@file:/t/beta-description.txt", "--privacy-policy-url", "https://realm.computer/docs/privacy", "--feedback-email", "beta@example.com"]));
    expect(steps[1].args).toEqual(expect.arrayContaining(["--demo-account-required=false", "--notes", "@file:/tmp/x/review-notes.txt", "--contact-phone", "+1 555 0100"]));
    expect(steps[3].args).toEqual(expect.arrayContaining(["--public-link-enabled", "--public-link-limit-enabled", "--public-link-limit", "1000", "--feedback-enabled"]));
  });

  it("updates what is already there, and leaves a group that exists alone", () => {
    const steps = plan({ localization: { id: "loc-1" }, testNotes: { id: "notes-1" }, group: { id: "group-1" } });
    expect(steps.map((s: { args: string[] }) => s.args.slice(0, 3).join(" "))).toEqual([
      "testflight app-localizations update", "testflight review edit", "builds test-notes update", "builds add-groups --build-id",
    ]);
    expect(steps[0].args.slice(3, 5)).toEqual(["--id", "loc-1"]);
  });

  it("declares the encryption exempt only for a build that did not", () => {
    const steps = plan({ build: build("3", { usesNonExemptEncryption: null }) });
    expect(steps.some((s: { args: string[] }) => s.args.includes("--uses-non-exempt-encryption=false"))).toBe(true);
    expect(plan().some((s: { args: string[] }) => s.args.includes("--uses-non-exempt-encryption=false"))).toBe(false);
  });

  it("finds the external group and the locale by name, never the internal group", () => {
    const groups = [{ id: "i", attributes: { name: "Public Beta", isInternalGroup: true } }, { id: "e", attributes: { name: "Public Beta", isInternalGroup: false } }];
    expect(findGroup(groups, "Public Beta")?.id).toBe("e");
    expect(findGroup([groups[0]], "Public Beta")).toBeNull();
    expect(findLocale([{ id: "l", attributes: { locale: "en-US" } }], "en-US")?.id).toBe("l");
    expect(findLocale([], "en-US")).toBeNull();
  });
});
