import { describe, expect, it } from "vitest";
import { TerminalManager } from "./manager";
import { waitFor } from "../test-utils";

describe("TerminalManager", () => {
  it("spawns a shell, streams output, resizes, and closes without firing onExit", async () => {
    const chunks: string[] = []; const exits: number[] = [];
    const tm = new TerminalManager({
      onData: (_id, d) => chunks.push(d),
      onExit: (_id, code) => { exits.push(code); },
    });
    const { id, shell } = tm.create({ cwd: process.cwd(), cols: 80, rows: 24, shell: "/bin/sh" });
    expect(shell).toBe("/bin/sh");
    tm.write(id, "echo REALM_OK\n");
    await waitFor(() => chunks.join("").includes("REALM_OK"));
    tm.resize(id, 100, 30);
    tm.resize(id, 100000, 0); // clamped, must not throw
    tm.close(id);
    expect(tm.has(id)).toBe(false);
    // Explicit close: the pty still exits asynchronously, but the callback must stay silent.
    await new Promise((r) => setTimeout(r, 300));
    expect(exits).toEqual([]);
  });
  it("notifies onExit only for spontaneous exits", async () => {
    let exit: { id: string; code: number } | null = null;
    const tm = new TerminalManager({ onData: () => {}, onExit: (id, code) => { exit = { id, code }; } });
    const { id } = tm.create({ cwd: process.cwd(), cols: 80, rows: 24, shell: "/bin/sh" });
    tm.write(id, "exit\n");
    await waitFor(() => exit !== null);
    expect(exit!.id).toBe(id);
    expect(tm.has(id)).toBe(false);
  });
  it.each([
    ["darwin", "/bin/zsh", ["-l"]],
    ["linux", "/bin/bash", ["-l"]],
    ["win32", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoLogo"]],
  ])("on %s, spawns the platform's shell with the arguments it accepts", (platform, shell, args) => {
    const prev = { SHELL: process.env.SHELL, SystemRoot: process.env.SystemRoot };
    delete process.env.SHELL; process.env.SystemRoot = "C:\\Windows";
    try {
      const tm = new TerminalManager({ onData: () => {}, onExit: () => {} }, Date.now, platform);
      let seen: { command: string; args: string[] } | null = null;
      // The wrap hook sees the argv before it becomes a process; throwing there spawns nothing.
      expect(() => tm.create({ cwd: process.cwd(), cols: 80, rows: 24, wrap: (command, a) => { seen = { command, args: a }; throw new Error("stop"); } })).toThrow("stop");
      expect(seen).toEqual({ command: shell, args });
    } finally {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
  it("throws NOT_FOUND for unknown terminal", () => {
    const tm = new TerminalManager({ onData: () => {}, onExit: () => {} });
    expect(() => tm.write("nope", "x")).toThrowError(/not found/);
    expect(() => tm.close("nope")).toThrowError(/not found/);
  });

  it("writeWhenQuiet holds the command until the shell stops printing, then types it whole", async () => {
    // A shell that talks for a while on startup. Writing into that stream is what mangled the
    // install card's command (the leading character got eaten).
    const tm = new TerminalManager({ onData: () => {}, onExit: () => {} });
    const { id } = tm.create({ cwd: process.cwd(), cols: 80, rows: 24, shell: "/bin/sh" });
    const written: string[] = [];
    (tm as unknown as { write: (i: string, d: string) => void }).write = (_i, d) => { written.push(d); };
    tm.write(id, "");                       // reset the stub's own record
    written.length = 0;
    await tm.writeWhenQuiet(id, "npm install -g pkg", 60, 2000);
    expect(written).toEqual(["npm install -g pkg"]);
    expect(written[0]).not.toMatch(/[\r\n]$/); // typed, never run
    tm.close(id);
  });

  it("writeWhenQuiet gives up waiting rather than never typing at all", async () => {
    // A shell that never goes quiet must still get the command — late and whole beats never.
    const tm = new TerminalManager({ onData: () => {}, onExit: () => {} }, () => 0);
    const { id } = tm.create({ cwd: process.cwd(), cols: 80, rows: 24, shell: "/bin/sh" });
    const written: string[] = [];
    (tm as unknown as { write: (i: string, d: string) => void }).write = (_i, d) => { written.push(d); };
    written.length = 0;
    await tm.writeWhenQuiet(id, "cmd", 0, 0);   // deadline already passed
    expect(written).toEqual(["cmd"]);
    tm.close(id);
  });

  it("writeWhenQuiet drops the write if the shell dies while it waits", async () => {
    const tm = new TerminalManager({ onData: () => {}, onExit: () => {} });
    const { id } = tm.create({ cwd: process.cwd(), cols: 80, rows: 24, shell: "/bin/sh" });
    const written: string[] = [];
    (tm as unknown as { write: (i: string, d: string) => void }).write = (_i, d) => { written.push(d); };
    written.length = 0;
    const p = tm.writeWhenQuiet(id, "cmd", 400, 4000);
    tm.close(id);
    await p;
    expect(written).toEqual([]);
  });
});
