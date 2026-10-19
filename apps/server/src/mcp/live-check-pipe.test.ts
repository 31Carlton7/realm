import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { liveCheck } from "./live-check";
import type { McpServerRow } from "../store/mcp";

/**
 * A command that is already gone when the initialize request is written: the write fails with EPIPE,
 * then the exit arrives. The real race only loses on a loaded machine (the full suite lost it once);
 * this child loses it every time.
 */
vi.mock("node:child_process", async (importOriginal) => ({
  // Only `spawn` is faked: the rest of the module stays real for whatever else the check loads.
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stdin: new Writable({
        write(_chunk, _encoding, callback) {
          callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        },
      }),
      kill: () => true,
    });
    setTimeout(() => child.emit("exit", 3), 20);
    return child;
  },
}));

const row: McpServerRow = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "probe", transport: "stdio", command: "gone", args: [], url: "", secrets: {},
  oauthJson: "", tools: [], scope: { kind: "space", spaceId: null }, createdAt: 0, updatedAt: 0,
};

describe("liveCheck, stdio", () => {
  it("reports a command that exits before reading, instead of crashing the server on the write", async () => {
    const uncaught: unknown[] = [];
    const record = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", record);
    try {
      expect(await liveCheck(row)).toEqual({ reached: false, detail: "the command exited (code 3) before answering the initialize request" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", record);
    }
  });
});
