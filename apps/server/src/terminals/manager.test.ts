import { describe, expect, it } from "vitest";
import { TerminalManager } from "./manager";
import { waitFor } from "../test-utils";

describe("TerminalManager", () => {
  it("spawns a shell, streams output, resizes, and closes", async () => {
    const chunks: string[] = []; let exit: number | null = null;
    const tm = new TerminalManager({
      onData: (_id, d) => chunks.push(d),
      onExit: (_id, code) => { exit = code; },
    });
    const { id, shell } = tm.create({ cwd: process.cwd(), cols: 80, rows: 24, shell: "/bin/sh" });
    expect(shell).toBe("/bin/sh");
    tm.write(id, "echo REALM_OK\n");
    await waitFor(() => chunks.join("").includes("REALM_OK"));
    tm.resize(id, 100, 30);
    tm.resize(id, 100000, 0); // clamped, must not throw
    tm.close(id);
    await waitFor(() => exit !== null);
    expect(tm.has(id)).toBe(false);
  });
  it("throws NOT_FOUND for unknown terminal", () => {
    const tm = new TerminalManager({ onData: () => {}, onExit: () => {} });
    expect(() => tm.write("nope", "x")).toThrowError(/not found/);
    expect(() => tm.close("nope")).toThrowError(/not found/);
  });
});
