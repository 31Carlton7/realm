// Builds the macOS Swift helpers into native/bin/.
// Skips quietly on non-mac or when swiftc is unavailable; each helper is optional and the app
// degrades without it (ScrollPhase → timer heuristics, AxHelper → no computer-use tools).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const native = join(here, "..", "native");

/** source file → output binary name. */
const HELPERS = [
  ["ScrollPhase.swift", "scrollphase"],
  ["AxHelper.swift", "axhelper"],
];

if (process.platform !== "darwin") process.exit(0);
try { execFileSync("xcrun", ["-f", "swiftc"], { stdio: "ignore" }); } catch { console.warn("[build-native] swiftc not found; skipping Swift helpers"); process.exit(0); }

for (const [source, binary] of HELPERS) {
  const src = join(native, source);
  const out = join(native, "bin", binary);
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) continue;
  mkdirSync(dirname(out), { recursive: true });
  console.log(`[build-native] compiling ${source}…`);
  execFileSync("swiftc", ["-O", "-o", out, src], { stdio: "inherit" });
}
