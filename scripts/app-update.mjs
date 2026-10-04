#!/usr/bin/env node
/**
 * `pnpm app:update`: build Realm and install it over /Applications/Realm.app — SIGNED with the
 * owner's Developer ID when this Mac has one, so the install keeps every macOS permission Realm holds.
 *
 * macOS keys those permissions (Accessibility, Screen Recording, Automation, Calendar, Contacts) to
 * the app's code signature. This command used to build unsigned, so every local install was a new
 * app to TCC and the grants went with the old one — the owner's "permission grants always disappear
 * for the mac apps" (09-12). A local build signed by the same team as the releases is the same app.
 *
 * The credentials come from the file the release already reads (`~/.config/realm-signing.env`,
 * docs/dev/signing.md): its CSC_* signing identity, and nothing else. The Apple notarization
 * credentials are deliberately left out: a local install is never quarantined, notarizing it would
 * upload every build to Apple and add minutes to each one, and notarize.cjs skips — saying why —
 * when they are absent. Without the file the build is unsigned as before, and install-local.mjs
 * refuses to put it over a signed Realm unless REALM_ALLOW_PERMISSION_RESET=1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The signing identity's variables — what electron-builder signs with. */
const SIGNING_VARS = ["CSC_NAME", "CSC_LINK", "CSC_KEY_PASSWORD"];
/** Notarization's — never passed to a local build. */
const NOTARY_VARS = ["APPLE_KEYCHAIN_PROFILE", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];

/** `KEY=value` and `export KEY=value` lines, quotes stripped; comments and anything else ignored. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

/**
 * The environment a local build runs in: the signing identity from the file (an identity already in
 * the environment wins — it was put there on purpose), and no notarization credentials at all. Pure.
 */
export function localSigningEnv(fileText, env) {
  const file = fileText ? parseEnvFile(fileText) : {};
  const next = { ...env };
  for (const k of NOTARY_VARS) delete next[k];
  const already = SIGNING_VARS.some((k) => env[k]);
  if (!already) for (const k of SIGNING_VARS) if (file[k]) next[k] = file[k];
  return { env: next, signing: Boolean(next.CSC_NAME || next.CSC_LINK) };
}

function main() {
  if (process.platform !== "darwin") throw new Error("local app installation is only supported on macOS");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const file = process.env.REALM_SIGNING_ENV || join(homedir(), ".config", "realm-signing.env");
  const { env, signing } = localSigningEnv(existsSync(file) ? readFileSync(file, "utf8") : "", process.env);
  console.log(signing
    ? `[app:update] signing with your Developer ID (${file}); not notarizing — a local install does not need it`
    : `[app:update] no signing identity (${file} is missing or names none) — building UNSIGNED`);
  execFileSync("pnpm", ["dist:dir"], { cwd: root, env, stdio: "inherit" });
  execFileSync(process.execPath, [join(root, "scripts", "install-local.mjs")], { cwd: root, env, stdio: "inherit" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(`[app:update] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
