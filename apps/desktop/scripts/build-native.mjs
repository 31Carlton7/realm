// Builds the macOS Swift helpers into native/bin/.
// Skips quietly on non-mac or when swiftc is unavailable; each helper is optional and the app
// degrades without it (ScrollPhase → timer heuristics, AxHelper → no computer-use tools,
// PhoneScreen → a real iPhone's picture is the runner's screenshots, about one a second,
// DeviceOwner → sign-ins unlock with Touch ID only, PolicyStamp → sign-ins stay on Touch ID: a
// looser unlock policy is only honoured beside the Keychain stamp this helper keeps, KeychainPasswords
// → the login keychain's passwords are not offered, RealmVoice → dictation is not offered).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { minimumMacos } from "./lib/macos-minimum.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const native = join(here, "..", "native");

/**
 * source file → output binary name, and the oldest macOS it is built for where one is set. Unset, swiftc
 * builds for the macOS it runs on, which shipped 2.11.1's helpers needing macOS 27.2 (#411). 13.0 is the
 * app's LSMinimumSystemVersion; newer APIs sit behind #available. realmvoice's is dictation's
 * (`DICTATION_MACOS` in packages/contracts/src/platform.ts), which the app checks before offering it;
 * build-native.test.ts holds the two together. native-helpers.mjs checks built helpers against these.
 */
export const HELPERS = [
  ["ScrollPhase.swift", "scrollphase", "13.0"],
  ["AxHelper.swift", "axhelper", "13.0"],
  ["PhoneScreen.swift", "phonescreen", "13.0"],
  ["DeviceOwner.swift", "deviceowner", "13.0"],
  ["PolicyStamp.swift", "policystamp", "13.0"],
  ["KeychainPasswords.swift", "realmkeychain", "13.0"],
  ["RealmVoice.swift", "realmvoice", "26.0"],
];

// Imported (by native-helpers.mjs) for the table alone.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) build();

function build() {
  if (process.platform !== "darwin") return;
  try { execFileSync("xcrun", ["-f", "swiftc"], { stdio: "ignore" }); } catch { console.warn("[build-native] swiftc not found; skipping Swift helpers"); return; }

  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  for (const [source, binary, macos] of HELPERS) {
    const src = join(native, source);
    const out = join(native, "bin", binary);
    // A helper built before its target was set is rebuilt, however new it is.
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs && (!macos || minimumMacos(readFileSync(out)) === macos)) continue;
    mkdirSync(dirname(out), { recursive: true });
    console.log(`[build-native] compiling ${source}…`);
    execFileSync("swiftc", ["-O", ...(macos ? ["-target", `${arch}-apple-macos${macos}`] : []), "-o", out, src], { stdio: "inherit" });
  }
}
