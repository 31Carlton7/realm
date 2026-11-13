// The Swift helpers, and the oldest macOS each is built for. Without an explicit target swiftc builds
// for the macOS of the Mac it runs on, so a release built on a beta shipped helpers no older Mac could
// start (#411). Each floor is the lowest the helper's APIs allow; newer APIs sit behind #available.
//
//   node scripts/native-helpers.mjs check <dir | Realm.app>
//
// Reads each helper's LC_BUILD_VERSION and exits 1 when one is built for a newer macOS than its entry,
// or, given an app, when the table's lowest entry is above the app's LSMinimumSystemVersion.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** source file → output binary name, and the macOS it is built for. */
export const NATIVE_HELPERS = [
  { source: "ScrollPhase.swift", binary: "scrollphase", macos: "13.0" },
  { source: "AxHelper.swift", binary: "axhelper", macos: "13.0" },
  { source: "PhoneScreen.swift", binary: "phonescreen", macos: "13.0" },
  { source: "DeviceOwner.swift", binary: "deviceowner", macos: "13.0" },
  { source: "PolicyStamp.swift", binary: "policystamp", macos: "13.0" },
  { source: "KeychainPasswords.swift", binary: "realmkeychain", macos: "13.0" },
  // realmvoice, dictation's helper (#409), goes here at 26.0.
];

const MH_MAGIC_64 = 0xfeedfacf;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;

/** "13.0" → 130000, so versions compare as numbers. */
export function versionNumber(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major * 10_000 + minor * 100 + patch;
}

/** The macOS a thin 64-bit Mach-O says it needs, as "13.0", or null when it carries no version command. */
export function minimumMacos(bytes) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== MH_MAGIC_64) throw new Error("not a thin 64-bit Mach-O");
  const commands = bytes.readUInt32LE(16);
  let at = 32;
  for (let i = 0; i < commands; i++) {
    const cmd = bytes.readUInt32LE(at);
    if (cmd === LC_BUILD_VERSION || cmd === LC_VERSION_MIN_MACOSX) {
      const v = bytes.readUInt32LE(at + (cmd === LC_BUILD_VERSION ? 12 : 8));
      const patch = v & 0xff;
      return `${v >>> 16}.${(v >>> 8) & 0xff}${patch ? `.${patch}` : ""}`;
    }
    at += bytes.readUInt32LE(at + 4);
  }
  return null;
}

/** The LSMinimumSystemVersion an XML Info.plist declares, or null. */
export function plistMinimumMacos(xml) {
  return /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1] ?? null;
}

/**
 * What is wrong with the helpers in `dir` (absent ones are skipped: each is optional), and, given the
 * app's LSMinimumSystemVersion, with the table itself.
 */
export function helperProblems(dir, appMinimum = null, helpers = NATIVE_HELPERS) {
  const problems = [];
  for (const { binary, macos } of helpers) {
    const path = join(dir, binary);
    if (!existsSync(path)) continue;
    const built = minimumMacos(readFileSync(path));
    if (built === null) problems.push(`${binary} names no minimum macOS`);
    else if (versionNumber(built) > versionNumber(macos)) problems.push(`${binary} is built for macOS ${built}, above its ${macos}`);
  }
  if (appMinimum !== null) {
    const lowest = helpers.map((h) => h.macos).sort((a, b) => versionNumber(a) - versionNumber(b))[0];
    if (versionNumber(lowest) > versionNumber(appMinimum)) problems.push(`every helper needs macOS ${lowest} or later, above the app's ${appMinimum}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
