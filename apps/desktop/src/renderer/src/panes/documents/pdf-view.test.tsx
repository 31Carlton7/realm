import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { Item } from "@realm/contracts";

/* The rpc singleton, so the test can fire `documents.fileChanged` (an agent rewriting the file). */
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

/* pdf.js never loads in jsdom: the viewer's one seam onto it is replaced by documents of N Letter
   pages whose text is known. */
type FakeRuns = { str: string; eol: boolean }[];
const opened: string[] = [];
let next: { pages: number; text?: (i: number) => FakeRuns } | { fail: "password" | "corrupt"; reason: string } = { pages: 12 };
vi.mock("./pdf-source", () => {
  class PdfOpenError extends Error { constructor(readonly kind: string, reason: string) { super(reason); } }
  return {
    PdfOpenError,
    openPdf: (url: string) => {
      opened.push(url);
      const spec = next;
      if ("fail" in spec) return { promise: Promise.reject(new PdfOpenError(spec.fail, spec.reason)), cancel: () => {} };
      const text = spec.text ?? ((i: number) => [{ str: `Page ${i + 1}`, eol: true }]);
      return {
        cancel: () => {},
        promise: Promise.resolve({
          pages: spec.pages,
          size: async () => ({ w: 816, h: 1056 }),
          render: async () => {},
          text: async (i: number) => text(i),
          textLayer: async (i: number, box: HTMLElement) => {
            const spans = text(i).map((r) => { const s = document.createElement("span"); s.textContent = r.str; box.append(s); return s; });
            return { spans, rescale: () => {}, cancel: () => {} };
          },
          links: async () => [],
          resolve: async () => null,
          release: () => {},
          destroy: () => {},
        }),
      };
    },
  };
});

import { DocumentsPane } from "./DocumentsPane";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";
import { PAD_Y, PAGE_GAP } from "./pdf-layout";
import { publishShownFile, useDocumentsMenuItems } from "./shown-file";

const DOCS_ID = "docs1";
const ENV = "env-s1";
const paneItem: Item = item("i1", "s1", { kind: "documents", title: "Documents", refId: DOCS_ID });

/** jsdom lays nothing out, so the viewer is given a box: the scroller 600 × 600, the head row 900. */
function giveLayout() {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) {
    return this.classList.contains("pdf-view") ? 600 : this.classList.contains("documents-head") ? 900 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) {
    return this.classList.contains("pdf-view") ? 600 : 0; } });
  // A page jump scrolls; jsdom has no scrolling, so it lands at once and says so.
  HTMLElement.prototype.scrollTo = function (this: HTMLElement, o: ScrollToOptions | number) {
    this.scrollTop = typeof o === "number" ? o : o.top ?? 0;
    this.dispatchEvent(new Event("scroll"));
  } as typeof HTMLElement.prototype.scrollTo;
  // Defined on HTMLElement over jsdom's own on Element, so deleting them puts jsdom's back.
  return () => { delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth; delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight; };
}

function renderPdf(path = "slides/l4.pdf") {
  const api = fakeApi({
    documentWorkspaces: { [DOCS_ID]: { id: DOCS_ID, spaceId: "s1", environmentId: ENV, openPaths: [path], activePath: path, createdAt: 0, updatedAt: 0 } },
    documentFiles: { [DOCS_ID]: {} },
  });
  const store = createAppStore(api);
  return { api, ...render(<StoreContext.Provider value={store}><DocumentsPane item={paneItem} visible /></StoreContext.Provider>) };
}

/** The fit-width scale for a Letter page in the 600px box, and where page `n` (1-based) starts. */
const FIT = (600 - 32) / 816;
const pageTop = (n: number, scale = FIT) => PAD_Y + (n - 1) * (Math.round(1056 * scale) + PAGE_GAP);
const scroller = () => screen.getByRole("region", { name: "PDF l4.pdf" });
const scrollTo = (top: number) => { const el = scroller(); el.scrollTop = top; fireEvent.scroll(el); };
const field = () => screen.getByRole("textbox", { name: /^Page, of/ }) as HTMLInputElement;

let restore: () => void;
beforeEach(() => { listeners.clear(); opened.length = 0; next = { pages: 12 }; restore = giveLayout(); });
afterEach(() => { restore(); });

describe("Realm's own PDF viewer", () => {
  it("draws the file itself — no frame — fetched from the preview server, and says where the reader is", async () => {
    const { api } = renderPdf();
    await screen.findByRole("region", { name: "PDF l4.pdf" });
    await waitFor(() => expect(field().value).toBe("1"));
    expect(document.querySelector("iframe")).toBeNull();
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:4321\/p\/tok\/docs1\/slides\/l4\.pdf\?v=/);
    expect(screen.getByText("of 12")).toBeInTheDocument();
    expect(document.querySelectorAll(".pdf-page")).toHaveLength(12);
    // Never read as text, and no Source toggle.
    expect(api.calls.some((c) => c.startsWith("readDocument:"))).toBe(false);
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
  });

  /* THE mutant: "Saved" back for every kind. Realm never writes a PDF, so the word is a claim nobody made. */
  it("shows no Saved beside a PDF", async () => {
    renderPdf();
    await screen.findByRole("region", { name: "PDF l4.pdf" });
    expect(screen.queryByText("Saved")).toBeNull();
  });

  /* THE mutant: the field committing without the jump — the number changes and the pages do not. */
  it("typing a page and pressing Return goes there; Escape puts the number back", async () => {
    renderPdf();
    await waitFor(() => expect(field().value).toBe("1"));
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "5" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(scroller().scrollTop).toBe(pageTop(5) - PAD_Y);
    await waitFor(() => expect(field().value).toBe("5"));
    fireEvent.change(field(), { target: { value: "9" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().value).toBe("5");
    // ‹ and › step a page.
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(field().value).toBe("6"));
  });

  /* THE mutant: a zoom step of its own instead of the media viewer's rungs, or a readout that only
     ever goes one way. */
  it("zooms on the media viewer's rungs, and the readout toggles fit width and 100%", async () => {
    renderPdf();
    await waitFor(() => expect(field().value).toBe("1"));
    const readout = () => screen.getByRole("group", { name: "Zoom" }).querySelector(".media-viewer-zoom")!;
    expect(readout().textContent).toBe(`${Math.round(FIT * 100)}%`);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(readout().textContent).toBe("75%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(readout().textContent).toBe("100%");
    fireEvent.click(readout());
    expect(readout().textContent).toBe(`${Math.round(FIT * 100)}%`);
    fireEvent.click(readout());
    expect(readout().textContent).toBe("100%");
    // The fit menu, named for the fit in force: Fit page fits the whole Letter page in the 600px box.
    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Fit page" }));
    expect(readout().textContent).toBe(`${Math.round(((600 - 2 * PAD_Y) / 1056) * 100)}%`);
  });

  /* THE mutant: a zoom that keeps the pixel offset instead of the place — the reader on page 7 is on
     page 4 or page 11 after one press. */
  it("a zoom keeps the reader on their page", async () => {
    renderPdf();
    await waitFor(() => expect(field().value).toBe("1"));
    scrollTo(pageTop(7));
    await waitFor(() => expect(field().value).toBe("7"));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(field().value).toBe("7"));
  });

  /* THE mutant: reloading at the top. An agent rewriting a PDF the reader is on page 7 of sent them
     back to page 1 in Chromium's viewer; that is what this replaces. */
  it("an agent's rewrite reloads the file and keeps the page, the last one if the file got shorter", async () => {
    renderPdf();
    await waitFor(() => expect(field().value).toBe("1"));
    scrollTo(pageTop(7) + 100);
    await waitFor(() => expect(field().value).toBe("7"));
    next = { pages: 10 };
    fire("documents.fileChanged", { environmentId: ENV, path: "slides/l4.pdf", hash: "h2" });
    await waitFor(() => expect(screen.getByText("of 10")).toBeInTheDocument());
    expect(opened).toHaveLength(2);
    expect(opened[1]).toContain("?v=h2");
    expect(scroller().scrollTop).toBe(pageTop(7) + 100);
    expect(field().value).toBe("7");
    next = { pages: 4 };
    fire("documents.fileChanged", { environmentId: ENV, path: "slides/l4.pdf", hash: "h3" });
    await waitFor(() => expect(screen.getByText("of 4")).toBeInTheDocument());
    expect(scroller().scrollTop).toBe(pageTop(4));
    await waitFor(() => expect(field().value).toBe("4"));
  });

  it("comes back to the same page after the pane is unmounted (a space switch)", async () => {
    const first = renderPdf();
    await waitFor(() => expect(field().value).toBe("1"));
    scrollTo(pageTop(9));
    await waitFor(() => expect(field().value).toBe("9"));
    first.unmount();
    renderPdf();
    await waitFor(() => expect(field().value).toBe("9"));
  });

  /* THE mutant: a password error drawn as the corrupt one — "couldn't read" for a file that is fine. */
  it("says a password-protected file is, and a corrupt one why", async () => {
    next = { fail: "password", reason: "password-protected" };
    const a = renderPdf();
    expect(await screen.findByText("l4.pdf is password-protected. Realm can't open it.")).toBeInTheDocument();
    a.unmount();
    next = { fail: "corrupt", reason: "Invalid PDF structure" };
    renderPdf();
    expect(await screen.findByText("Realm couldn't read this PDF: Invalid PDF structure.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /^Page/ })).toBeNull();
  });

  /* THE mutant: find without its count, or Return that does not step. Chromium's viewer had both,
     so the replacement may not ship without them. */
  it("⌘F finds in the pane's text with a count; Return steps, Escape closes and unmarks", async () => {
    next = { pages: 6, text: (i) => [{ str: `Page ${i + 1}`, eol: true }, { str: i % 2 === 0 ? "a needle here" : "hay", eol: false }] };
    renderPdf();
    await waitFor(() => expect(field().value).toBe("1"));
    act(() => { scroller().focus(); });
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const find = await screen.findByRole("textbox", { name: "Find in PDF" });
    await waitFor(() => expect(document.activeElement).toBe(find));
    fireEvent.change(find, { target: { value: "Needle" } });
    await waitFor(() => expect(screen.getByText("1 of 3")).toBeInTheDocument(), { timeout: 2000 });
    await waitFor(() => expect(document.querySelector(".pdf-hit[data-current]")?.textContent).toBe("needle"));
    fireEvent.keyDown(find, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("2 of 3")).toBeInTheDocument());
    fireEvent.keyDown(find, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(screen.getByText("1 of 3")).toBeInTheDocument());
    fireEvent.keyDown(find, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Find in PDF" })).toBeNull();
    await waitFor(() => expect(document.querySelector(".pdf-hit")).toBeNull());
    expect(document.querySelector(".pdf-page .textLayer")?.textContent).toContain("a needle here");
  });

  it("⌘F does nothing while the keyboard is somewhere else", async () => {
    renderPdf();
    await waitFor(() => expect(field().value).toBe("1"));
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(screen.queryByRole("textbox", { name: "Find in PDF" })).toBeNull();
  });
});

describe("the pane's menu for a PDF", () => {
  afterEach(() => { publishShownFile("i1", null); delete (window as { realm?: unknown }).realm; });

  /* THE mutant: the rows offered without the bridge, where they could only fail. */
  it("offers Open in Preview and Share only where the bridge has them, for a PDF only", () => {
    const { result, rerender } = renderHook(() => useDocumentsMenuItems(paneItem));
    expect(result.current).toEqual([]);
    act(() => publishShownFile("i1", { path: "/w/slides/l4.pdf", kind: "pdf" }));
    rerender();
    expect(result.current).toEqual([]);
    const openInPreview = vi.fn(async () => {});
    (window as { realm?: unknown }).realm = { files: { openInPreview, share: vi.fn(async () => {}) } };
    rerender();
    expect(result.current.map((r) => ("label" in r ? r.label : null))).toEqual(["Open in Preview", "Share…"]);
    act(() => { (result.current[0] as { onSelect: () => void }).onSelect(); });
    expect(openInPreview).toHaveBeenCalledWith("/w/slides/l4.pdf");
    act(() => publishShownFile("i1", { path: "/w/notes.md", kind: "doc" }));
    rerender();
    expect(result.current).toEqual([]);
  });
});
