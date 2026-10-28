import { describe, expect, it } from "vitest";
import { labelAppProcesses } from "./app-metrics";

describe("naming the app's processes for the resource report", () => {
  it("tells a browser pane's renderer from a window's, and names the GPU and utility processes", () => {
    const labels = labelAppProcesses({
      metrics: [
        { pid: 1, type: "Browser" },
        { pid: 2, type: "GPU" },
        { pid: 3, type: "Tab" },
        { pid: 4, type: "Tab" },
        { pid: 5, type: "Utility", name: "Network Service", serviceName: "network.mojom.NetworkService" },
        { pid: 6, type: "Tab" },
      ],
      views: new Map([[4, { browserId: "b-1", title: "Linear", detail: null }]]),
      windows: new Map([[3, "Personal"]]),
    });
    expect(labels).toEqual([
      { pid: 1, kind: "main", label: "Realm", ownerId: null, detail: null },
      { pid: 2, kind: "gpu", label: "GPU", ownerId: null, detail: null },
      { pid: 3, kind: "window", label: "Personal", ownerId: null, detail: null },
      // THE MUTANT: checking windows before views would be wrong only if a pid were both; this one is
      // the view's, and owned by its browser so the server can name it from the pane's row.
      { pid: 4, kind: "browser", label: "Linear", ownerId: "b-1", detail: null },
      { pid: 5, kind: "utility", label: "Network Service", ownerId: null, detail: null },
      // A renderer nobody claims — DevTools, an MCP app's frame — is named by its type, not guessed.
      { pid: 6, kind: "other", label: "Tab", ownerId: null, detail: null },
    ]);
  });

  it("calls an untitled page a browser pane rather than nothing", () => {
    const [view] = labelAppProcesses({ metrics: [{ pid: 9, type: "Tab" }], views: new Map([[9, { browserId: "b", title: "", detail: null }]]), windows: new Map() });
    expect(view!.label).toBe("Browser pane");
  });
});
