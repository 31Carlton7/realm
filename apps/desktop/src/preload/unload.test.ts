import { EventEmitter } from "node:events";
import { beforeAll, describe, expect, it, vi } from "vitest";

const exposed: Record<string, unknown> = {};
const ipc = Object.assign(new EventEmitter(), {
  sent: [] as unknown[][],
  send(...args: unknown[]) { ipc.sent.push(args); },
  sendSync: () => null,
  invoke: async () => null,
});

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { exposed[key] = api; } },
  ipcRenderer: ipc,
  webFrame: { getZoomFactor: () => 1 },
  webUtils: { getPathForFile: () => "" },
}));

type Windows = { onUnload: (save: () => Promise<string | null>, abort: () => void) => () => void };

describe("a page asked to write its view down before main unloads it", () => {
  beforeAll(async () => {
    // Electron's own process methods, which the preload reads as it loads.
    Object.assign(process, { getSystemVersion: () => "26.0.0" });
    await import("./index");
  });

  it("answers unsaved when writing its view down throws, so main keeps it", async () => {
    // THE MUTANT: a throw read as nothing to keep, and the page is unloaded with whatever it held.
    const { windows } = exposed.realm as { windows: Windows };
    const off = windows.onUnload(async () => { throw new Error("the store is mid-update"); }, () => {});
    ipc.emit("window:unload");
    await vi.waitFor(() => expect(ipc.sent).toContainEqual(["window:unload-ready", "unsaved"]));
    off();
  });
});
