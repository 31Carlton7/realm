import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";

const SHIM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "realm");

/** A server package laid out the way `stage-pack.mjs` ships it, with a realm.js that reports how it
 *  was started instead of doing anything. */
function layout(root: string): string {
  mkdirSync(join(root, "bin"), { recursive: true }); mkdirSync(join(root, "dist"));
  copyFileSync(SHIM, join(root, "bin", "realm")); chmodSync(join(root, "bin", "realm"), 0o755);
  writeFileSync(join(root, "dist", "realm.js"), "console.log(JSON.stringify({ args: process.argv.slice(2), asNode: process.env.ELECTRON_RUN_AS_NODE ?? null }))");
  return join(root, "bin", "realm");
}

describe.skipIf(process.platform === "win32")("bin/realm", () => {
  it("runs dist/realm.js on node from a source checkout, through a symlink, with the arguments intact", () => {
    const shim = layout(join(tempDir("realm-shim-"), "server"));
    const link = join(tempDir("realm-shim-bin-"), "realm");
    symlinkSync(shim, link);
    const out = JSON.parse(execFileSync(link, ["run", "/r", "--", "agent 'fix it'"], { encoding: "utf8" }));
    expect(out).toEqual({ args: ["run", "/r", "--", "agent 'fix it'"], asNode: null });
  });

  it("prefers the app's own binary, as Node, inside Realm.app", () => {
    const contents = join(tempDir("realm-shim-app-"), "Realm.app", "Contents");
    const shim = layout(join(contents, "Resources", "server"));
    // The app binary stands in for Electron: Node itself, which honours being run "as node" trivially.
    mkdirSync(join(contents, "MacOS"));
    writeFileSync(join(contents, "MacOS", "Realm"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`); chmodSync(join(contents, "MacOS", "Realm"), 0o755);
    const out = JSON.parse(execFileSync(shim, ["ps"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }));
    expect(out).toEqual({ args: ["ps"], asNode: "1" });
  });
});
