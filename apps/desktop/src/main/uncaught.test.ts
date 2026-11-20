import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const dialog = { showErrorBox: vi.fn(), showMessageBox: vi.fn(), showMessageBoxSync: vi.fn() };
vi.mock("electron", () => ({ dialog }));
const { logUncaught } = await import("./uncaught");

function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}

function installed() {
  const proc = new EventEmitter();
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  logUncaught(proc);
  return { proc, lines };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("logUncaught", () => {
  // Mutant: install no listener. Electron then shows its own app-modal error box (#567).
  it("listens for both uncaught exceptions and unhandled rejections", () => {
    const { proc } = installed();
    expect(proc.listenerCount("uncaughtException")).toBe(1);
    expect(proc.listenerCount("unhandledRejection")).toBe(1);
  });

  // Mutant: rethrow from the listener, or drop "Uncaught" from the line. The release check counts
  // "Uncaught" in the packaged app's stderr, so a throw must still show up there.
  it("logs an uncaught exception with its stack and returns", () => {
    const { proc, lines } = installed();
    const error = new Error("Object has been destroyed");
    expect(() => proc.emit("uncaughtException", error, "uncaughtException")).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Uncaught");
    expect(lines[0]).toContain(error.stack);
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it("logs an unhandled rejection with its stack and returns", () => {
    const { proc, lines } = installed();
    const error = new TypeError("page.close is not a function");
    expect(() => proc.emit("unhandledRejection", error, Promise.resolve())).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Uncaught");
    expect(lines[0]).toContain(error.stack);
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it("logs a rejection with something other than an Error", () => {
    const { proc, lines } = installed();
    expect(() => proc.emit("unhandledRejection", "timed out", Promise.resolve())).not.toThrow();
    expect(lines).toEqual([expect.stringMatching(/Uncaught.*timed out/)]);
  });
});

describe("main's startup", () => {
  // Mutant: move the call below the first statement that can throw, or delete it.
  it("installs the listeners before anything else runs", () => {
    const source = readFileSync(repoFile("apps/desktop/src/main/index.ts"), "utf8");
    const firstStatement = source.split("\n").find((line) => line.trim() && !/^(import\b|\s|\}|\/\/|\/\*|\*)/.test(line));
    expect(firstStatement).toBe("logUncaught();");
  });
});
