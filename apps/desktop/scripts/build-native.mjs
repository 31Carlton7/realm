// Builds the macOS Swift helpers into native/bin/.
// Skips quietly on non-mac or when swiftc is unavailable; each helper is optional and the app
// degrades without it (ScrollPhase → timer heuristics, AxHelper → no computer-use tools,
// PhoneScreen → a real iPhone's picture is the runner's screenshots, about one a second,
// DeviceOwner → sign-ins unlock with Touch ID only, PolicyStamp → sign-ins stay on Touch ID: a
// looser unlock policy is only honoured beside the Keychain stamp this helper keeps, KeychainPasswords
// → the login keychain's passwords are not offered, RealmVoice → dictation is not offered).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const native = join(here, "..", "native");

/**
 * source file → output binary name, and the oldest macOS it is built for where one is set. Unset, swiftc
 * builds for the macOS it runs on. realmvoice's is dictation's (`DICTATION_MACOS` in
 * packages/contracts/src/platform.ts), which the app checks before offering it; build-native.test.ts
 * holds the two together.
 */
const HELPERS = [
  ["ScrollPhase.swift", "scrollphase"],
  ["AxHelper.swift", "axhelper"],
  ["PhoneScreen.swift", "phonescreen"],
  ["DeviceOwner.swift", "deviceowner"],
  ["PolicyStamp.swift", "policystamp"],
  ["KeychainPasswords.swift", "realmkeychain"],
  ["RealmVoice.swift", "realmvoice", "26.0"],
];

if (process.platform !== "darwin") process.exit(0);
try { execFileSync("xcrun", ["-f", "swiftc"], { stdio: "ignore" }); } catch { console.warn("[build-native] swiftc not found; skipping Swift helpers"); process.exit(0); }

const arch = process.arch === "arm64" ? "arm64" : "x86_64";
for (const [source, binary, macos] of HELPERS) {
  const src = join(native, source);
  const out = join(native, "bin", binary);
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) continue;
  mkdirSync(dirname(out), { recursive: true });
  console.log(`[build-native] compiling ${source}…`);
  execFileSync("swiftc", ["-O", ...(macos ? ["-target", `${arch}-apple-macos${macos}`] : []), "-o", out, src], { stdio: "inherit" });
}
