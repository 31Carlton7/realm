import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeQuitStep, confirmQuitCopy, decideQuit, lastWindowClosedStep, quitFlagsFor, quitOnSignals, type QuitTrigger } from "./quit-policy";

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

  it("ends the process for a signal and a shutdown, whatever is working, and never asks", () => {
    for (const working of [0, 1, 9]) {
      expect(cell("signal", working)).toBe("detach-and-exit");
      expect(cell("system-shutdown", working)).toBe("quit-all");
    }
  });
});

describe("before-quit", () => {
  const cmdQ = { quittingForReal: false, detachOnQuit: false };

  it("still turns ⌘Q and the menu's Quit into resident mode", () => {
    expect(beforeQuitStep(cmdQ)).toBe("go-resident");
  });

  it("lets a signal's quit through, leaving the daemon running", () => {
    // MUTANT: no flags for a signal (what main did) and SIGTERM is cancelled like ⌘Q, forever.
    expect(beforeQuitStep(quitFlagsFor("signal"))).toBe("detach");
  });

  it("quits for real on a logout or shutdown, stopping the daemon first", () => {
    expect(beforeQuitStep(quitFlagsFor("system-shutdown"))).toBe("stop-server");
  });

  it("is the tray's quit after Quit Realm & stop agents, and an update's detach after one", () => {
    expect(beforeQuitStep({ quittingForReal: true, detachOnQuit: false })).toBe("stop-server");
    expect(beforeQuitStep({ quittingForReal: true, detachOnQuit: true })).toBe("detach");
  });
});

describe("quitOnSignals", () => {
  it("quits once for each of SIGTERM, SIGINT and SIGHUP", () => {
    const proc = new EventEmitter();
    const got: string[] = [];
    quitOnSignals(proc as unknown as NodeJS.Process, (s) => got.push(s));
    for (const s of ["SIGTERM", "SIGINT", "SIGHUP", "SIGTERM"]) proc.emit(s);
    expect(got).toEqual(["SIGTERM", "SIGINT", "SIGHUP"]);
  });

  it("survives the first SIGTERM to quit, and leaves the second its default action", async () => {
    // A real process, because the claim is about the signal: handled once, as Electron's own handler
    // is, and then fatal, so a quit that hangs can still be ended without SIGKILL.
    const child = spawn(process.execPath, ["--input-type=module", "-e", [
      `const { quitOnSignals } = await import(${JSON.stringify(join(__dirname, "quit-policy.ts"))});`,
      `quitOnSignals(process, (s) => console.log("quit " + s));`,
      `console.log("ready");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const saw = (text: string) => new Promise<void>((resolve) => {
      const check = () => { if (out.includes(text)) resolve(); };
      child.stdout.on("data", (b: Buffer) => { out += b; check(); });
      check();
    });
    try {
      await saw("ready");
      child.kill("SIGTERM");
      await saw("quit SIGTERM");
      expect(child.exitCode).toBeNull();
      child.kill("SIGTERM");
      const [code, signal] = await once(child, "exit");
      expect([code, signal]).toEqual([null, "SIGTERM"]);
    } finally {
      child.kill("SIGKILL");
    }
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
    expect(beforeQuit.indexOf("beforeQuitStep({ quittingForReal, detachOnQuit })")).toBeGreaterThan(0);
    expect(beforeQuit.indexOf('if (step === "detach") { detachFromDaemon(); return; }')).toBeGreaterThan(0);
    expect(beforeQuit.indexOf("stopDaemon()")).toBeGreaterThan(0);
    expect(beforeQuit.indexOf('if (step === "detach")')).toBeLessThan(beforeQuit.indexOf("stopDaemon()"));
  });

  it("is that exit for an update restart, and for a launch that failed to start", () => {
    expect(src).toMatch(/on\("before-quit-for-update", \(\) => \{[^}]*detachOnQuit = true/);
    expect(src).toMatch(/showErrorBox\("Realm failed to start"[\s\S]{0,300}?quittingForReal = true;\s*detachOnQuit = true;\s*app\.quit\(\)/);
  });
});

describe("main quits for real when told to by a signal or by macOS", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");

  it("takes the signals over and listens for a shutdown as soon as the app is ready", () => {
    // After `ready`, because Electron installs its own signal handlers just before it.
    expect(src).toMatch(/app\.whenReady\(\)\.then\(async \(\) => \{\s*quitWhenTold\(\);/);
    const fn = src.slice(src.indexOf("function quitWhenTold() {"), src.indexOf("app.whenReady().then("));
    expect(fn).toMatch(/quitOnSignals\(process, [\s\S]*?= quitFlagsFor\("signal"\)\);[\s\S]*?app\.quit\(\);/);
    expect(fn).toMatch(/powerMonitor\.on\("shutdown", \(\) => \{ \(\{ quittingForReal, detachOnQuit \} = quitFlagsFor\("system-shutdown"\)\); \}\)/);
  });
});

describe("lastWindowClosedStep", () => {
  it("goes to the menu bar once the launch has opened its windows", () => {
    expect(lastWindowClosedStep({ quittingForReal: false, launched: true })).toBe("go-resident");
    expect(lastWindowClosedStep({ quittingForReal: true, launched: true })).toBe("nothing");
  });

  it("does nothing when the only window was the launch's maintenance notice", () => {
    // MUTANT: drop `launched` and closing the notice mid-wait hides the Dock and raises the tray,
    // then the launch opens its window with no Dock icon and the tray still up.
    expect(lastWindowClosedStep({ quittingForReal: false, launched: false })).toBe("nothing");
  });
});
