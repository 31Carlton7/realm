import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import { findExecutable, killTree, spawnTarget } from "./spawn-target";

const scratch = () => tempDir("realm-spawn-");

describe("findExecutable", () => {
  // A real execute bit and a ":"-joined PATH of real directories: only a POSIX host has either.
  it.skipIf(process.platform === "win32")("finds the first executable on a POSIX PATH and skips files that are not", () => {
    const a = scratch(); const b = scratch();
    writeFileSync(join(a, "codex"), "#!/bin/sh\n"); // not executable
    writeFileSync(join(b, "codex"), "#!/bin/sh\n"); chmodSync(join(b, "codex"), 0o755);
    expect(findExecutable("codex", { PATH: `${a}:${b}` }, "linux")).toBe(join(b, "codex"));
    expect(findExecutable("missing", { PATH: `${a}:${b}` }, "linux")).toBeNull();
  });

  it("on Windows, finds an npm .cmd shim through PATHEXT and splits PATH on ;", () => {
    const a = scratch(); const b = scratch();
    // The extensionless file npm also writes is a POSIX script Windows cannot run; the .cmd is what runs.
    writeFileSync(join(b, "codex"), "#!/bin/sh\n");
    writeFileSync(join(b, "codex.cmd"), "@echo off\n");
    mkdirSync(join(a, "codex.exe")); // a directory named like the command is not it
    expect(findExecutable("codex", { PATH: `${a};${b}`, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(join(b, "codex.cmd"));
  });
});

describe("spawnTarget", () => {
  it("leaves the command alone on a Mac and Linux", () => {
    for (const platform of ["darwin", "linux"]) {
      expect(spawnTarget("codex", ["app-server"], { platform, env: {} })).toEqual({ command: "codex", args: ["app-server"], options: {} });
    }
  });

  it("runs a resolved .exe directly on Windows", () => {
    const b = scratch();
    writeFileSync(join(b, "cursor-agent.exe"), "");
    expect(spawnTarget("cursor-agent", ["acp"], { platform: "win32", env: { PATH: b, PATHEXT: ".EXE;.CMD" } }))
      .toEqual({ command: join(b, "cursor-agent.exe"), args: ["acp"], options: { windowsHide: true } });
  });

  it("runs a .cmd through cmd.exe with every argument quoted and its metacharacters escaped", () => {
    const b = scratch();
    writeFileSync(join(b, "codex.cmd"), "");
    const t = spawnTarget("codex", ["app-server", "a & b", 'say "hi"'], { platform: "win32", env: { PATH: b, PATHEXT: ".CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" } });
    expect(t.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(t.options).toEqual({ windowsVerbatimArguments: true, windowsHide: true });
    expect(t.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    const line = t.args[3]!;
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    // The & is carried as a literal (^&), never as cmd's command separator.
    expect(line).toContain('^"a^ ^&^ b^"');
    expect(line).toContain('^"say^ \\^"hi\\^"^"');
  });
});

describe("killTree", () => {
  const fakeChild = (pid: number) => Object.assign(new EventEmitter(), { pid, kill: vi.fn() }) as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };

  it("signals the child itself on a Mac and Linux", () => {
    const child = fakeChild(42);
    const spawnFn = vi.fn();
    killTree(child, "SIGKILL", "linux", spawnFn as never);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("takes the whole tree with taskkill on Windows", () => {
    const child = fakeChild(42);
    const spawnFn = vi.fn(() => new EventEmitter());
    killTree(child, "SIGKILL", "win32", spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith("taskkill", ["/pid", "42", "/T", "/F"], expect.objectContaining({ windowsHide: true }));
    expect(child.kill).not.toHaveBeenCalled();
  });
});
