import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Item } from "@realm/contracts";

/** The pane subscribes to `documents.fileChanged` through the rpc singleton, which needs a real
 *  server port. Mocked here so the test can also FIRE that event — live reload and conflict handling
 *  are the behaviours most worth covering, and they are unreachable without it. */
const listeners = new Set<(p: { environmentId: string; path: string; hash: string | null }) => void>();
vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: (event: string, cb: (p: any) => void) => {
      if (event !== "documents.fileChanged") return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  }),
}));
const fireChange = (p: { environmentId: string; path: string; hash: string | null }) => {
  act(() => { for (const cb of [...listeners]) cb(p); });
};

import { DocumentsPane } from "./DocumentsPane";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";

const DOCS_ID = "docs1";
const ENV = "env-s1";
const paneItem: Item = item("i1", "s1", { kind: "documents", title: "Documents", refId: DOCS_ID });

function renderPane(files: Record<string, string>, openPaths: string[] = [], activePath: string | null = null) {
  const api = fakeApi({
    documentWorkspaces: { [DOCS_ID]: { id: DOCS_ID, spaceId: "s1", environmentId: ENV, openPaths, activePath, createdAt: 0, updatedAt: 0 } },
    documentFiles: { [DOCS_ID]: { ...files } },
  });
  const store = createAppStore(api);
  const ui = render(
    <StoreContext.Provider value={store}>
      <DocumentsPane item={paneItem} visible />
    </StoreContext.Provider>,
  );
  return { api, store, ui };
}

/** Switch the pane to Source. The buffer, tab and conflict behaviours under test are mode-independent;
 *  the textarea is simply the surface that can be driven directly. Rich mode has its own tests below. */
async function useSource() {
  fireEvent.click(await screen.findByRole("button", { name: "Source" }));
}

beforeEach(() => { listeners.clear(); vi.useRealTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("DocumentsPane", () => {
  it("reopens the tabs the workspace persisted, on the active one", async () => {
    renderPane({ "a.md": "# A", "b.md": "# B" }, ["a.md", "b.md"], "b.md");
    await screen.findByRole("tab", { name: /^b\b/ });
    await useSource();
    expect(screen.getByRole("tab", { name: /^a\b/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: /^b\b/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("Edit b.md")).toHaveValue("# B");
  });

  it("switches tabs and shows the other document's text", async () => {
    renderPane({ "a.md": "# A", "b.md": "# B" }, ["a.md", "b.md"], "a.md");
    await useSource();
    await screen.findByLabelText("Edit a.md");
    fireEvent.click(screen.getByTitle("b.md"));
    expect(await screen.findByLabelText("Edit b.md")).toHaveValue("# B");
  });

  it("closing a tab drops it and falls back to another", async () => {
    renderPane({ "a.md": "# A", "b.md": "# B" }, ["a.md", "b.md"], "a.md");
    await useSource();
    await screen.findByLabelText("Edit a.md");
    fireEvent.click(screen.getByLabelText("Close a.md"));
    await waitFor(() => expect(screen.queryByRole("tab", { name: /a\.md/ })).toBeNull());
    expect(await screen.findByLabelText("Edit b.md")).toBeTruthy();
  });

  it("marks a tab unsaved while typing, then saves and clears it", async () => {
    const { api } = renderPane({ "a.md": "# A" }, ["a.md"], "a.md");
    await useSource();
    const box = await screen.findByLabelText("Edit a.md");
    fireEvent.change(box, { target: { value: "# A edited" } });
    expect(await screen.findByLabelText("Unsaved")).toBeTruthy();
    // Autosave is debounced; wait it out rather than reaching into the timer.
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("writeDocument:"))).toBe(true), { timeout: 3000 });
    await waitFor(() => expect(screen.queryByLabelText("Unsaved")).toBeNull());
    expect(api.data.documentFiles[DOCS_ID]?.["a.md"]).toBe("# A edited");
  });

  it("adopts an outside edit silently while the buffer is clean", async () => {
    const { api } = renderPane({ "a.md": "# A" }, ["a.md"], "a.md");
    await useSource();
    await screen.findByLabelText("Edit a.md");
    api.data.documentFiles[DOCS_ID]!["a.md"] = "# rewritten by an agent";
    fireChange({ environmentId: ENV, path: "a.md", hash: "h-new" });
    await waitFor(() => expect(screen.getByLabelText("Edit a.md")).toHaveValue("# rewritten by an agent"));
    expect(screen.queryByRole("alert")).toBeNull(); // no prompt for a document you were only reading
  });

  /** The behaviour the whole conflict policy exists for: unsaved text is never silently replaced. */
  it("raises a conflict instead of clobbering unsaved text", async () => {
    const { api } = renderPane({ "a.md": "# A" }, ["a.md"], "a.md");
    await useSource();
    const box = await screen.findByLabelText("Edit a.md");
    fireEvent.change(box, { target: { value: "the user's paragraph" } });

    api.data.documentFiles[DOCS_ID]!["a.md"] = "the agent's rewrite";
    fireChange({ environmentId: ENV, path: "a.md", hash: "h-agent" });

    expect(await screen.findByRole("alert")).toHaveTextContent(/changed on disk/i);
    expect(screen.getByLabelText("Edit a.md")).toHaveValue("the user's paragraph");
    expect(screen.getByLabelText("Needs attention")).toBeTruthy();
  });

  it("take-theirs adopts the version on disk", async () => {
    const { api } = renderPane({ "a.md": "# A" }, ["a.md"], "a.md");
    await useSource();
    fireEvent.change(await screen.findByLabelText("Edit a.md"), { target: { value: "mine" } });
    api.data.documentFiles[DOCS_ID]!["a.md"] = "theirs";
    fireChange({ environmentId: ENV, path: "a.md", hash: "h-theirs" });
    fireEvent.click(await screen.findByText("Take theirs"));
    await waitFor(() => expect(screen.getByLabelText("Edit a.md")).toHaveValue("theirs"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keep-mine resolves the conflict and writes the user's text", async () => {
    const { api } = renderPane({ "a.md": "# A" }, ["a.md"], "a.md");
    await useSource();
    fireEvent.change(await screen.findByLabelText("Edit a.md"), { target: { value: "mine" } });
    api.data.documentFiles[DOCS_ID]!["a.md"] = "theirs";
    fireChange({ environmentId: ENV, path: "a.md", hash: "h-theirs" });
    fireEvent.click(await screen.findByText("Keep mine"));
    await waitFor(() => expect(api.data.documentFiles[DOCS_ID]?.["a.md"]).toBe("mine"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a deletion without losing the text", async () => {
    renderPane({ "a.md": "# A" }, ["a.md"], "a.md");
    await useSource();
    await screen.findByLabelText("Edit a.md");
    fireChange({ environmentId: ENV, path: "a.md", hash: null });
    expect(await screen.findByRole("alert")).toHaveTextContent(/deleted on disk/i);
    expect(screen.getByLabelText("Edit a.md")).toHaveValue("# A");
  });

  it("ignores changes from another environment", async () => {
    const { api } = renderPane({ "a.md": "# A" }, ["a.md"], "a.md");
    await useSource();
    await screen.findByLabelText("Edit a.md");
    api.data.documentFiles[DOCS_ID]!["a.md"] = "should not appear";
    fireChange({ environmentId: "some-other-env", path: "a.md", hash: "h-other" });
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByLabelText("Edit a.md")).toHaveValue("# A");
  });

  it("opens a markdown document in rich mode by default", async () => {
    renderPane({ "a.md": "# Heading\n\nSome prose.\n" }, ["a.md"], "a.md");
    const surface = await screen.findByLabelText("Rich text editor", {}, { timeout: 4000 });
    expect(surface.querySelector("h1")?.textContent).toBe("Heading");
    // The source textarea is not mounted in rich mode — the two views are exclusive.
    expect(screen.queryByLabelText("Edit a.md")).toBeNull();
  });

  it("opens a spreadsheet in the grid, with Source one click away", async () => {
    renderPane({ "q3.csv": "A,B\n1,2\n" }, ["q3.csv"], "q3.csv");
    // The sheet stack is lazy; the formula bar arriving means the chunk loaded and the grid mounted.
    await screen.findByTitle("Add column", {}, { timeout: 4000 });
    expect(screen.getByRole("button", { name: "Grid" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(await screen.findByLabelText("Edit q3.csv")).toHaveValue("A,B\n1,2\n");
  });

  it("shows an empty state whose only control is the one that makes a document", async () => {
    renderPane({});
    expect(await screen.findByText(/Nothing open yet/i)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /New document/ }).length).toBeGreaterThan(0);
  });
});

/**
 * Creating a document, and naming it afterwards.
 *
 * The old flow refused to create anything until a name was typed into the picker: five disabled
 * buttons behind a text field, for a file that did not exist yet. These cover the shape that replaced
 * it — pick a kind, get a working document, rename it whenever (or never).
 */
/** §6's popover exit keeps a dismissed menu or picker mounted for `--dur-press` and tells its parent
 *  at the end of it, so anything that closes one and then opens (or asserts the absence of) another
 *  has to let the first one leave. */
const exited = () => act(async () => { await new Promise((r) => setTimeout(r, 200)); });

describe("DocumentsPane — making a document", () => {
  const addMenu = async () => {
    await exited();
    fireEvent.click(await screen.findByRole("button", { name: "Add a document" }));
  };

  it("creates and opens a document from one menu pick — no name asked for", async () => {
    const { api } = renderPane({});
    await addMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "New document" }));
    await waitFor(() => expect(api.calls).toContain("createDocumentFile:docs1:Untitled document.md"));
    // It is OPEN, not merely created: the point of the change is that you land in the document.
    expect(await screen.findByRole("tab", { name: /Untitled document/ })).toHaveAttribute("aria-selected", "true");
  });

  it("gives each kind its own extension, so the editor that opens is the one the menu named", async () => {
    const { api } = renderPane({});
    for (const [label, path] of [
      ["New spreadsheet", "Untitled spreadsheet.csv"],
      ["New presentation", "Untitled presentation.slides.md"],
      ["New LaTeX", "Untitled LaTeX.tex"],
    ] as const) {
      await addMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
      await waitFor(() => expect(api.calls).toContain(`createDocumentFile:docs1:${path}`));
    }
  });

  it("numbers the second untitled document instead of failing on the name that is taken", async () => {
    const { api } = renderPane({ "Untitled document.md": "# one" });
    await addMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "New document" }));
    await waitFor(() => expect(api.calls).toContain("createDocumentFile:docs1:Untitled document 2.md"));
  });

  it("lands with the name selected, so the next keystroke replaces it", async () => {
    renderPane({});
    await addMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "New document" }));
    const field = await screen.findByLabelText("Document name") as HTMLInputElement;
    expect(field.value).toBe("Untitled document");
    expect(field).toHaveFocus();
  });

  it("renames the file on disk, keeping the extension the user never typed", async () => {
    const { api } = renderPane({ "a.md": "# A" }, ["a.md"], "a.md");
    fireEvent.click(await screen.findByTitle(/click to rename/));
    const field = screen.getByLabelText("Document name");
    fireEvent.change(field, { target: { value: "Q3 review" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.calls).toContain("renameDocumentFile:docs1:a.md:Q3 review.md"));
    expect(await screen.findByRole("tab", { name: /Q3 review/ })).toBeTruthy();
  });

  it("keeps a deck a deck: the compound extension is not the user's to lose", async () => {
    const { api } = renderPane({ "d.slides.md": "---\nmarp: true\n---\n" }, ["d.slides.md"], "d.slides.md");
    fireEvent.click(await screen.findByTitle(/click to rename/));
    const field = screen.getByLabelText("Document name");
    fireEvent.change(field, { target: { value: "Kickoff" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.calls).toContain("renameDocumentFile:docs1:d.slides.md:Kickoff.slides.md"));
  });

  it("Escape abandons the rename, and an emptied name is not a rename at all", async () => {
    const { api } = renderPane({ "a.md": "# A" }, ["a.md"], "a.md");
    fireEvent.click(await screen.findByTitle(/click to rename/));
    const field = screen.getByLabelText("Document name");
    fireEvent.change(field, { target: { value: "gone" } });
    fireEvent.keyDown(field, { key: "Escape" });
    await screen.findByTitle("a.md — click to rename");

    fireEvent.click(screen.getByTitle(/click to rename/));
    const again = screen.getByLabelText("Document name");
    fireEvent.change(again, { target: { value: "   " } });
    fireEvent.keyDown(again, { key: "Enter" });
    await waitFor(() => expect(screen.getByTitle("a.md — click to rename")).toBeTruthy());
    expect(api.calls.some((c) => c.startsWith("renameDocumentFile:"))).toBe(false);
  });

  it("a second document switches the open name field to it", async () => {
    // The real guard for this is in documents-pane-live.mjs, not here: the failure mode is a field
    // that does NOT remount when the active document changes, and jsdom remounts it anyway, so this
    // passes with or without the `key` that fixes it. Kept as a statement of the intended behaviour.
    const { api } = renderPane({});
    await addMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "New document" }));
    await waitFor(() => expect((screen.getByLabelText("Document name") as HTMLInputElement).value).toBe("Untitled document"));

    await addMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "New spreadsheet" }));
    await waitFor(() => expect((screen.getByLabelText("Document name") as HTMLInputElement).value).toBe("Untitled spreadsheet"));

    fireEvent.blur(screen.getByLabelText("Document name"));
    await waitFor(() => expect(api.data.documentFiles.docs1?.["Untitled spreadsheet.csv"]).toBeDefined());
    expect(api.calls.some((c) => c.startsWith("renameDocumentFile:"))).toBe(false);
  });

  it("the open editor survives the rename — its text is not reloaded from disk", async () => {
    renderPane({ "a.md": "# A" }, ["a.md"], "a.md");
    await useSource();
    fireEvent.change(await screen.findByLabelText("Edit a.md"), { target: { value: "unsaved words" } });
    fireEvent.click(screen.getByTitle(/click to rename/));
    const field = screen.getByLabelText("Document name");
    fireEvent.change(field, { target: { value: "renamed" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await screen.findByLabelText("Edit renamed.md")).toHaveValue("unsaved words");
  });
});
