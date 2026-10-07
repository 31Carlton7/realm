import { describe, expect, it } from "vitest";
import { editorApp, installedEditors, openInEditor } from "./editors";

const HOME = "/Users/u";
const has = (...paths: string[]) => (p: string) => paths.includes(p);

describe("finding the editors this Mac has", () => {
  it("lists only the installed ones, in the order a default is taken in", () => {
    // THE offered-anyway mutant: list all four, and the menu offers Xcode to someone without it.
    const found = installedEditors(has("/Applications/Zed.app", "/Applications/Cursor.app"), HOME);
    expect(found).toEqual([{ id: "cursor", name: "Cursor" }, { id: "zed", name: "Zed" }]);
  });

  it("looks in the user's own Applications folder too", () => {
    expect(editorApp("vscode", has(`${HOME}/Applications/Visual Studio Code.app`), HOME)).toBe(`${HOME}/Applications/Visual Studio Code.app`);
    expect(editorApp("vscode", has(), HOME)).toBeNull();
  });
});

describe("opening a path in one", () => {
  it("hands the path to the app through `open -a`, one argv entry, no shell", async () => {
    const calls: [string, string[]][] = [];
    const ok = await openInEditor("cursor", "/repo/src/a file.ts", async (cmd, args) => { calls.push([cmd, args]); }, has("/Applications/Cursor.app"), HOME);
    expect(ok).toBe(true);
    expect(calls).toEqual([["open", ["-a", "/Applications/Cursor.app", "/repo/src/a file.ts"]]]);
  });

  it("refuses an editor that is not installed, an id it does not know, and a path that is not absolute", async () => {
    const calls: unknown[] = [];
    const run = async (...a: unknown[]) => { calls.push(a); };
    // THE trusting mutant: run whatever the renderer asked for.
    expect(await openInEditor("zed", "/repo/a.ts", run, has(), HOME)).toBe(false);
    expect(await openInEditor("emacs", "/repo/a.ts", run, has("/Applications/Zed.app"), HOME)).toBe(false);
    expect(await openInEditor("zed", "-a /etc/passwd", run, has("/Applications/Zed.app"), HOME)).toBe(false);
    expect(await openInEditor("zed", null, run, has("/Applications/Zed.app"), HOME)).toBe(false);
    expect(calls).toEqual([]);
  });
});
