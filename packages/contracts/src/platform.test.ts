import { describe, expect, it } from "vitest";
import { defaultShell, executableNames, needsShell, pathDelimiter, platformCapabilities, shellArgs } from "./platform";

describe("platformCapabilities", () => {
  it("gives a Mac every Mac feature", () => {
    const mac = platformCapabilities("darwin");
    expect(mac.os).toBe("mac");
    for (const k of ["windowMaterial", "insetTrafficLights", "accessibility", "simulators", "keychain", "laya", "macCli", "dockIcons", "autoUpdate", "quickLook", "shareMenu", "executionSandbox"] as const) {
      expect(mac[k], k).toBe(true);
    }
    expect(mac.fileManager).toBe("Finder");
  });

  it.each([["win32", "windows", "File Explorer"], ["linux", "linux", "Files"], ["freebsd", "linux", "Files"]] as const)("gives %s none of them", (platform, os, fileManager) => {
    const caps = platformCapabilities(platform);
    expect(caps.os).toBe(os);
    expect(caps.fileManager).toBe(fileManager);
    const flags = Object.entries(caps).filter(([, v]) => typeof v === "boolean");
    expect(flags.length).toBeGreaterThan(0);
    for (const [k, v] of flags) expect(v, k).toBe(false);
  });
});

describe("defaultShell", () => {
  it("keeps $SHELL on a Mac and Linux, with each one's own default when it is unset", () => {
    expect(defaultShell("darwin", { SHELL: "/opt/homebrew/bin/fish" })).toBe("/opt/homebrew/bin/fish");
    expect(defaultShell("darwin", {})).toBe("/bin/zsh");
    expect(defaultShell("linux", {})).toBe("/bin/bash");
  });

  it("is Windows PowerShell under SystemRoot on Windows, whatever $SHELL says", () => {
    expect(defaultShell("win32", { SHELL: "/usr/bin/bash", SystemRoot: "D:\\Windows" })).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(defaultShell("win32", {})).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });
});

describe("shellArgs", () => {
  it("starts a login shell on a Mac and Linux", () => {
    expect(shellArgs("darwin", "/bin/zsh")).toEqual(["-l"]);
    expect(shellArgs("linux", "/bin/bash")).toEqual(["-l"]);
  });

  it("never passes -l to a Windows shell", () => {
    expect(shellArgs("win32", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toEqual(["-NoLogo"]);
    expect(shellArgs("win32", "pwsh")).toEqual(["-NoLogo"]);
    expect(shellArgs("win32", "C:\\Windows\\System32\\cmd.exe")).toEqual([]);
  });

  it("runs one command line, in each shell's own spelling, when given one", () => {
    expect(shellArgs("darwin", "/bin/zsh", "python3 agent.py 'fix it'")).toEqual(["-l", "-c", "python3 agent.py 'fix it'"]);
    expect(shellArgs("linux", "/bin/bash", "true")).toEqual(["-l", "-c", "true"]);
    expect(shellArgs("win32", "pwsh", "agent.exe")).toEqual(["-NoLogo", "-Command", "agent.exe"]);
    expect(shellArgs("win32", "C:\\Windows\\System32\\cmd.exe", "agent.exe")).toEqual(["/d", "/s", "/c", "agent.exe"]);
    // An empty command is still a command: the shell runs nothing and exits, rather than staying open.
    expect(shellArgs("darwin", "/bin/zsh", "")).toEqual(["-l", "-c", ""]);
  });
});

describe("executable lookup on Windows", () => {
  it("splits PATH on ; only on Windows", () => {
    expect(pathDelimiter("win32")).toBe(";");
    expect(pathDelimiter("linux")).toBe(":");
    expect(pathDelimiter("darwin")).toBe(":");
  });

  it("tries each PATHEXT extension before the bare name", () => {
    expect(executableNames("claude", "win32", { PATHEXT: ".EXE;.CMD" })).toEqual(["claude.exe", "claude.cmd", "claude"]);
    expect(executableNames("claude", "win32", {})).toEqual(["claude.com", "claude.exe", "claude.bat", "claude.cmd", "claude"]);
    expect(executableNames("node.exe", "win32", {})).toEqual(["node.exe"]);
    expect(executableNames("claude", "darwin", { PATHEXT: ".EXE" })).toEqual(["claude"]);
  });

  it("sends only batch files through the shell, and only on Windows", () => {
    expect(needsShell("C:\\npm\\codex.cmd", "win32")).toBe(true);
    expect(needsShell("C:\\npm\\codex.BAT", "win32")).toBe(true);
    expect(needsShell("C:\\bin\\codex.exe", "win32")).toBe(false);
    expect(needsShell("/usr/local/bin/codex.cmd", "linux")).toBe(false);
  });
});
