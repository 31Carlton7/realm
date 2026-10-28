import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Item } from "@realm/contracts";

/** Inert: nothing here fires a file change. */
vi.mock("../../rpc/client", () => ({ rpc: () => ({ on: () => () => {} }) }));

import { DocumentsPane } from "./DocumentsPane";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";

const DOCS_ID = "docs1";
const paneItem: Item = item("i1", "s1", { kind: "documents", title: "Documents", refId: DOCS_ID });

function makeStore(files: Record<string, string>, openPaths: string[], activePath: string | null) {
  const api = fakeApi({
    documentWorkspaces: { [DOCS_ID]: { id: DOCS_ID, spaceId: "s1", environmentId: "env-s1", openPaths, activePath, createdAt: 0, updatedAt: 0 } },
    documentFiles: { [DOCS_ID]: { ...files } },
  });
  return { api, store: createAppStore(api) };
}
const pane = (store: ReturnType<typeof createAppStore>) => (
  <StoreContext.Provider value={store}><DocumentsPane item={paneItem} visible /></StoreContext.Provider>
);

afterEach(() => { vi.useRealTimers(); });

/** The slot a guide's frame sits in, and whether it is the one on screen. */
const slotOf = (path: string) => screen.getByTitle(`Guide preview of ${path}`).closest(".documents-guide") as HTMLElement;
const framesOnPage = () => [...document.querySelectorAll("iframe")].map((f) => f.getAttribute("title")!.replace("Guide preview of ", ""));

describe("guides stay alive behind the other tabs", () => {
  it("a switch to another file and back shows the SAME frame — nothing is reloaded", async () => {
    /* A `.tex` opens in the plain source view, so the other tab draws without a lazy editor.
       THE MUTANT: render the guide's frame in the editor again (keyed by path, as before). Each switch
       makes a new frame, the page reloads, and whatever its own script held is gone. */
    const { store } = makeStore({ "g.html": "<p>g</p>", "a.tex": "x" }, ["g.html", "a.tex"], "g.html");
    render(pane(store));
    const frame = await screen.findByTitle("Guide preview of g.html");
    expect(slotOf("g.html")).toHaveAttribute("data-shown");

    fireEvent.click(screen.getByTitle("a.tex"));
    await screen.findByLabelText("Edit a.tex");
    expect(screen.getByTitle("Guide preview of g.html")).toBe(frame);
    // Out of sight is out of the keyboard's way and out of the reading order.
    expect(slotOf("g.html")).not.toHaveAttribute("data-shown");
    expect(slotOf("g.html")).toHaveAttribute("inert");
    expect(slotOf("g.html")).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(screen.getByTitle("g.html"));
    await waitFor(() => expect(slotOf("g.html")).toHaveAttribute("data-shown"));
    expect(screen.getByTitle("Guide preview of g.html")).toBe(frame);
  });

  it("keeps it through the home and through Source and back", async () => {
    const { store } = makeStore({ "g.html": "<p>g</p>" }, ["g.html"], "g.html");
    render(pane(store));
    const frame = await screen.findByTitle("Guide preview of g.html");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(await screen.findByLabelText("Edit g.html")).toHaveValue("<p>g</p>");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    await waitFor(() => expect(document.querySelector(".documents-guides")).not.toHaveAttribute("data-shown"));
    fireEvent.click(screen.getByTitle("g.html"));
    await waitFor(() => expect(slotOf("g.html")).toHaveAttribute("data-shown"));
    expect(screen.getByTitle("Guide preview of g.html")).toBe(frame);
  });

  it("keeps the three most recently shown, in the order they were first shown, and lets the oldest go", async () => {
    const files = { "g1.html": "1", "g2.html": "2", "g3.html": "3", "g4.html": "4" };
    const { store } = makeStore(files, Object.keys(files), "g1.html");
    render(pane(store));
    await screen.findByTitle("Guide preview of g1.html");
    for (const p of ["g2.html", "g3.html"]) { fireEvent.click(screen.getByTitle(p)); await screen.findByTitle(`Guide preview of ${p}`); }
    // Back to g1, so g2 is now the one seen longest ago.
    fireEvent.click(screen.getByTitle("g1.html"));
    const g1 = screen.getByTitle("Guide preview of g1.html");
    fireEvent.click(screen.getByTitle("g4.html"));
    await screen.findByTitle("Guide preview of g4.html");
    // Never reordered — moving a frame in the document reloads it — so g1 is still the very node it was.
    expect(framesOnPage()).toEqual(["g1.html", "g3.html", "g4.html"]);
    expect(screen.getByTitle("Guide preview of g1.html")).toBe(g1);
  });

  it("lets a guide's frame go with its tab", async () => {
    const { store } = makeStore({ "g.html": "<p>g</p>", "a.tex": "x" }, ["g.html", "a.tex"], "g.html");
    render(pane(store));
    await screen.findByTitle("Guide preview of g.html");
    fireEvent.click(screen.getByLabelText("Close g.html"));
    await waitFor(() => expect(framesOnPage()).toEqual([]));
  });
});

describe("the pane's own view, across the unmount a session or space switch causes", () => {
  it("comes back in Source when it was left in Source", async () => {
    /* THE MUTANT: seed `mode` with "rich" again. The pane comes back in Rich, and a reader who was in
       the Markdown is somewhere else. */
    const { store } = makeStore({ "a.md": "# A" }, ["a.md"], "a.md");
    const first = render(pane(store));
    fireEvent.click(await screen.findByRole("button", { name: "Source" }));
    await screen.findByLabelText("Edit a.md");
    first.unmount();
    render(pane(store));
    expect(await screen.findByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByLabelText("Edit a.md")).toHaveValue("# A");
  });

  it("comes back to the Files home when that is where it was left", async () => {
    const { store } = makeStore({ "a.tex": "x" }, ["a.tex"], "a.tex");
    const first = render(pane(store));
    await screen.findByLabelText("Edit a.tex");
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    await waitFor(() => expect(screen.queryByLabelText("Edit a.tex")).toBeNull());
    first.unmount();
    render(pane(store));
    await screen.findByRole("tab", { name: /^a\b/ });
    expect(document.querySelector(".documents-home-tab")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByLabelText("Edit a.tex")).toBeNull();
  });
});

describe("typing not yet written is written as the file is left", () => {
  it("when the reader goes to another file before the autosave's pause", async () => {
    /* THE MUTANT: drop the effect that saves the file left behind. The autosave's timer goes with the
       tab switch, and the text waits in a buffer for the file's next turn on screen. */
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "a.tex": "x", "b.tex": "y" }, ["a.tex", "b.tex"], "a.tex");
    render(pane(store));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    fireEvent.change(screen.getByLabelText("Edit a.tex"), { target: { value: "x and more" } });
    fireEvent.click(screen.getByTitle("b.tex"));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.calls).toContain("writeDocument:docs1:a.tex");
    expect(api.data.documentFiles.docs1?.["a.tex"]).toBe("x and more");
  });

  it("when the pane itself goes — a session or space switch unmounts it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "a.tex": "x" }, ["a.tex"], "a.tex");
    const first = render(pane(store));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    fireEvent.change(screen.getByLabelText("Edit a.tex"), { target: { value: "x, typed just now" } });
    first.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.data.documentFiles.docs1?.["a.tex"]).toBe("x, typed just now");
  });
});
