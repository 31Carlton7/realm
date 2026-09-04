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
