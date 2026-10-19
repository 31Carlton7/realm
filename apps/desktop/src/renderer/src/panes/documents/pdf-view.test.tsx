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
let next: { pages: number; size?: { w: number; h: number }; text?: (i: number) => FakeRuns } | { fail: "password" | "corrupt"; reason: string } = { pages: 12 };
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
          size: async () => spec.size ?? { w: 816, h: 1056 },
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

/** The pane's width, which decides whether the page strip is a column or a sheet. */
let paneWidth = 900;
/** The scroller's height: 600, or a tall pane where a slide is shorter than the reading line is deep. */
let viewHeight = 600;
/** A jump either lands at once, as jsdom has it, or is still scrolling, as a smooth scroll is for a
 *  moment in the app. Every offset a jump aimed at is kept. */
let landing: "at once" | "in flight" = "at once";
const aimedAt: number[] = [];
/** jsdom lays nothing out, so the viewer is given a box: the scroller 600 × `viewHeight`, the head row 900. */
function giveLayout() {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) {
    return this.classList.contains("pdf-view") ? 600 : this.classList.contains("documents-head") ? 900
      : this.classList.contains("pdf-body") ? paneWidth : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) {
    return this.classList.contains("pdf-view") ? viewHeight : 0; } });
  // A page jump scrolls, no further than the column goes: the last pages of a file cannot reach the top.
  HTMLElement.prototype.scrollTo = function (this: HTMLElement, o: ScrollToOptions | number) {
    const top = typeof o === "number" ? o : o.top ?? 0;
    aimedAt.push(top);
    if (landing === "in flight") return;
    const column = Number.parseFloat(this.querySelector<HTMLElement>(".pdf-pages")?.style.height ?? "");
    this.scrollTop = Number.isFinite(column) ? Math.min(top, Math.max(0, column - this.clientHeight)) : top;
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
/** The reader scrolling: a wheel, then the pages moving. */
const scrollTo = (top: number) => { const el = scroller(); fireEvent.wheel(el); el.scrollTop = top; fireEvent.scroll(el); };
const field = () => screen.getByRole("textbox", { name: /^Page, of/ }) as HTMLInputElement;
const goToPage = (n: number) => { fireEvent.focus(field()); fireEvent.change(field(), { target: { value: String(n) } }); fireEvent.keyDown(field(), { key: "Enter" }); };
const press = (name: "Next page" | "Previous page") => fireEvent.click(screen.getByRole("button", { name }));
/** A 16:9 slide at 100%, and the deck at fit width in the 600px box: 568 × 320, a slide every 336. */
const SLIDE = { w: 1280, h: 720 };
const slideTop = (n: number) => PAD_Y + (n - 1) * (Math.round(SLIDE.h * (600 - 32) / SLIDE.w) + PAGE_GAP);

let restore: () => void;
beforeEach(() => {
  listeners.clear(); opened.length = 0; next = { pages: 12 }; paneWidth = 900; viewHeight = 600; landing = "at once"; aimedAt.length = 0;
  restore = giveLayout();
});
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

  /* THE mutant: the page the reader is on read off the pages alone, never the page a jump went to. A
     smooth scroll takes a moment, and until it lands the pages still say the page being left. */
  it("each press of › while a jump is still scrolling goes a page further", async () => {
    renderPdf();
    await waitFor(() => expect(field().value).toBe("1"));
    landing = "in flight";
    press("Next page"); press("Next page"); press("Next page");
    expect(field().value).toBe("4");
    expect(aimedAt.at(-1)).toBe(pageTop(4) - PAD_Y);
  });

  /* THE mutant: the reading line alone. 40% down a 1000px view is past a whole 320px slide, so a deck
     opened at its top said "2", and ‹ went back to the slide it had just put at the top: it never moved. */
  it("on slides in a tall pane, ‹ and › step one slide at a time, both ways", async () => {
    next = { pages: 12, size: SLIDE };
    viewHeight = 1000;
    renderPdf();
    await waitFor(() => expect(field().value).toBe("1"));
    press("Next page");
    await waitFor(() => expect(field().value).toBe("2"));
    expect(scroller().scrollTop).toBe(slideTop(2) - PAD_Y);
    press("Next page");
    await waitFor(() => expect(field().value).toBe("3"));
    press("Previous page");
    await waitFor(() => expect(field().value).toBe("2"));
    expect(scroller().scrollTop).toBe(slideTop(2) - PAD_Y);
    press("Previous page");
    await waitFor(() => expect(field().value).toBe("1"));
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    // Scrolled by the reader to a slide's top, that slide is the one being read.
    scrollTo(slideTop(5));
    await waitFor(() => expect(field().value).toBe("5"));
  });

  /* THE mutant again, at the end of a file: the column cannot scroll the last slides to its top, so
     the pages never said 12, and › stayed lit and did nothing. */
  it("› reaches the last page where the column cannot scroll it to the top", async () => {
    next = { pages: 12, size: SLIDE };
    viewHeight = 1000;
    renderPdf();
    await waitFor(() => expect(field().value).toBe("1"));
    goToPage(10);
    await waitFor(() => expect(field().value).toBe("10"));
    press("Next page");
    await waitFor(() => expect(field().value).toBe("11"));
    press("Next page");
    await waitFor(() => expect(field().value).toBe("12"));
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  /* THE mutant: a jump that outlives the reader moving the pages, so the field goes on naming a page
     they have scrolled away from — or one that a click into a page's text ends. */
  it("the reader moving the pages takes the field back to where the pages are", async () => {
    next = { pages: 12, size: SLIDE };
    viewHeight = 1000;
    renderPdf();
    await waitFor(() => expect(field().value).toBe("1"));
    // At the end of the column the pages say 11; the jump said 12.
    const jumpToLast = async () => { goToPage(12); await waitFor(() => expect(field().value).toBe("12")); };
    await jumpToLast();
    fireEvent.wheel(scroller());
    await waitFor(() => expect(field().value).toBe("11"));
    await jumpToLast();
    fireEvent.keyDown(scroller(), { key: "PageUp" });
    await waitFor(() => expect(field().value).toBe("11"));
    await jumpToLast();
    // A press in a page's text is not a scroll; a press on the scroller itself (its bar) is.
    fireEvent.pointerDown(document.querySelector(".pdf-page")!);
    expect(field().value).toBe("12");
    fireEvent.pointerDown(scroller());
    await waitFor(() => expect(field().value).toBe("11"));
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

describe("the page strip", () => {
  const toggle = () => screen.queryByRole("button", { name: "Show pages" });
  const thumb = (n: number) => screen.getByRole("button", { name: `Page ${n}` });

  /* THE mutant: the toggle on every file — a four-page handout gets a strip it has no use for. */
  it("is offered only past four pages, off at first, and the page being read wears the ring", async () => {
    next = { pages: 4 };
    const short = renderPdf();
    await waitFor(() => expect(field().value).toBe("1"));
    expect(toggle()).toBeNull();
    short.unmount();
    next = { pages: 12 };
    renderPdf();
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-pressed", "false"));
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
    fireEvent.click(toggle()!);
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("navigation", { name: "Pages" }).querySelectorAll(".pdf-thumb")).toHaveLength(12);
    expect(thumb(1)).toHaveAttribute("aria-current", "page");
    fireEvent.click(thumb(6));
    await waitFor(() => expect(field().value).toBe("6"));
    expect(thumb(6)).toHaveAttribute("aria-current", "page");
    expect(thumb(1)).not.toHaveAttribute("aria-current");
  });

  /* THE mutant: the choice kept in the component, so a space switch puts the strip away again. */
  it("is remembered for the pane, and ⌘⌥S toggles it from the keyboard", async () => {
    const first = renderPdf();
    await waitFor(() => expect(toggle()).not.toBeNull());
    fireEvent.click(toggle()!);
    first.unmount();
    renderPdf();
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-pressed", "true"));
    act(() => { scroller().focus(); });
    fireEvent.keyDown(window, { key: "ß", code: "KeyS", metaKey: true, altKey: true });
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
  });

  /* THE mutant: a 132px column in a 400px pane, leaving the pages a strip of their own. */
  it("in a narrow pane is a sheet over the pages, gone after a pick", async () => {
    paneWidth = 480;
    renderPdf();
    await waitFor(() => expect(toggle()).not.toBeNull());
    fireEvent.click(toggle()!);
    expect(screen.getByRole("navigation", { name: "Pages" })).toHaveAttribute("data-floating");
    fireEvent.click(thumb(3));
    await waitFor(() => expect(field().value).toBe("3"));
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
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
