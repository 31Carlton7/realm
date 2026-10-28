/**
 * The app's own processes, named for the resource report (realm-server's `resources/attribute.ts`):
 * which renderer is a window, which is a browser pane's view, and what the GPU and utility processes
 * are. `app.getAppMetrics()` lists every one of them; only main knows which view a renderer draws.
 *
 * Sizes are not taken here. The server reads every Realm process's footprint itself, with the same
 * method it uses for its own (`machine.ts`) — Electron's `workingSetSize` is resident memory, the
 * number that reads small for exactly the processes macOS has compressed or swapped out.
 */

/** `ProcessMetric`, as much of it as this needs. */
export type MetricLike = { pid: number; type: string; name?: string; serviceName?: string };

/** The same shape as `AppProcess` in realm-server's `resources/attribute.ts` (the two compile apart). */
export type AppProcessLabel = {
  pid: number;
  kind: "main" | "gpu" | "utility" | "window" | "browser" | "other";
  label: string;
  ownerId: string | null;
  detail: string | null;
  /** A browser pane's view: since when it has been off screen, or null while it is on screen. */
  hiddenSince?: number | null;
};

export function labelAppProcesses(o: {
  metrics: readonly MetricLike[];
  /** Each live browser view's renderer: pid → the browser it draws and the page's title. */
  views: ReadonlyMap<number, { browserId: string; title: string; hiddenSince: number | null }>;
  /** Each window's renderer — Realm's own, and any a page opened — pid → what the window is called. */
  windows: ReadonlyMap<number, string>;
}): AppProcessLabel[] {
  return o.metrics.map((m): AppProcessLabel => {
    if (m.type === "Browser") return { pid: m.pid, kind: "main", label: "Realm", ownerId: null, detail: null };
    if (m.type === "GPU") return { pid: m.pid, kind: "gpu", label: "GPU", ownerId: null, detail: null };
    const view = o.views.get(m.pid);
    if (view) return { pid: m.pid, kind: "browser", label: view.title || "Browser pane", ownerId: view.browserId, detail: null, hiddenSince: view.hiddenSince };
    const win = o.windows.get(m.pid);
    if (win !== undefined) return { pid: m.pid, kind: "window", label: win || "Window", ownerId: null, detail: null };
    if (m.type === "Utility") return { pid: m.pid, kind: "utility", label: m.name || m.serviceName || "Utility", ownerId: null, detail: null };
    return { pid: m.pid, kind: "other", label: m.name || m.type, ownerId: null, detail: null };
  });
}
