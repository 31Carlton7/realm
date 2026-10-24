import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIM = join(SERVER, "bin", "realm");

function shimAt(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(SHIM, path); chmodSync(path, 0o755);
  return path;
}

/** A server package laid out the way `stage-pack.mjs` ships it, with a realm.js that reports how it
 *  was started instead of doing anything. */
function layout(root: string): string {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "realm.js"), "console.log(JSON.stringify({ script: process.argv[1], args: process.argv.slice(2), asNode: process.env.ELECTRON_RUN_AS_NODE ?? null }))");
  return shimAt(join(root, "bin", "realm"));
}

/** A packaged app's resources: the server package, app.asar, and the app binary at `app`, which
 *  stands in for Electron as Node itself (it honours being run "as node" trivially). */
function packaged(resources: string, app: string): void {
  layout(join(resources, "server"));
  writeFileSync(join(resources, "app.asar"), "");
  mkdirSync(dirname(app), { recursive: true });
  writeFileSync(app, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`); chmodSync(app, 0o755);
}

/** No node on PATH, so only the app's own binary can have run it. */
const run = (shim: string, args: string[]) => JSON.parse(execFileSync(shim, args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }));

describe.skipIf(process.platform === "win32")("bin/realm", () => {
  it("runs dist/realm.js on node from a source checkout, through a symlink, with the arguments intact", () => {
    const shim = layout(join(tempDir("realm-shim-"), "server"));
    const link = join(tempDir("realm-shim-bin-"), "realm");
    symlinkSync(shim, link);
    const out = JSON.parse(execFileSync(link, ["run", "/r", "--", "agent 'fix it'"], { encoding: "utf8" }));
    expect(out).toMatchObject({ args: ["run", "/r", "--", "agent 'fix it'"], asNode: null });
  });

  it("prefers the app's own binary, as Node, inside Realm.app", () => {
    const contents = join(tempDir("realm-shim-app-"), "Realm.app", "Contents");
    packaged(join(contents, "Resources"), join(contents, "MacOS", "Realm"));
    expect(run(join(contents, "Resources", "server", "bin", "realm"), ["ps"])).toMatchObject({ args: ["ps"], asNode: "1" });
  });

  it("runs from <resources>/bin in Realm.app and in an extracted AppImage, on the server beside it", () => {
    const contents = join(tempDir("realm-shim-mac-"), "Realm.app", "Contents");
    packaged(join(contents, "Resources"), join(contents, "MacOS", "Realm"));
    expect(run(shimAt(join(contents, "Resources", "bin", "realm")), ["status"]))
      .toEqual({ script: join(contents, "Resources", "server", "dist", "realm.js"), args: ["status"], asNode: "1" });

    const root = join(tempDir("realm-shim-linux-"), "squashfs-root");
    packaged(join(root, "resources"), join(root, "realm"));
    expect(run(shimAt(join(root, "resources", "bin", "realm")), ["serve", "--port", "8796"]))
      .toEqual({ script: join(root, "resources", "server", "dist", "realm.js"), args: ["serve", "--port", "8796"], asNode: "1" });
  });

  it("is what every packaged app ships at <resources>/bin, with realm.cmd for Windows", () => {
    const builder = readFileSync(join(SERVER, "..", "desktop", "electron-builder.yml"), "utf8");
    expect(builder).toMatch(/\n {2}- from: \.\.\/server\/bin\n {4}to: bin\n/);
    // cmd.exe finds a batch file's labels reliably only with CRLF, which .gitattributes keeps.
    const cmd = readFileSync(join(SERVER, "bin", "realm.cmd"), "utf8");
    expect(cmd.replaceAll("\r\n", "")).not.toContain("\n");
  });
});

describe.runIf(process.platform === "win32")("bin/realm.cmd", () => {
  it("runs from <resources>\\bin on Realm.exe as Node", () => {
    const root = tempDir("realm-shim-win-");
    const resources = join(root, "resources");
    layout(join(resources, "server"));
    writeFileSync(join(resources, "app.asar"), "");
    // node.exe under the app's name: Electron run as Node, as far as the launcher can tell.
    copyFileSync(process.execPath, join(root, "Realm.exe"));
    const cmd = join(resources, "bin", "realm.cmd");
    copyFileSync(join(SERVER, "bin", "realm.cmd"), cmd);
    const out = JSON.parse(execFileSync("cmd.exe", ["/d", "/c", cmd, "status"], { encoding: "utf8", env: { ...process.env, PATH: "C:\\Windows\\System32" } }));
    expect(out).toMatchObject({ args: ["status"], asNode: "1" });
  });
});
