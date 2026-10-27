import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { confirmQuitCopy, decideQuit, type QuitTrigger } from "./quit-policy";

describe("decideQuit", () => {
  const cell = (trigger: QuitTrigger, working: number) => decideQuit({ trigger, working }).kind;

  it("over every trigger by whether anything is working", () => {
    for (const working of [0, 1, 9]) {
      // Closing the window and ⌘Q are the same gesture: done looking, not done working.
      expect(cell("window-closed", working)).toBe("go-resident");
      expect(cell("quit", working)).toBe("go-resident");
      // An update restart deliberately leaves the daemon alone — the opposite of what this hook used
      // to do, and the reason an update no longer stops every agent.
      expect(cell("update-restart", working)).toBe("detach-and-exit");
    }
    expect(cell("quit-all", 0)).toBe("quit-all");
    expect(cell("quit-all", 1)).toBe("confirm");
    expect(decideQuit({ trigger: "quit-all", working: 3 })).toEqual({ kind: "confirm", working: 3 });
  });
});

describe("the confirmation's words", () => {
  it("names the consequence and the number, and says what the other choice is", () => {
    const one = confirmQuitCopy(1);
    expect(one.message).toBe("Quit Realm and stop it?");
    expect(one.detail).toContain("1 session is working.");
    expect(one.detail).toContain("Closing the window instead leaves them running.");
    const many = confirmQuitCopy(4);
    expect(many.message).toBe("Quit Realm and stop them?");
    expect(many.detail).toContain("4 sessions are working.");
  });
});

describe("main leaves the daemon running when it exits for an update or a failed launch", () => {
  // Read as text: importing main would start an Electron app. `quitAndInstall` closes the windows and
  // then calls `app.quit()`, so `before-quit` runs after `before-quit-for-update` — and used to stop the
  // daemon there, every running agent with it. (An update stops it itself now, before it asks for the
  // quit, once the installer holds the update: `stopServerForUpdate`.)
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const beforeQuit = src.slice(src.indexOf('app.on("before-quit", (e) => {'));

  it("checks for that exit before anything that would stop the daemon", () => {
    expect(beforeQuit.indexOf("if (detachOnQuit) { detachFromDaemon(); return; }")).toBeGreaterThan(0);
    expect(beforeQuit.indexOf("stopDaemon()")).toBeGreaterThan(0);
    expect(beforeQuit.indexOf("if (detachOnQuit)")).toBeLessThan(beforeQuit.indexOf("stopDaemon()"));
  });

  it("is that exit for an update restart, and for a launch that failed to start", () => {
    expect(src).toMatch(/on\("before-quit-for-update", \(\) => \{[^}]*detachOnQuit = true/);
    expect(src).toMatch(/showErrorBox\("Realm failed to start"[\s\S]{0,300}?quittingForReal = true;\s*detachOnQuit = true;\s*app\.quit\(\)/);
  });
});
