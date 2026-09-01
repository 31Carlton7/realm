// electron-builder launcher (Plan 15 W3). One decision lives here: whether this build SIGNS.
//
// electron-builder.yml carries no `identity` any more — this wrapper supplies `-c.mac.identity=null`
// (skip codesign entirely) exactly when the env carries no signing credential, and says so loudly.
// With CSC_LINK (a base64 .p12 + CSC_KEY_PASSWORD) or CSC_NAME (a keychain identity) present, no
// override is added and electron-builder signs with it — plus notarize.cjs staples afterward when
// the APPLE_* vars are there too. The human steps live in docs/dev/signing.md; the point of this
// shape is that adding credentials to the env is the ENTIRE activation — zero code changes.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Pure: what to run, given the env. Signing is on iff a credential var is non-empty. */
export function packPlan(env, argv) {
  const signing = Boolean(env.CSC_LINK || env.CSC_NAME);
  return { signing, args: signing ? [...argv] : [...argv, "-c.mac.identity=null"] };
}

function main() {
  const plan = packPlan(process.env, process.argv.slice(2));
  if (plan.signing) {
    console.log("[pack] signing ENABLED (CSC_LINK/CSC_NAME present) — electron-builder will codesign; notarize.cjs runs after");
  } else {
    console.warn("[pack] signing DISABLED — no CSC_LINK/CSC_NAME in env, building UNSIGNED (-c.mac.identity=null). See docs/dev/signing.md.");
  }
  // Resolved from node_modules/.bin (this script only runs via the package's npm scripts).
  const r = spawnSync("electron-builder", plan.args, { stdio: "inherit" });
  if (r.error) throw r.error;
  process.exit(r.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
