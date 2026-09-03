import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Item } from "@realm/contracts";

/** Same rpc mock as documents-pane.test.tsx, extended so the test can fire `documents.openRequested`. */
const listeners = new Map<string, Set<(p: any) => void>>();
vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: (event: string, cb: (p: any) => void) => {
      let set = listeners.get(event); if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(cb);
      return () => set!.delete(cb);
    },
  }),
}));
const fire = (event: string, p: unknown) => { act(() => { for (const cb of [...(listeners.get(event) ?? [])]) cb(p); }); };

import { DocumentsPane } from "./DocumentsPane";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";

const DOCS_ID = "docs1";
const ENV = "env-s1";
const paneItem: Item = item("i1", "s1", { kind: "documents", title: "Documents", refId: DOCS_ID });

function renderPane(files: Record<string, string>, openPaths: string[] = [], activePath: string | null = null, extra: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({
    documentWorkspaces: { [DOCS_ID]: { id: DOCS_ID, spaceId: "s1", environmentId: ENV, openPaths, activePath, createdAt: 0, updatedAt: 0 } },
    documentFiles: { [DOCS_ID]: { ...files } },
    ...extra,
  });
  const store = createAppStore(api);
  render(<StoreContext.Provider value={store}><DocumentsPane item={paneItem} visible /></StoreContext.Provider>);
  return { api, store };
}

beforeEach(() => { listeners.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe("DocumentsPane — html guides (Plan 22)", () => {
  it("opens a guide in Preview: a sandboxed frame onto the preview server, with the file's hash as version", async () => {
    const { api } = renderPane({ "guides/g.html": "<p>hi</p>" }, ["guides/g.html"], "guides/g.html");
    const frame = await screen.findByTitle("Guide preview of guides/g.html") as HTMLIFrameElement;
    await waitFor(() => expect(api.calls).toContain("previewInfo"));
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups allow-modals");
    expect(frame.src).toMatch(/^http:\/\/127\.0\.0\.1:4321\/p\/tok\/docs1\/guides\/g\.html\?v=/);
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
  });

  it("Source shows the HTML for editing, and a save re-versions the frame", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = renderPane({ "g.html": "<p>hi</p>" }, ["g.html"], "g.html");
    await screen.findByTitle("Guide preview of g.html");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    const ta = await screen.findByLabelText("Edit g.html");
    expect(ta).toHaveValue("<p>hi</p>");
    fireEvent.change(ta, { target: { value: "<p>edited</p>" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    await waitFor(() => expect(api.calls).toContain("writeDocument:docs1:g.html"));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const frame = await screen.findByTitle("Guide preview of g.html") as HTMLIFrameElement;
    expect(decodeURIComponent(frame.src)).toContain("?v=h:13:<p>edited</p>");
  });

  it("answers the runtime's ready and attempt messages through the progress sidecar, only from its own frame", async () => {
    const { api } = renderPane({ "g.html": "<p>hi</p>" }, ["g.html"], "g.html");
    const frame = await screen.findByTitle("Guide preview of g.html") as HTMLIFrameElement;
    const posted: unknown[] = [];
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: (m: unknown) => posted.push(m) } });
    const from = (source: unknown, data: unknown) => act(() => { window.dispatchEvent(new MessageEvent("message", { data, source: source as Window })); });
    from(frame.contentWindow, { type: "realm-guide:ready" });
    await waitFor(() => expect(api.calls).toContain("readGuideProgress:docs1:g.html"));
    await waitFor(() => expect(posted).toEqual([{ type: "realm-guide:progress", progress: { version: 1, topics: {} } }]));
    from(frame.contentWindow, { type: "realm-guide:attempt", topic: "caches", correct: 3, total: 4 });
    await waitFor(() => expect(api.calls).toContain("recordGuideAttempt:docs1:g.html:caches:3/4"));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect((posted[1] as any).progress.topics.caches).toMatchObject({ best: 0.75, last: 0.75 });
    // A message from some other window is ignored, and so is a malformed attempt.
    from({}, { type: "realm-guide:attempt", topic: "x", correct: 1, total: 1 });
    from(frame.contentWindow, { type: "realm-guide:attempt", topic: "", correct: 1, total: 1 });
    from(frame.contentWindow, { type: "realm-guide:attempt", topic: "t", correct: 1, total: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.calls.filter((c) => c.startsWith("recordGuideAttempt"))).toHaveLength(1);
  });

  it("offers Guide among the new-document kinds, and creating one needs no name up front", async () => {
    const { api } = renderPane({});
    fireEvent.click(await screen.findByRole("button", { name: "Add a document" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New guide" }));
    await waitFor(() => expect(api.calls).toContain("createDocumentFile:docs1:Untitled guide.html"));
  });
});

describe("DocumentsPane — pdf (Plan 22)", () => {
  it("shows a PDF preview-only: no text is read, no Source toggle, an unsandboxed frame", async () => {
    const { api } = renderPane({}, ["slides/l4.pdf"], "slides/l4.pdf");
    const frame = await screen.findByTitle("PDF preview of slides/l4.pdf") as HTMLIFrameElement;
    expect(frame.hasAttribute("sandbox")).toBe(false);
    expect(frame.src).toContain("/docs1/slides/l4.pdf");
    expect(api.calls.some((c) => c.startsWith("readDocument:"))).toBe(false);
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("the picker lets a PDF be opened", async () => {
    renderPane({ "slides/l4.pdf": "" });
    fireEvent.click(await screen.findByRole("button", { name: "Add a document" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open a file…" }));
    const row = await screen.findByRole("button", { name: /l4\.pdf/ });
    expect(row).toBeEnabled();
  });
});

describe("DocumentsPane — open requests (Plan 22)", () => {
  it("opens the requested tab when the event names this workspace, and ignores other workspaces", async () => {
    const { api } = renderPane({ "a.md": "# A", "lectures/l.md": "# L" }, ["a.md"], "a.md");
    await screen.findByRole("tab", { name: /^a\b/ });
    fire("documents.openRequested", { spaceId: "s1", environmentId: ENV, documentsId: "other", itemId: "i9", path: "lectures/l.md" });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole("tab", { name: /^l\b/ })).toBeNull();
    fire("documents.openRequested", { spaceId: "s1", environmentId: ENV, documentsId: DOCS_ID, itemId: "i1", path: "lectures/l.md" });
    const tab = await screen.findByRole("tab", { name: /^l\b/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(api.calls).toContain("readDocument:docs1:lectures/l.md"));
  });
});
