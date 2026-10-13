/**
 * electron-builder afterSign hook (Plan 15 W3): notarize the signed .app with Apple's notary
 * service, or NO-OP LOUDLY when the credentials aren't available. Never fakes anything: an
 * unsigned or credential-less build prints exactly why it skipped and the build stays valid
 * (just unsigned/un-notarized, as README documents). Activation is env-only — docs/dev/signing.md
 * has the human steps; with CSC_* plus either APPLE_KEYCHAIN_PROFILE or the three APPLE_* password
 * credentials set, `pnpm dist` signs, notarizes and staples with zero code changes.
 */
const APPLE_VARS = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];

/** Pure: should this build notarize, and if not, exactly why not (for the loud skip line). */
function notarizeDecision(env) {
  const signed = Boolean(env.CSC_LINK || env.CSC_NAME);
  if (!signed) return { run: false, reason: "build is not being signed (no CSC_LINK/CSC_NAME) — an unsigned app cannot be notarized" };
  if (env.APPLE_KEYCHAIN_PROFILE) return { run: true };
  const missing = APPLE_VARS.filter((k) => !env[k]);
  if (missing.length) return { run: false, reason: `missing ${missing.join(", ")}` };
  return { run: true };
}

/** The bundle id every macOS grant Realm holds is keyed to (electron-builder.yml's appId). */
const BUNDLE_ID = "co.charmtechnologies.realm";
/** The native helpers stage-pack.mjs puts in Contents/Resources. axhelper is the one whose requests
 *  macOS attributes to Realm for Accessibility and Screen Recording; all of them run in Realm's tree. */
const HELPERS = ["axhelper", "scrollphase", "phonescreen", "deviceowner", "policystamp"];

/** Pure: the fields `codesign -dv --verbose=2` and `codesign -d -r-` print that decide grant binding. */
function parseCodesign(details, requirement) {
  const field = (name) => (details.match(new RegExp(`^${name}=(.*)$`, "m")) || [])[1] || null;
  const team = field("TeamIdentifier");
  return {
    identifier: field("Identifier"),
    teamId: team && team !== "not set" ? team : null,
    runtime: /flags=0x[0-9a-f]+\([^)]*\bruntime\b/.test(details),
    requirement: (requirement.match(/designated => (.*)$/m) || [])[1] || null,
  };
}

/**
 * Pure: why macOS would pin this build's grants to a cdhash — and so drop them at the next update —
 * rather than to the designated requirement (bundle id + team), which survives updates. Empty when the
 * binding is right. Every helper must carry the app's team and the hardened runtime: a helper signed
 * by no team (or another) is a different program to TCC, and one without the runtime fails
 * notarization.
 */
function grantBindingProblems(app, helpers) {
  const problems = [];
  if (app.identifier !== BUNDLE_ID) problems.push(`Realm.app is signed as "${app.identifier}", not ${BUNDLE_ID}`);
  if (!app.teamId) problems.push("Realm.app carries no team: macOS would pin every grant to this build's cdhash");
  if (!app.requirement || /\bcdhash\b/.test(app.requirement) || !app.requirement.includes(`identifier "${BUNDLE_ID}"`))
    problems.push(`Realm.app's designated requirement does not name its bundle id and team (${app.requirement ?? "none"})`);
  if (!app.runtime) problems.push("Realm.app is not signed with the hardened runtime");
  for (const [name, h] of Object.entries(helpers)) {
    if (!h) continue; // a helper that was not built is a supported state; stage-pack already said so
    if (h.teamId !== app.teamId) problems.push(`${name} is signed by ${h.teamId ? `team ${h.teamId}` : "no team"}, not Realm's team ${app.teamId}`);
    if (!h.runtime) problems.push(`${name} is not signed with the hardened runtime`);
  }
  return problems;
}

/** Read the signatures off the built app and refuse it when a grant would not survive an update. */
function verifyGrantBinding(appPath) {
  const { spawnSync } = require("node:child_process");
  const { existsSync } = require("node:fs");
  // codesign prints both of these on stderr.
  const capture = (args, path) => {
    const r = spawnSync("codesign", [...args, path], { encoding: "utf8" });
    return `${r.stdout || ""}${r.stderr || ""}`;
  };
  const read = (path) => parseCodesign(capture(["-dv", "--verbose=2"], path), capture(["-d", "-r-"], path));
  const helpers = {};
  for (const name of HELPERS) {
    const path = `${appPath}/Contents/Resources/${name}`;
    helpers[name] = existsSync(path) ? read(path) : null;
  }
  const problems = grantBindingProblems(read(appPath), helpers);
  if (problems.length) {
    throw new Error(`[sign] this build would lose its macOS permissions at the next update:\n  - ${problems.join("\n  - ")}`);
  }
  console.log("[sign] grants bind to Realm's designated requirement; every helper carries its team and the hardened runtime");
}

async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  // Before notarizing, and for local signed builds that never notarize: a signed build whose grants
  // would still be pinned to a cdhash is the failure this exists to catch before anyone installs it.
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    verifyGrantBinding(`${context.appOutDir}/${context.packager.appInfo.productFilename}.app`);
  }
  const decision = notarizeDecision(process.env);
  if (!decision.run) {
    console.warn(`\n[notarize] SKIPPED — ${decision.reason}. See docs/dev/signing.md for the setup steps.\n`);
    return;
  }
  // Lazy so credential-less builds never touch the module at all.
  const { notarize } = require("@electron/notarize");
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log(`[notarize] submitting ${appPath} to Apple's notary service (this can take a few minutes)…`);
  const credentials = process.env.APPLE_KEYCHAIN_PROFILE
    ? { keychainProfile: process.env.APPLE_KEYCHAIN_PROFILE }
    : {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      };
  await notarize({ appPath, ...credentials });
  console.log("[notarize] accepted and stapled");
}

module.exports = afterSign;
module.exports.default = afterSign;
module.exports.notarizeDecision = notarizeDecision;
module.exports.parseCodesign = parseCodesign;
module.exports.grantBindingProblems = grantBindingProblems;
