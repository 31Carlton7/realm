import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
function stageSource({ height = 4000, view = 600 } = {}) {
  const tops = new WeakMap<HTMLElement, number>();
  const mine = (el: unknown) => el instanceof HTMLElement && el.classList.contains("documents-source");
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
describe("a document's scroll position across a space switch", () => {
  it("puts the reader back where they were in the file", async () => {
    const staged = stageSource();
    const store = makeStore({ "a.md": "# A" }, ["a.md"], "a.md");
    const { unmount } = render(pane(store));
    staged.readerScrollsTo(await sourceFor("a.md"), 1200);

    unmount();
    render(pane(store));

    const reborn = await sourceFor("a.md");
    expect(staged.topOf(reborn)).toBe(1200);
  });

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

  it("a file nobody has scrolled opens at the top", async () => {
    const staged = stageSource();
    const store = makeStore({ "a.md": "# A" }, ["a.md"], "a.md");
    const { unmount } = render(pane(store));
    await sourceFor("a.md");

    unmount();
    render(pane(store));

    expect(staged.topOf(await sourceFor("a.md"))).toBe(0);
  });
});
