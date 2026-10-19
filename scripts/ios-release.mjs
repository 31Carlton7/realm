#!/usr/bin/env node
/**
 * `pnpm ios:release` (Plan 28 Phase 2) — the iPhone app to TestFlight, in order:
 *
 *   1. picks the build number: one past the highest App Store Connect has for the app,
 *   2. generates the Xcode project from apps/ios/project.yml (XcodeGen),
 *   3. archives the Release configuration for any iOS device, signed automatically,
 *   4. exports an App Store Connect IPA, and refuses it unless it is distribution-signed for
 *      production push with its notification extension inside,
 *   5. uploads it with asc, waits for processing, and gives it to the Internal Testers group.
 *
 * Signing goes through the Xcode account (-allowProvisioningUpdates), as Versed's archive and export
 * do. The upload goes through asc's App Store Connect API key in the keychain, so the Xcode account
 * never has to upload anything — the step that broke for Versed in August 2026.
 *
 * Flags: --build <n>    this build number instead of asking App Store Connect
 *        --xcode <app>  build with this Xcode (e.g. /Applications/Xcode-27.0.0.app) instead of the
 *                       selected one, leaving the selection alone
 *        --notes <text> "What to Test" for the build
 *        --cloud        build in Xcode Cloud instead, with its "TestFlight" workflow on this branch as
 *                       GitHub has it. App Store Connect refuses builds from a beta Xcode, and Xcode
 *                       Cloud builds with the latest release. It numbers and uploads the build itself.
 *        --skip-upload  stop once the IPA is exported and checked
 *        --dry-run      print the plan and the commands; build and upload nothing
 * Env:   ASC=<path>     the asc binary (default: asc on PATH)
 *
 * Everything lands in apps/ios/.build/release/<version>-<build>/, which git ignores.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** "Realm: Agent Workspace" in App Store Connect — "Realm" was taken. */
export const APP_ID = "6820452196";
export const TEAM_ID = "FY9QB79VAP";
export const GROUP = "Internal Testers";
/** The Xcode Cloud workflow `--cloud` starts: archive the Realm scheme, for TestFlight only. */
export const CLOUD_WORKFLOW = "TestFlight";

// ---------- pure logic (tested in ios-release.test.ts) ----------

export function parseIosReleaseArgs(argv) {
  const out = { build: null, notes: null, xcode: null, cloud: false, skipUpload: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--skip-upload") out.skipUpload = true;
    else if (flag === "--cloud") out.cloud = true;
    else if (flag === "--dry-run") out.dryRun = true;
    else if (flag === "--build" || flag === "--notes" || flag === "--xcode") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      if (flag === "--notes") out.notes = value;
      else if (flag === "--xcode") out.xcode = value.replace(/\/+$/, "");
      else if (!/^[1-9]\d*$/.test(value)) throw new Error(`--build must be a whole number above 0, not "${value}"`);
      else out.build = Number(value);
    } else {
      throw new Error(`unknown flag ${flag} — pnpm ios:release [--cloud] [--build <n>] [--xcode <app>] [--notes <text>] [--skip-upload] [--dry-run]`);
    }
  }
  // Xcode Cloud numbers, builds and uploads on its own, so none of these can mean anything there.
  if (out.cloud) {
    const given = [["--build", out.build !== null], ["--xcode", out.xcode !== null], ["--notes", out.notes !== null], ["--skip-upload", out.skipUpload]];
    const local = given.filter(([, was]) => was).map(([flag]) => flag);
    if (local.length > 0) throw new Error(`--cloud builds in Xcode Cloud, so ${local.join(" and ")} cannot apply`);
  }
  return out;
}

/** One past the highest build number App Store Connect has, across every version: a number used once
 *  can never be uploaded again, even if its build failed processing. */
export function nextBuildNumber(builds) {
  let highest = 0;
  for (const build of builds) {
    const version = build?.attributes?.version;
    if (typeof version === "string" && /^\d+$/.test(version)) highest = Math.max(highest, Number(version));
  }
  return highest + 1;
}

/** project.yml's MARKETING_VERSION: the version every build of this train is filed under. */
export function marketingVersion(projectYml) {
  const hits = [...projectYml.matchAll(/^\s*MARKETING_VERSION:\s*"?([^"\s]+)"?\s*$/gm)];
  if (hits.length !== 1) throw new Error(`expected exactly one MARKETING_VERSION in project.yml, found ${hits.length}`);
  return hits[0][1];
}

/** A beta Xcode is named as one on disk (Apple's Xcode-beta.app, or xcodes' Xcode-27.0.0-Beta.6.app);
 *  its version output says nothing, and release build numbers end in letters too. */
export function isBetaXcode(developerDir) {
  return /beta/i.test(developerDir);
}

export function exportOptionsPlist(teamId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>export</string>
  <key>teamID</key>
  <string>${teamId}</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>uploadSymbols</key>
  <true/>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
</dict>
</plist>
`;
}

/**
 * What would make an exported IPA wrong to upload, as sentences; empty when it is right. `facts` is
 * read off the IPA by `readIpaFacts`: a development-signed or sandbox-push build would install from
 * TestFlight and then never get a notification.
 */
export function ipaProblems(facts, expected) {
  const problems = [];
  if (facts.version !== expected.version) problems.push(`version is ${facts.version}, expected ${expected.version}`);
  if (facts.build !== String(expected.build)) problems.push(`build number is ${facts.build}, expected ${expected.build}`);
  if (!facts.hasExtension) problems.push("the notification extension (RealmNotificationService.appex) is missing");
  if (facts.apsEnvironment !== "production") problems.push(`aps-environment is ${facts.apsEnvironment ?? "missing"}, expected production`);
  const distribution = facts.authority?.startsWith("Apple Distribution: ") && facts.authority.endsWith(`(${expected.teamId})`);
  if (!distribution) problems.push(`signed by ${facts.authority ?? "nobody"}, expected the team's Apple Distribution identity`);
  if (facts.encryptionDeclared !== false) problems.push("ITSAppUsesNonExemptEncryption is not NO, so the build would wait on a compliance answer");
  return problems;
}

/** What `asc xcode-cloud run --wait --output json` printed: the run, and whether it built. asc prints
 *  the run flat (`buildRunId`, `buildNumber`, `completionStatus`); the API's own `{ data }` shape is
 *  read too, in case a later asc passes it through. */
export function cloudRunOutcome(json) {
  const runId = json?.buildRunId ?? json?.data?.id;
  const status = json?.completionStatus ?? json?.data?.attributes?.completionStatus ?? null;
  const number = json?.buildNumber ?? json?.data?.attributes?.number ?? null;
  if (typeof runId !== "string") throw new Error("asc did not say which Xcode Cloud run it started");
  return { runId, number, status, succeeded: status === "SUCCEEDED" };
}

// ---------- the run ----------

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const iosDir = join(repo, "apps/ios");
const asc = process.env.ASC || "asc";

/** Every child runs with this environment: `--xcode` sets DEVELOPER_DIR here, so xcodebuild and the
 *  tools it calls use that Xcode without `xcode-select` changing for anything else on the Mac. */
let childEnv = process.env;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: childEnv, ...opts }).trim();
}

/** Runs a long step with its output in a log file, and the log's tail on the terminal if it fails. */
function step(title, cmd, args, { cwd = repo, log, dryRun }) {
  console.log(`\n▸ ${title}\n  ${[cmd, ...args].map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  if (dryRun) return Promise.resolve();
  if (log) console.log(`  log: ${log}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ["ignore", log ? "pipe" : "inherit", log ? "pipe" : "inherit"] });
    if (log) {
      const file = createWriteStream(log);
      child.stdout.pipe(file);
      child.stderr.pipe(file);
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      if (log) {
        const lines = readFileSync(log, "utf8").split("\n");
        const errors = lines.filter((l) => /\berror\b|failed|FAILED/.test(l)).slice(-15);
        console.error(`\n--- ${title} failed; ${errors.length > 0 ? "its errors" : "the end of its log"} ---\n${(errors.length > 0 ? errors : lines.slice(-30)).join("\n")}`);
      }
      reject(new Error(`${title} failed (exit ${code})`));
    });
  });
}

function readIpaFacts(ipa, scratch) {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  sh("ditto", ["-x", "-k", ipa, scratch]);
  const app = join(scratch, "Payload/Realm.app");
  const plist = join(app, "Info.plist");
  const read = (key) => {
    try {
      return sh("plutil", ["-extract", key, "raw", "-o", "-", plist]);
    } catch {
      return null;
    }
  };
  const entitlements = sh("codesign", ["-d", "--entitlements", "-", "--xml", app]);
  const aps = /<key>aps-environment<\/key>\s*<string>([^<]+)<\/string>/.exec(entitlements)?.[1] ?? null;
  // codesign prints a signature's details on stderr; the first Authority is the signing identity.
  const signature = spawnSync("codesign", ["-dvv", app], { encoding: "utf8" });
  const authority = /^Authority=(.+)$/m.exec(`${signature.stdout}${signature.stderr}`)?.[1] ?? null;
  const encryption = read("ITSAppUsesNonExemptEncryption");
  return {
    version: read("CFBundleShortVersionString"),
    build: read("CFBundleVersion"),
    hasExtension: existsSync(join(app, "PlugIns/RealmNotificationService.appex")),
    apsEnvironment: aps,
    authority,
    encryptionDeclared: encryption === null ? null : encryption === "true",
  };
}

/** `--cloud`: Xcode Cloud builds the branch as GitHub has it, so what is here must be exactly that. */
async function cloud(args) {
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  sh("git", ["fetch", "--quiet", "origin", branch]);
  const [here, pushed] = [sh("git", ["rev-parse", "HEAD"]), sh("git", ["rev-parse", `origin/${branch}`])];
  if (here !== pushed) throw new Error(`${branch} here (${here.slice(0, 8)}) is not what GitHub has (${pushed.slice(0, 8)}): Xcode Cloud builds what is pushed, so push first`);
  const uncommitted = sh("git", ["status", "--porcelain", "--", "apps/ios"]);
  if (uncommitted) throw new Error(`apps/ios has changes that are not committed, so the cloud build would not have them:\n${uncommitted}`);
  console.log(`Realm on ${branch} at ${here.slice(0, 8)} → Xcode Cloud's "${CLOUD_WORKFLOW}" workflow, then TestFlight's "${GROUP}"`);
  const start = ["xcode-cloud", "run", "--app", APP_ID, "--workflow", CLOUD_WORKFLOW, "--branch", branch, "--wait", "--timeout", "90m", "--output", "json"];
  console.log(`\n▸ Build in Xcode Cloud\n  ${asc} ${start.join(" ")}`);
  if (args.dryRun) return;
  // Its progress goes to stderr, shown as it comes; the run itself is the JSON on stdout.
  const run = cloudRunOutcome(JSON.parse(sh(asc, start, { stdio: ["ignore", "pipe", "inherit"] })));
  if (!run.succeeded) throw new Error(`Xcode Cloud run ${run.number ?? "?"} ended ${run.status}: asc xcode-cloud issues list --run-id ${run.runId}`);
  const builds = JSON.parse(sh(asc, ["xcode-cloud", "build-runs", "builds", "--run-id", run.runId, "--output", "json"])).data ?? [];
  if (builds.length === 0) throw new Error(`Xcode Cloud run ${run.number} succeeded but uploaded no build`);
  for (const build of builds) {
    // The group has every build on paper, but App Store Connect does not always hand it over itself.
    console.log(`\n▸ Build ${build.attributes?.version}: wait for App Store Connect, then give it to "${GROUP}"`);
    sh(asc, ["builds", "wait", "--build-id", build.id, "--fail-on-invalid", "--output", "json"]);
    sh(asc, ["builds", "add-groups", "--build-id", build.id, "--group", GROUP, "--output", "json"]);
  }
  console.log(`\nRealm build ${builds.map((b) => b.attributes?.version).join(", ")} from ${branch} is on TestFlight for "${GROUP}". Open TestFlight on the iPhone to install it.`);
}

async function main() {
  const args = parseIosReleaseArgs(process.argv.slice(2));
  if (args.cloud) return cloud(args);
  if (args.xcode) {
    const dir = join(args.xcode, "Contents/Developer");
    if (!existsSync(dir)) throw new Error(`--xcode ${args.xcode} is not an Xcode: there is no ${dir}`);
    childEnv = { ...process.env, DEVELOPER_DIR: dir };
  }
  const developerDir = sh("xcode-select", ["-p"]);
  const xcode = sh("xcodebuild", ["-version"]).replace(/\n/g, ", ");
  console.log(`Xcode: ${xcode} (${developerDir})`);
  if (isBetaXcode(developerDir)) {
    console.log("  ! a beta Xcode: App Store Connect may refuse the upload (ITMS-90534). TestFlight has taken beta builds in some cycles; App Store review never does.");
  }
  for (const tool of ["xcodegen", asc]) {
    try {
      sh("/usr/bin/which", [tool]);
    } catch {
      throw new Error(`${tool} is not installed (brew install ${tool === asc ? "asc" : tool})`);
    }
  }

  const version = marketingVersion(readFileSync(join(iosDir, "project.yml"), "utf8"));
  let build = args.build;
  if (build === null) {
    const listed = JSON.parse(sh(asc, ["builds", "list", "--app", APP_ID, "--processing-state", "all", "--paginate", "--output", "json"]));
    build = nextBuildNumber(listed.data ?? []);
  }
  console.log(`Realm ${version} (${build}) → app ${APP_ID}, group "${GROUP}"`);

  const out = join(iosDir, ".build/release", `${version}-${build}`);
  const archive = join(out, "Realm.xcarchive");
  const exportDir = join(out, "export");
  const options = join(out, "ExportOptions.plist");
  const ipa = join(exportDir, "Realm.ipa");
  if (!args.dryRun) {
    // This build's own folder: a retry of the same number starts clean.
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(options, exportOptionsPlist(TEAM_ID));
  }

  await step("Generate the Xcode project", "xcodegen", ["generate", "--spec", "project.yml"], { cwd: iosDir, dryRun: args.dryRun });
  await step("Archive Release", "xcodebuild", [
    "archive", "-project", "Realm.xcodeproj", "-scheme", "Realm", "-configuration", "Release",
    "-destination", "generic/platform=iOS", "-archivePath", archive, "-allowProvisioningUpdates",
    `CURRENT_PROJECT_VERSION=${build}`,
  ], { cwd: iosDir, log: join(out, "archive.log"), dryRun: args.dryRun });
  await step("Export for App Store Connect", "xcodebuild", [
    "-exportArchive", "-archivePath", archive, "-exportPath", exportDir, "-exportOptionsPlist", options, "-allowProvisioningUpdates",
  ], { cwd: iosDir, log: join(out, "export.log"), dryRun: args.dryRun });

  if (!args.dryRun) {
    const facts = readIpaFacts(ipa, join(out, "ipa-check"));
    const problems = ipaProblems(facts, { version, build, teamId: TEAM_ID });
    if (problems.length > 0) throw new Error(`the IPA is not fit to upload:\n  - ${problems.join("\n  - ")}`);
    console.log(`\n✓ ${ipa}\n  ${facts.authority}; push ${facts.apsEnvironment}; extension inside; encryption declared exempt`);
  }
  if (args.skipUpload) return console.log("\n--skip-upload: stopping before App Store Connect.");

  const publish = ["publish", "testflight", "--app", APP_ID, "--ipa", ipa, "--version", version, "--build-number", String(build),
    "--group", GROUP, "--notify", "--wait", "--timeout", "60m", "--output", "table"];
  if (args.notes) publish.push("--test-notes", args.notes, "--locale", "en-US");
  await step("Upload to TestFlight", asc, publish, { dryRun: args.dryRun });
  if (!args.dryRun) console.log(`\nRealm ${version} (${build}) is on TestFlight for "${GROUP}". Open TestFlight on the iPhone to install it.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\nios:release: ${e.message}`);
    process.exit(1);
  });
}
