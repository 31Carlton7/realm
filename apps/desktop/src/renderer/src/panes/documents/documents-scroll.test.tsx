import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Item } from "@realm/contracts";

/** The pane subscribes to `documents.fileChanged` through the rpc singleton, which needs a real
 *  server port. Inert here — nothing in this file fires one. */
vi.mock("../../rpc/client", () => ({ rpc: () => ({ on: () => () => {} }) }));

import { DocumentsPane } from "./DocumentsPane";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";

const DOCS_ID = "docs1";
const paneItem: Item = item("i1", "s1", { kind: "documents", title: "Documents", refId: DOCS_ID });

/**
 * jsdom lays nothing out, so `scrollTop` is a permanent 0 on every element and "the reader had
 * scrolled" is a state no test could be in. Stage a scroll offset on `.documents-source` that
 * actually stores what is written to it — and a height, so a restore is not silently clamped.
 */
function stageSource({ height = 4000, view = 600, cls = "documents-source" } = {}) {
  const tops = new WeakMap<HTMLElement, number>();
  const mine = (el: unknown) => el instanceof HTMLElement && el.classList.contains(cls);
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return mine(this) ? height : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return mine(this) ? view : 0; } });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return mine(this) ? tops.get(this as HTMLElement) ?? 0 : 0; },
    set(v: number) { if (mine(this)) tops.set(this as HTMLElement, v); },
  });
  // Per ELEMENT, not one shared number: a remount builds a new textarea, and the whole question is
  // whether the new one is placed where the old one was left.
  return {
    topOf(el: HTMLElement) { return tops.get(el) ?? 0; },
    readerScrollsTo(el: HTMLElement, v: number) { tops.set(el, v); fireEvent.scroll(el); },
  };
}

afterEach(() => {
  for (const k of ["scrollHeight", "clientHeight", "scrollTop"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});

function makeStore(files: Record<string, string>, openPaths: string[], activePath: string) {
  const api = fakeApi({
    documentWorkspaces: { [DOCS_ID]: { id: DOCS_ID, spaceId: "s1", environmentId: "env-s1", openPaths, activePath, createdAt: 0, updatedAt: 0 } },
    documentFiles: { [DOCS_ID]: { ...files } },
  });
  return createAppStore(api);
}

const pane = (store: ReturnType<typeof createAppStore>) => (
  <StoreContext.Provider value={store}>
    <DocumentsPane item={paneItem} visible />
  </StoreContext.Provider>
);

/** The pane opens in rich mode; the source view is the surface a test can drive directly. */
async function sourceFor(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Source" }));
  return await screen.findByLabelText(`Edit ${name}`);
}

/**
 * A space switch unmounts every pane in the space being left (`selectSpace` clears `items`), so
 * coming back is a fresh mount over a workspace the server still has. Unmount/remount against one
 * store is that round trip exactly.
 */
describe("a Quick Look render's scroll position", () => {
  it("puts the reader back where they were in a rendered page", async () => {
    /* A .docx has no source view to fall back to — the render IS the document — so losing the
       offset here loses the only position there was. THE MUTANT: drop the ref from `.ql-view`. The
       hook still runs, the mark is still kept, and the reader still comes back to the top.

       The div is an ordinary scroller, unlike the framed previews: this is the reason a Quick Look
       render can use the hook at all and a PDF cannot. */
    const staged = stageSource({ cls: "ql-view" });
    const store = makeStore({ "report.docx": "" }, ["report.docx"], "report.docx");
    const { unmount } = render(pane(store));
    const view = await screen.findByAltText("Preview of report.docx");
    staged.readerScrollsTo(view.closest(".ql-view") as HTMLElement, 900);

    unmount();
    render(pane(store));

    const reborn = await screen.findByAltText("Preview of report.docx");
    await waitFor(() => expect(staged.topOf(reborn.closest(".ql-view") as HTMLElement)).toBe(900));
  });
});

describe("a document's scroll position across a space switch", () => {

  it("remembers each file separately — the other tab keeps its own place", async () => {
    const staged = stageSource();
    const store = makeStore({ "a.md": "# A", "b.md": "# B" }, ["a.md", "b.md"], "a.md");
    const { unmount } = render(pane(store));
    staged.readerScrollsTo(await sourceFor("a.md"), 1200);
    fireEvent.click(screen.getByTitle("b.md"));
    staged.readerScrollsTo(await screen.findByLabelText("Edit b.md"), 300);

    unmount();
    render(pane(store));

    // b.md is the active tab now — the pane persisted the switch — so that is what comes back first.
    expect(staged.topOf(await sourceFor("b.md"))).toBe(300);
    fireEvent.click(screen.getByTitle("a.md"));
    expect(staged.topOf(await screen.findByLabelText("Edit a.md"))).toBe(1200);
  });

});

describe("the rest of a document's place, across the same round trip", () => {
  it("puts a sheet back where it was scrolled", async () => {
    /* The grid scrolls in the library's own element, not one the pane renders. THE MUTANT: drop the
       effect that attaches the scroll memory to `.dsg-container`. The sheet comes back at row one. */
    const staged = stageSource({ cls: "dsg-container" });
    const store = makeStore({ "q3.csv": "A,B\n1,2\n" }, ["q3.csv"], "q3.csv");
    const { unmount } = render(pane(store));
    await waitFor(() => expect(document.querySelector(".dsg-container")).not.toBeNull(), { timeout: 4000 });
    staged.readerScrollsTo(document.querySelector(".dsg-container") as HTMLElement, 640);

    unmount();
    render(pane(store));
    await waitFor(() => expect(document.querySelector(".dsg-container")).not.toBeNull(), { timeout: 4000 });
    // The same allowance as the waits before it: under a full parallel run the grid's scroll lands
    // well past testing-library's one-second default.
    await waitFor(() => expect(staged.topOf(document.querySelector(".dsg-container") as HTMLElement)).toBe(640), { timeout: 4000 });
  }, 10_000);

  it("puts the caret back in a rich document", async () => {
    /* THE MUTANT: drop the `setTextSelection` after the first document lands. The column comes back
       scrolled, with the caret at the top. */
    const store = makeStore({ "a.md": "# Title\n\nA paragraph of notes.\n" }, ["a.md"], "a.md");
    type Ed = { state: { selection: { from: number; to: number }; doc: { textContent: string } }; commands: { setTextSelection: (r: { from: number; to: number }) => boolean } };
    const editorOf = async () => {
      const el = await waitFor(() => {
        const pm = document.querySelector(".ProseMirror") as (HTMLElement & { editor?: Ed }) | null;
        if (!pm?.editor || !pm.editor.state.doc.textContent.includes("paragraph")) throw new Error("not yet");
        return pm;
      }, { timeout: 4000 });
      return el.editor!;
    };
    const { unmount } = render(pane(store));
    const ed = await editorOf();
    act(() => { ed.commands.setTextSelection({ from: 12, to: 21 }); });
    unmount();
    render(pane(store));
    const again = await editorOf();
    expect([again.state.selection.from, again.state.selection.to]).toEqual([12, 21]);
  }, 10_000);

  it("puts the caret back in a source view, and the scroll as well", async () => {
    /* THE MUTANT: skip the selection in `useScrollMemory`'s textarea branch. The offset comes back and
       the caret sits at the top of the file, where the next keystroke lands. */
    const staged = stageSource();
    const store = makeStore({ "a.tex": "\\section{One}\nsome text\n" }, ["a.tex"], "a.tex");
    const { unmount } = render(pane(store));
    const ta = await screen.findByLabelText("Edit a.tex") as HTMLTextAreaElement;
    ta.setSelectionRange(15, 19);
    fireEvent.keyUp(ta, { key: "ArrowRight" });
    staged.readerScrollsTo(ta, 220);

    unmount();
    render(pane(store));
    const again = await screen.findByLabelText("Edit a.tex") as HTMLTextAreaElement;
    expect([again.selectionStart, again.selectionEnd]).toEqual([15, 19]);
    expect(staged.topOf(again)).toBe(220);
    // Not focused: the keyboard stays where the switch back left it.
    expect(document.activeElement).not.toBe(again);
  });
});

