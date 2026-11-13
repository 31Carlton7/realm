// Checks built Swift helpers against the macOS build-native.mjs builds each for (#411).
//
//   node scripts/native-helpers.mjs check <dir | Realm.app>
//
// Reads each helper's LC_BUILD_VERSION and exits 1 when one is built for a newer macOS than its entry,
// or, given an app, when the table's lowest entry is above the app's LSMinimumSystemVersion.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HELPERS } from "./build-native.mjs";
import { minimumMacos, plistMinimumMacos, versionNumber } from "./lib/macos-minimum.mjs";

/**
 * What is wrong with the helpers in `dir` (absent ones are skipped: each is optional), and, given the
 * app's LSMinimumSystemVersion, with the table itself.
 */
export function helperProblems(dir, appMinimum = null, helpers = HELPERS) {
  const problems = [];
  for (const [, binary, macos] of helpers) {
    if (!macos) {
      problems.push(`${binary} has no minimum macOS in build-native.mjs`);
      continue;
    }
    const path = join(dir, binary);
    if (!existsSync(path)) continue;
    const built = minimumMacos(readFileSync(path));
    if (built === null) problems.push(`${binary} names no minimum macOS`);
    else if (versionNumber(built) > versionNumber(macos)) problems.push(`${binary} is built for macOS ${built}, above its ${macos}`);
  }
  if (appMinimum !== null) {
    const lowest = helpers.map(([, , macos]) => macos).filter(Boolean).sort((a, b) => versionNumber(a) - versionNumber(b))[0];
    if (lowest && versionNumber(lowest) > versionNumber(appMinimum)) problems.push(`every helper needs macOS ${lowest} or later, above the app's ${appMinimum}`);
  }
  return problems;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, target] = process.argv.slice(2);
  if (command !== "check" || !target) {
    console.error("usage: node scripts/native-helpers.mjs check <dir | Realm.app>");
    process.exit(64);
  }
  const app = target.endsWith(".app");
  const dir = app ? join(target, "Contents", "Resources") : target;
  const appMinimum = app ? plistMinimumMacos(readFileSync(join(target, "Contents", "Info.plist"), "utf8")) : null;
  const problems = helperProblems(dir, appMinimum);
  for (const problem of problems) console.error(`[native-helpers] ${problem}`);
  if (problems.length) process.exit(1);
  console.log(`[native-helpers] ${dir}: every helper is built for its table entry${appMinimum ? `, and the app's minimum is ${appMinimum}` : ""}`);
}
