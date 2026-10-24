#!/usr/bin/env node
/**
 * `pnpm ios:public-beta` — a TestFlight build of Realm for iPhone to anyone with the public link, in
 * order:
 *
 *   1. the build: processed, not expired, its encryption declared exempt;
 *   2. Test Information: the beta app description, feedback email, marketing and privacy policy URLs;
 *   3. Beta App Review: the contact, no demo account, and the review notes with the demo video's address;
 *   4. the build's What to Test;
 *   5. the external group with a public link, made once and found by its name after;
 *   6. the build added to that group and submitted for Beta App Review.
 *
 * The words are apps/ios/testflight/*.txt and the settings apps/ios/testflight/test-information.json.
 *
 * A dry run unless --confirm. A dry run only reads App Store Connect: it prints every change as the asc
 * command that makes it, and asks asc to preview the group assignment (`add-groups --dry-run`). With
 * --confirm the same commands run, in the same order, and the last one submits the build to Apple.
 *
 * Flags: --build <n>   the build to send, by its build number; default: the newest that is valid
 *        --confirm      make the changes and submit
 * Env:   ASC=<path>     asc 5 or later; asc 3 has no `add-groups --dry-run`, so it cannot preview
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_ID } from "./ios-release.mjs";

/** What App Store Connect takes in each of its long text fields. */
export const TEXT_LIMIT = 4000;
const VIDEO = "{demoVideoUrl}";

// ---------- pure logic (tested in ios-public-beta.test.ts) ----------

export function parsePublicBetaArgs(argv) {
  const out = { build: null, confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--confirm") out.confirm = true;
    else if (flag === "--build") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("--build needs a value");
      if (!/^[1-9]\d*$/.test(value)) throw new Error(`--build must be a whole number above 0, not "${value}"`);
      out.build = Number(value);
    } else {
      throw new Error(`unknown flag ${flag} — pnpm ios:public-beta [--build <n>] [--confirm]`);
    }
  }
  return out;
}

/** What still has to be filled in before Apple can be sent anything, as sentences; empty when nothing. */
export function missingForSubmission(info) {
  const missing = [];
  if (!isEmail(info.feedbackEmail)) missing.push("feedbackEmail: where testers' feedback goes");
  const contact = info.reviewContact ?? {};
  for (const field of ["firstName", "lastName", "phone"]) if (!contact[field]) missing.push(`reviewContact.${field}: who Beta App Review can reach`);
  if (!isEmail(contact.email)) missing.push("reviewContact.email: who Beta App Review can reach");
  if (!isUrl(info.demoVideoUrl)) missing.push("demoVideoUrl: the recording of the app with a paired Mac, which the review notes point at");
  for (const field of ["marketingUrl", "privacyPolicyUrl"]) if (!isUrl(info[field])) missing.push(`${field}: an https URL`);
  return missing;
}

const isEmail = (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isUrl = (v) => {
  if (typeof v !== "string") return false;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
};

/** The review notes as they are sent: the demo video's address in place, when there is one. */
export function reviewNotes(template, demoVideoUrl) {
  if (!template.includes(VIDEO)) throw new Error(`review-notes.txt has lost its ${VIDEO}`);
  return template.replaceAll(VIDEO, isUrl(demoVideoUrl) ? demoVideoUrl : `<${VIDEO} is not set>`);
}

/** Texts App Store Connect would refuse, as sentences. */
export function textProblems(texts) {
  return Object.entries(texts)
    .filter(([, text]) => text.length > TEXT_LIMIT)
    .map(([name, text]) => `${name} is ${text.length} characters, over App Store Connect's ${TEXT_LIMIT}`);
}

/** The build to send: the one named, else the newest; either way it must be valid and not expired. */
export function pickBuild(builds, number) {
  const all = (builds ?? []).filter((b) => /^\d+$/.test(b?.attributes?.version ?? ""));
  const build = number === null
    ? all.filter((b) => b.attributes.processingState === "VALID" && !b.attributes.expired).sort((a, b) => Number(b.attributes.version) - Number(a.attributes.version))[0]
    : all.find((b) => Number(b.attributes.version) === number);
  if (!build) throw new Error(number === null ? "App Store Connect has no valid build of Realm for iPhone" : `App Store Connect has no build ${number}`);
  const { processingState, expired, version } = build.attributes;
  if (processingState !== "VALID") throw new Error(`build ${version} is ${processingState}, not VALID`);
  if (expired) throw new Error(`build ${version} has expired`);
  return build;
}

export const findGroup = (groups, name) => (groups ?? []).find((g) => g?.attributes?.name === name && g.attributes.isInternalGroup === false) ?? null;
export const findLocale = (localizations, locale) => (localizations ?? []).find((l) => l?.attributes?.locale === locale) ?? null;

/**
 * Every change, in order, as asc arguments, from what App Store Connect has now. `files` are the
 * paths asc reads the long texts from (`@file:`), so the printed commands are the ones that run.
 */
export function publicBetaPlan({ app, info, build, localization, reviewDetailId, testNotes, group, files }) {
  const steps = [];
  const urls = ["--feedback-email", info.feedbackEmail ?? "<feedbackEmail>", "--marketing-url", info.marketingUrl, "--privacy-policy-url", info.privacyPolicyUrl];
  steps.push(localization
    ? { title: "Update Test Information", args: ["testflight", "app-localizations", "update", "--id", localization.id, "--description", `@file:${files.description}`, ...urls] }
    : { title: "Write Test Information", args: ["testflight", "app-localizations", "create", "--app", app, "--locale", info.locale, "--description", `@file:${files.description}`, ...urls] });
  const contact = info.reviewContact ?? {};
  steps.push({ title: "Write Beta App Review's contact and notes", args: [
    "testflight", "review", "edit", "--id", reviewDetailId,
    "--contact-first-name", contact.firstName ?? "<firstName>", "--contact-last-name", contact.lastName ?? "<lastName>",
    "--contact-phone", contact.phone ?? "<phone>", "--contact-email", contact.email ?? "<email>",
    "--demo-account-required=false", "--notes", `@file:${files.notes}`,
  ] });
  steps.push({ title: `Write build ${build.attributes.version}'s What to Test`, args: [
    "builds", "test-notes", testNotes ? "update" : "create", "--build-id", build.id, "--locale", info.locale, "--whats-new", `@file:${files.whatToTest}`,
  ] });
  if (build.attributes.usesNonExemptEncryption !== false) {
    steps.push({ title: "Declare the build's encryption exempt", args: ["builds", "update", "--build-id", build.id, "--uses-non-exempt-encryption=false"] });
  }
  if (!group) {
    steps.push({ title: `Make the external group "${info.group.name}" with a public link`, args: [
      "testflight", "groups", "create", "--app", app, "--name", info.group.name, "--public-link-enabled",
      "--public-link-limit-enabled", "--public-link-limit", String(info.group.publicLinkLimit), ...(info.group.feedbackEnabled ? ["--feedback-enabled"] : []),
    ] });
  }
  steps.push({ title: `Add build ${build.attributes.version} to "${info.group.name}" and submit it for Beta App Review`, submits: true, args: [
    "builds", "add-groups", "--build-id", build.id, "--group", info.group.name, "--submit", "--confirm",
  ] });
  return steps.map((s) => ({ ...s, args: [...s.args, "--output", "json"] }));
}

// ---------- the run ----------

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(repo, "apps/ios/testflight");
const asc = process.env.ASC || "asc";

const run = (args) => execFileSync(asc, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const json = (args) => JSON.parse(run([...args, "--output", "json"]));
const shown = (args) => [relative(process.cwd(), asc) || asc, ...args].map((a) => (/[\s"'<>]/.test(a) ? JSON.stringify(a) : a)).join(" ");

async function main() {
  const args = parsePublicBetaArgs(process.argv.slice(2));
  const version = run(["--version"]);
  if (!/^([5-9]|\d{2,})\./.test(version)) throw new Error(`asc ${version} is too old: this needs asc 5 or later. Run with ASC=<path to asc 5>.`);

  const info = JSON.parse(readFileSync(join(dir, "test-information.json"), "utf8"));
  const texts = {
    "beta-description.txt": readFileSync(join(dir, "beta-description.txt"), "utf8").trim(),
    "what-to-test.txt": readFileSync(join(dir, "what-to-test.txt"), "utf8").trim(),
    "review-notes.txt": reviewNotes(readFileSync(join(dir, "review-notes.txt"), "utf8").trim(), info.demoVideoUrl),
  };
  const problems = textProblems(texts);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const missing = missingForSubmission(info);
  if (args.confirm && missing.length > 0) throw new Error(`fill these in apps/ios/testflight/test-information.json first:\n  - ${missing.join("\n  - ")}`);

  console.log(`Realm for iPhone (app ${APP_ID}) to TestFlight's public link, asc ${version}${args.confirm ? "" : " — a dry run: App Store Connect is only read"}`);
  const build = pickBuild(json(["builds", "list", "--app", APP_ID, "--processing-state", "all", "--paginate"]).data, args.build);
  console.log(`\nBuild ${build.attributes.version} (${build.id}): ${build.attributes.processingState}, uploaded ${build.attributes.uploadedDate}, iOS ${build.attributes.minOsVersion}+`);
  const localization = findLocale(json(["testflight", "app-localizations", "list", "--app", APP_ID]).data, info.locale);
  const reviewDetailId = json(["testflight", "review", "view", "--app", APP_ID]).data?.[0]?.id;
  if (!reviewDetailId) throw new Error("App Store Connect has no Beta App Review details for the app");
  const testNotes = findLocale(json(["builds", "test-notes", "list", "--build-id", build.id]).data, info.locale);
  const group = findGroup(json(["testflight", "groups", "list", "--app", APP_ID]).data, info.group.name);
  console.log(`Test Information: ${localization ? "set; updated" : "none yet; written"}. What to Test: ${testNotes ? "set; updated" : "none yet; written"}. Group "${info.group.name}": ${group ? `exists (${group.id})` : "made"}.`);

  // The review notes are sent with the video's address in them, so asc reads them from a file made here.
  const scratch = mkdtempSync(join(tmpdir(), "realm-public-beta-"));
  try {
    const notes = join(scratch, "review-notes.txt");
    writeFileSync(notes, texts["review-notes.txt"]);
    const files = { description: join(dir, "beta-description.txt"), whatToTest: join(dir, "what-to-test.txt"), notes };
    const steps = publicBetaPlan({ app: APP_ID, info, build, localization, reviewDetailId, testNotes, group, files });

    if (!args.confirm) {
      console.log(`\nThe review notes, as they would be sent:\n${texts["review-notes.txt"].replace(/^/gm, "  │ ")}`);
      console.log("\nWith --confirm, these run in order:");
      for (const step of steps) console.log(`\n▸ ${step.title}\n  ${shown(step.args)}`);
      if (group) {
        console.log(`\n▸ asc's own preview of the last step (add-groups --dry-run):`);
        console.log(run(["builds", "add-groups", "--build-id", build.id, "--group", info.group.name, "--dry-run", "--output", "json"]));
      }
      if (missing.length > 0) console.log(`\nBefore --confirm, fill these in apps/ios/testflight/test-information.json:\n  - ${missing.join("\n  - ")}`);
      return;
    }

    for (const step of steps) {
      console.log(`\n▸ ${step.title}\n  ${shown(step.args)}`);
      run(step.args);
    }
    const made = findGroup(json(["testflight", "groups", "list", "--app", APP_ID]).data, info.group.name);
    console.log(`\nBuild ${build.attributes.version} is with Beta App Review for "${info.group.name}".`);
    console.log(made?.attributes?.publicLink ? `The public link, live once Apple approves the build: ${made.attributes.publicLink}` : "App Store Connect has not given the group its public link yet: asc testflight groups list --app " + APP_ID);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\nios:public-beta: ${e.stderr?.toString().trim() || e.message}`);
    process.exit(1);
  });
}
