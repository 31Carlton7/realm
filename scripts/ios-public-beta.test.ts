import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTACT_FILE, findGroup, findLocale, maskPhone, missingForSubmission, parsePublicBetaArgs, pickBuild, publicBetaPlan, readContact, redact,
  reviewNotes, TEXT_LIMIT, textProblems,
} from "./ios-public-beta.mjs";

const dir = new URL("../apps/ios/testflight/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8").trim();
const committed = JSON.parse(read("test-information.json"));
// Made-up details: 555-01xx numbers are set aside for fiction, and example.com is nobody's.
const contact = {
  feedbackEmail: "beta@example.com",
  reviewContact: { firstName: "Ada", lastName: "Lovelace", phone: "+1 555 0100", email: "review@example.com" },
};
const build = (version: string, over: Record<string, unknown> = {}) =>
  ({ id: `build-${version}`, attributes: { version, processingState: "VALID", expired: false, usesNonExemptEncryption: false, ...over } });
const files = { description: "/t/beta-description.txt", whatToTest: "/t/what-to-test.txt", notes: "/tmp/x/review-notes.txt" };

describe("parsePublicBetaArgs", () => {
  it("is a dry run of the newest build, with the owner's contact file, unless told otherwise", () => {
    expect(parsePublicBetaArgs([])).toEqual({ build: null, confirm: false, contact: join(homedir(), ".config/realm/testflight-contact.json") });
    expect(parsePublicBetaArgs(["--build", "3", "--contact", "/k/contact.json", "--confirm"])).toEqual({ build: 3, confirm: true, contact: "/k/contact.json" });
    expect(CONTACT_FILE.startsWith(homedir())).toBe(true);
  });
  it("refuses a build that is not a whole number above 0, a flag without its value, and unknown flags", () => {
    for (const bad of ["0", "-1", "2.5", "03", "latest"]) expect(() => parsePublicBetaArgs(["--build", bad])).toThrow(/--build must be/);
    expect(() => parsePublicBetaArgs(["--build"])).toThrow(/--build needs a value/);
    expect(() => parsePublicBetaArgs(["--contact", "--confirm"])).toThrow(/--contact needs a value/);
    expect(() => parsePublicBetaArgs(["--submit"])).toThrow(/unknown flag --submit/);
  });
});

describe("nobody's own details in the repository", () => {
  it("keeps the feedback email and the review contact out of the committed settings", () => {
    expect(Object.keys(committed).sort()).toEqual(["demoVideoUrl", "group", "locale", "marketingUrl", "privacyPolicyUrl"]);
  });

  it("has no email address or phone number in any file the beta sends", () => {
    for (const name of readdirSync(dir)) {
      const text = read(name);
      expect(text.match(/[^\s@"]+@[^\s@"]+\.[a-z]{2,}/gi), name).toBeNull();
      expect(text.match(/\+?\d[\d ().-]{7,}\d/g), name).toBeNull();
    }
  });

  it("reads the contact from the owner's file, and reads a missing file as none", () => {
    const scratch = mkdtempSync(join(tmpdir(), "realm-contact-"));
    expect(readContact(join(scratch, "absent.json"))).toBeNull();
    writeFileSync(join(scratch, "contact.json"), JSON.stringify(contact));
    expect(readContact(join(scratch, "contact.json"))).toEqual(contact);
    writeFileSync(join(scratch, "broken.json"), "{");
    expect(() => readContact(join(scratch, "broken.json"))).toThrow(/is not JSON/);
  });

  it("never prints the phone number whole: only its last two digits", () => {
    expect(maskPhone("+1 555 0100")).toBe("+• ••• ••00");
    expect(maskPhone("(555) 010-0123")).toBe("(•••) •••-••23");
    expect(redact("--contact-phone \"+1 555 0100\" and 15550100", contact)).toBe("--contact-phone \"+• ••• ••00\" and ••••••00");
    expect(redact("nothing to hide", null)).toBe("nothing to hide");
  });
});

describe("what has to be in place before anything goes to Apple", () => {
  it("is the contact file, whole", () => {
    expect(missingForSubmission(committed, null, "/k/contact.json")).toEqual([
      "/k/contact.json: the feedback email and Beta App Review's contact, which never go in the repository",
    ]);
    expect(missingForSubmission(committed, contact, "/k/contact.json")).toEqual([]);
    const partial = { feedbackEmail: "not an email", reviewContact: { firstName: "Ada", lastName: " ", email: "review@example.com" } };
    expect(missingForSubmission(committed, partial, "/k/contact.json").map((m: string) => m.split(" in ")[0])).toEqual([
      "feedbackEmail", "reviewContact.lastName", "reviewContact.phone",
    ]);
  });

  it("is https for the demo video, the site and the privacy policy", () => {
    expect(missingForSubmission({ ...committed, privacyPolicyUrl: "http://realm.computer/docs/privacy" }, contact, "/k/c.json")).toEqual(["privacyPolicyUrl: an https URL"]);
    expect(missingForSubmission({ ...committed, demoVideoUrl: null }, contact, "/k/c.json")).toEqual(["demoVideoUrl: an https URL"]);
  });
});

describe("the public beta's words, as committed", () => {
  it("fit App Store Connect's fields", () => {
    const texts = { description: read("beta-description.txt"), whatToTest: read("what-to-test.txt"), notes: reviewNotes(read("review-notes.txt"), committed.demoVideoUrl) };
    expect(textProblems(texts)).toEqual([]);
    expect(textProblems({ long: "x".repeat(TEXT_LIMIT + 1) })).toEqual([`long is ${TEXT_LIMIT + 1} characters, over App Store Connect's ${TEXT_LIMIT}`]);
  });

  it("tell a reviewer the app needs a paired Mac, where Realm for Mac comes from, how to pair, and where the recording is", () => {
    const notes = reviewNotes(read("review-notes.txt"), committed.demoVideoUrl);
    for (const claim of ["https://realm.computer", "Settings ▸ Devices", "Pair an iPhone", "Scan the code", "Paste the link", "no account, no sign-in and nothing to buy",
      "https://realm.computer/beta/realm-ios-review.mp4"]) {
      expect(notes, claim).toContain(claim);
    }
    expect(read("beta-description.txt")).toContain("Realm 2.4 or later");
  });

  it("put the demo video's address in the notes, and say so plainly while it is unset", () => {
    expect(reviewNotes("Watch it: {demoVideoUrl}", "https://example.com/v.mp4")).toBe("Watch it: https://example.com/v.mp4");
    expect(reviewNotes("Watch it: {demoVideoUrl}", null)).toBe("Watch it: <{demoVideoUrl} is not set>");
    expect(() => reviewNotes("No video here", "https://example.com/v.mp4")).toThrow(/lost its \{demoVideoUrl\}/);
  });

  it("point at the privacy policy and the site, and a public group with feedback on", () => {
    expect(committed).toMatchObject({
      locale: "en-US", marketingUrl: "https://realm.computer", privacyPolicyUrl: "https://realm.computer/docs/privacy",
      demoVideoUrl: "https://realm.computer/beta/realm-ios-review.mp4", group: { name: "Public Beta", feedbackEnabled: true },
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
    publicBetaPlan({ app: "6820452196", info: committed, contact, build: build("3"), localization: null, reviewDetailId: "6820452196", testNotes: null, group: null, files, ...over });

  it("writes everything a first public beta needs, makes the group, and only then submits", () => {
    const steps = plan();
    expect(steps.map((s: { args: string[] }) => s.args.slice(0, 3).join(" "))).toEqual([
      "testflight app-localizations create", "testflight review edit", "builds test-notes create", "testflight groups create", "builds add-groups --build-id",
    ]);
    // The one step that sends the build to Apple is the last, and the only one marked so.
    expect(steps.filter((s: { submits?: boolean }) => s.submits)).toEqual([steps.at(-1)]);
    expect(steps.at(-1).args).toEqual(["builds", "add-groups", "--build-id", "build-3", "--group", "Public Beta", "--submit", "--confirm", "--output", "json"]);
    expect(steps[0].args).toEqual(expect.arrayContaining(["--description", "@file:/t/beta-description.txt", "--privacy-policy-url", "https://realm.computer/docs/privacy", "--feedback-email", "beta@example.com"]));
    // The contact goes to Apple as it is; only what is printed is masked (`redact`).
    expect(steps[1].args).toEqual(expect.arrayContaining(["--demo-account-required=false", "--notes", "@file:/tmp/x/review-notes.txt", "--contact-phone", "+1 555 0100"]));
    expect(redact(steps[1].args.join(" "), contact)).not.toContain("555 0100");
    expect(steps[3].args).toEqual(expect.arrayContaining(["--public-link-enabled", "--public-link-limit-enabled", "--public-link-limit", "1000", "--feedback-enabled"]));
  });

  it("shows where the contact will go when there is no contact file yet", () => {
    const args = plan({ contact: null })[1].args;
    expect(args).toEqual(expect.arrayContaining(["--contact-first-name", "<firstName>", "--contact-phone", "<phone>", "--contact-email", "<email>"]));
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
