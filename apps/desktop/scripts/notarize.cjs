/**
 * electron-builder afterSign hook (Plan 15 W3): notarize the signed .app with Apple's notary
 * service, or NO-OP LOUDLY when the credentials aren't in the env. Never fakes anything: an
 * unsigned or credential-less build prints exactly why it skipped and the build stays valid
 * (just unsigned/un-notarized, as README documents). Activation is env-only — docs/dev/signing.md
 * has the human steps; with CSC_* + APPLE_* set, `pnpm dist` signs, notarizes and staples with
 * zero code changes.
 */
const APPLE_VARS = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];

/** Pure: should this build notarize, and if not, exactly why not (for the loud skip line). */
function notarizeDecision(env) {
  const signed = Boolean(env.CSC_LINK || env.CSC_NAME);
  const missing = APPLE_VARS.filter((k) => !env[k]);
  if (!signed) return { run: false, reason: "build is not being signed (no CSC_LINK/CSC_NAME) — an unsigned app cannot be notarized" };
  if (missing.length) return { run: false, reason: `missing ${missing.join(", ")}` };
  return { run: true };
}

async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const decision = notarizeDecision(process.env);
  if (!decision.run) {
    console.warn(`\n[notarize] SKIPPED — ${decision.reason}. See docs/dev/signing.md for the setup steps.\n`);
    return;
  }
  // Lazy so credential-less builds never touch the module at all.
  const { notarize } = require("@electron/notarize");
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log(`[notarize] submitting ${appPath} to Apple's notary service (this can take a few minutes)…`);
  await notarize({
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
  console.log("[notarize] accepted and stapled");
}

module.exports = afterSign;
module.exports.default = afterSign;
module.exports.notarizeDecision = notarizeDecision;
