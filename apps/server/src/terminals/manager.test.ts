import { describe, expect, it } from "vitest";
import { TerminalManager } from "./manager";

describe("TerminalManager", () => {
  it("spawns a shell, streams output, resizes, and closes", async () => {
    const chunks: string[] = []; let exit: number | null = null;
    const tm = new TerminalManager({
      onData: (_id, d) => chunks.push(d),
      onExit: (_id, code) => { exit = code; },
    });
    const id = tm.create({ cwd: process.cwd(), cols: 80, rows: 24, shell: "/bin/sh" });
    tm.write(id, "echo REALM_OK\n");
    await new Promise((r) => setTimeout(r, 400));
    expect(chunks.join("")).toContain("REALM_OK");
    tm.resize(id, 100, 30);
    tm.close(id);
    await new Promise((r) => setTimeout(r, 300));
    expect(exit).not.toBeNull();
    expect(tm.has(id)).toBe(false);
  });
  it("throws NOT_FOUND for unknown terminal", () => {
    const tm = new TerminalManager({ onData: () => {}, onExit: () => {} });
    expect(() => tm.write("nope", "x")).toThrowError(/not found/);
  });
});
