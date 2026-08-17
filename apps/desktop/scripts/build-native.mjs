// Builds the macOS ScrollPhase helper (native/ScrollPhase.swift -> native/bin/scrollphase).
// Skips quietly on non-mac or when swiftc is unavailable; the app then falls back to timer heuristics.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "native", "ScrollPhase.swift");
const out = join(here, "..", "native", "bin", "scrollphase");
if (process.platform !== "darwin") process.exit(0);
try { execFileSync("xcrun", ["-f", "swiftc"], { stdio: "ignore" }); } catch { console.warn("[build-native] swiftc not found; skipping ScrollPhase helper"); process.exit(0); }
if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) process.exit(0);
mkdirSync(dirname(out), { recursive: true });
console.log("[build-native] compiling ScrollPhase helper…");
execFileSync("swiftc", ["-O", "-o", out, src], { stdio: "inherit" });
