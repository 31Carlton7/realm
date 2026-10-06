import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistBrowserPages } from "./persist-pages";

/**
 * A browser's page saved whether or not a pane shows it. What must die: an agent's browser that no
 * pane is showing keeping its old title in the sidebar (09-23), a restored tab renamed "Browser" or
 * stripped of its icon while its page reloads, and one browser's write cancelling another's.
 */
/** A file of this repository, found upward from where the suite runs — styles.test.ts's way. */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}

type State = { id: string; url: string; title: string; loading: boolean; favicon: string | null; error: { code: number; name: string; url: string } | null };

function rig(rows: Record<string, { url: string; title: string; favicon: string }> = {}) {
  let emit: (s: State) => void = () => {};
  const writes: { id: string; url: string; title: string; favicon: string; failed?: boolean }[] = [];
  const stop = persistBrowserPages({
    host: { onState: (cb) => { emit = cb as never; return () => { emit = () => {}; }; } },
    server: {
      get: async (id) => { const r = rows[id]; if (!r) throw new Error("no row"); return r; },
      update: async (id, patch) => { writes.push({ id, ...patch }); },
    },
    debounceMs: 50,
  });
  const state = (s: Partial<State> & { id: string }) => emit({ url: "", title: "", loading: false, favicon: null, error: null, ...s });
  const settle = async () => { await vi.advanceTimersByTimeAsync(60); };
  return { state, writes, settle, stop };
}

afterEach(() => { vi.useRealTimers(); });

describe("persistBrowserPages", () => {
  it("saves a page no pane is showing — the agent's browser keeps its sidebar row true", async () => {
    vi.useFakeTimers();
    const r = rig({ b1: { url: "https://a.example", title: "A", favicon: "" } });
    // THE MUTANT: save only from a mounted pane. Nothing here is a pane, and the row stays "A".
    r.state({ id: "b1", url: "https://b.example", title: "B" });
    await r.settle();
    expect(r.writes).toEqual([{ id: "b1", url: "https://b.example", title: "B", favicon: "" }]);
  });

  it("waits for the page to load and to have a title", async () => {
    vi.useFakeTimers();
    const r = rig({ b1: { url: "https://a.example", title: "A", favicon: "" } });
    r.state({ id: "b1", url: "https://b.example", title: "B", loading: true });
    r.state({ id: "b1", url: "https://b.example", title: "" });
    r.state({ id: "b1", url: "", title: "Browser" });
    await r.settle();
    // THE MUTANT: save any state. A restored tab is renamed "Browser" while its page is on the way.
    expect(r.writes).toEqual([]);
  });

  it("writes once for a burst, the last of it", async () => {
    vi.useFakeTimers();
    const r = rig({ b1: { url: "", title: "", favicon: "" } });
    for (const t of ["one", "two", "three"]) r.state({ id: "b1", url: `https://x.example/${t}`, title: t });
    await r.settle();
    expect(r.writes.map((w) => w.title)).toEqual(["three"]);
  });

  it("keeps a restored tab's icon while its page reloads, and drops it at a new address", async () => {
    vi.useFakeTimers();
    const r = rig({ b1: { url: "https://a.example", title: "A", favicon: "data:icon" } });
    r.state({ id: "b1", url: "https://a.example", title: "A — reloaded", favicon: null });
    await r.settle();
    // THE MUTANT: read no saved row. The icon is lost until the page offers it again.
    expect(r.writes.at(-1)).toEqual({ id: "b1", url: "https://a.example", title: "A — reloaded", favicon: "data:icon" });
    r.state({ id: "b1", url: "https://elsewhere.example", title: "E", favicon: null });
    await r.settle();
    expect(r.writes.at(-1)?.favicon).toBe("");
  });

  it("does not rewrite what is saved, and a return to it cancels a pending write", async () => {
    vi.useFakeTimers();
    const r = rig({ b1: { url: "https://a.example", title: "A", favicon: "" } });
    r.state({ id: "b1", url: "https://a.example", title: "A" });
    await r.settle();
    expect(r.writes).toEqual([]);
    r.state({ id: "b1", url: "https://b.example", title: "B" });
    r.state({ id: "b1", url: "https://a.example", title: "A" });
    await r.settle();
    expect(r.writes).toEqual([]);
  });

  it("saves a page that did not load as one, so the server keeps it out of the history", async () => {
    vi.useFakeTimers();
    const r = rig({ b1: { url: "", title: "", favicon: "" } });
    // THE MUTANT: save it as any other page. A blank tab's Recently visited lists the refused address.
    r.state({ id: "b1", url: "http://localhost:3000/", title: "localhost:3000", error: { code: -102, name: "ERR_CONNECTION_REFUSED", url: "http://localhost:3000/" } });
    await r.settle();
    expect(r.writes).toEqual([{ id: "b1", url: "http://localhost:3000/", title: "localhost:3000", favicon: "", failed: true }]);
  });

  it("writes the page that loads after a failure, even at the address and title already saved", async () => {
    vi.useFakeTimers();
    const r = rig({ b1: { url: "", title: "", favicon: "" } });
    const refused = { code: -102, name: "ERR_CONNECTION_REFUSED", url: "http://localhost:3000/" };
    r.state({ id: "b1", url: "http://localhost:3000/", title: "localhost:3000", error: refused });
    await r.settle();
    // THE MUTANT: compare the address, title and icon alone. A page with no <title> of its own is
    // named by its host, as its error page was, so the Reload that brought it in wrote nothing — and
    // the visit it was is never told to the server.
    r.state({ id: "b1", url: "http://localhost:3000/", title: "localhost:3000" });
    await r.settle();
    expect(r.writes.at(-1)).toEqual({ id: "b1", url: "http://localhost:3000/", title: "localhost:3000", favicon: "" });
    expect(r.writes).toHaveLength(2);
  });

  it("keeps each browser's write its own", async () => {
    vi.useFakeTimers();
    const r = rig({ b1: { url: "", title: "", favicon: "" }, b2: { url: "", title: "", favicon: "" } });
    r.state({ id: "b1", url: "https://one.example", title: "One" });
    r.state({ id: "b2", url: "https://two.example", title: "Two" });
    await r.settle();
    // THE MUTANT: one timer for every browser. The second browser's page cancels the first's write.
    expect(r.writes.map((w) => w.id).sort()).toEqual(["b1", "b2"]);
  });

  it("saves a browser whose row cannot be read, and does nothing without a browser bridge", async () => {
    vi.useFakeTimers();
    const r = rig({});
    r.state({ id: "b9", url: "https://n.example", title: "N" });
    await r.settle();
    expect(r.writes).toEqual([{ id: "b9", url: "https://n.example", title: "N", favicon: "" }]);
    expect(persistBrowserPages({ host: {}, server: { get: async () => ({ url: "", title: "", favicon: "" }), update: async () => {} } })()).toBeUndefined();
  });

  it("is started by the app for every browser, and stopped with it", () => {
    // THE MUTANT: a saver nobody starts. The pane no longer saves, so no title would be saved at all —
    // and the tests above start their own saver, so only this line would notice.
    const app = readFileSync(repoFile("apps/desktop/src/renderer/src/App.tsx"), "utf8");
    expect(app).toMatch(/const offPages = persistBrowserPages\(getBrowserBridges\(\)\);/);
    expect(app).toMatch(/offPages\(\);/);
  });
});
