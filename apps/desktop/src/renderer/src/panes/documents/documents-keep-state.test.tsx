import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Item } from "@realm/contracts";

/** The pane hears files change through the rpc singleton; mocked so a test can say what disk did. */
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
/* pdf.js never loads in jsdom (too slow to import, and it draws nothing here). */
vi.mock("./pdf-source", () => ({
  PdfOpenError: class extends Error {},
  openPdf: () => ({ promise: new Promise(() => {}), cancel: () => {} }),
}));

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

beforeEach(() => { listeners.clear(); });
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

type Api = ReturnType<typeof makeStore>["api"];
/** What an agent's shell did to a file, as the watcher reports it: gone, or there with new bytes — or,
 *  with `quietly`, done while no pane was there to hear it. */
function disk(api: Api) {
  const files = api.data.documentFiles.docs1!;
  const fire = (path: string, hash: string | null) => {
    act(() => { for (const cb of [...listeners]) cb({ environmentId: "env-s1", path, hash }); });
  };
  return {
    remove(path: string) { delete files[path]; fire(path, null); },
    put(path: string, text: string) { files[path] = text; fire(path, `h:${text.length}:${text}`); },
    quietly: { remove(path: string) { delete files[path]; }, put(path: string, text: string) { files[path] = text; } },
  };
}
const settle = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const writesTo = (api: Api, path: string) => api.calls.filter((c) => c === `writeDocument:docs1:${path}`);

describe("a file that changed on disk while it sat in a tab is left as disk has it", () => {
  it("a PDF an agent deletes and rebuilds behind its tab keeps the rebuild through a session or space switch", async () => {
    /* The reported loss, end to end: `rm -f handout.pdf` then a rebuild while the PDF sat in a background
       tab, then a switch. The flush wrote the PDF's empty buffer over the rebuild, on a hash that matched:
       0 bytes. Three rules each stop it here (a deletion is not typing, a binary's change leaves it
       clean, a binary is never written), so no one of them alone fails this test; each has its own
       mutant, killed in the tests below and in buffers.test.ts. The code before the fix fails it. */
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "notes.tex": "x", "handout.pdf": "%PDF-1.4 the old handout" }, ["notes.tex", "handout.pdf"], "notes.tex");
    const first = render(pane(store));
    await settle(50);
    const d = disk(api);
    d.remove("handout.pdf");
    d.put("handout.pdf", "%PDF-1.4 the rebuilt handout");
    await settle(800);
    first.unmount();
    await settle(50);
    expect(writesTo(api, "handout.pdf")).toEqual([]);
    expect(api.data.documentFiles.docs1?.["handout.pdf"]).toBe("%PDF-1.4 the rebuilt handout");
  });

  it("a PDF on screen deleted and rebuilt is shown as rebuilt — not as deleted — and never written", async () => {
    /* THE MUTANT: a binary's change adopts the hash and nothing else (the code before this fix). The
       rebuilt PDF goes on being reported as deleted on disk. Before the fix it was worse on screen too:
       the deletion made it dirty, and the autosave wrote it empty 700ms later. */
    await import("./PdfView"); // the viewer is lazy; loaded first, its import resolves without real time
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "handout.pdf": "%PDF-1.4 old" }, ["handout.pdf"], "handout.pdf");
    const first = render(pane(store));
    await settle(50);
    expect(screen.getByRole("region", { name: "PDF handout.pdf" })).toBeTruthy();
    const d = disk(api);
    d.remove("handout.pdf");
    await settle(10);
    expect(screen.getByRole("alert")).toHaveTextContent("This file was deleted on disk.");
    await settle(800);
    expect(writesTo(api, "handout.pdf")).toEqual([]); // no empty PDF made where one was deleted
    expect(api.data.documentFiles.docs1?.["handout.pdf"]).toBeUndefined();
    d.put("handout.pdf", "%PDF-1.4 rebuilt");
    await settle(50);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector(".documents-state")).not.toHaveAttribute("data-state", "missing");
    await settle(800);
    first.unmount();
    await settle(50);
    expect(writesTo(api, "handout.pdf")).toEqual([]);
    expect(api.data.documentFiles.docs1?.["handout.pdf"]).toBe("%PDF-1.4 rebuilt");
  });

  it("a text file nobody typed in stays deleted — behind its tab through a switch, or on screen past the autosave", async () => {
    /* An agent's `git checkout`, `git stash` or `mv` removed it; putting it back leaves an untracked file
       in the agent's way. THE MUTANT: let the pane save a missing buffer (`canSave` without `!missing`)
       together with the deletion-is-typing one — either alone is caught below or in buffers.test.ts. */
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "a.tex": "x", "b.tex": "y" }, ["a.tex", "b.tex"], "a.tex");
    const first = render(pane(store));
    await settle(50);
    const d = disk(api);
    d.remove("b.tex");
    d.remove("a.tex");
    await settle(10);
    expect(screen.getByRole("alert")).toHaveTextContent("This file was deleted on disk.");
    // Nothing typed, so nothing to keep: the bar offers no way to put it back on the pane's behalf.
    expect(screen.queryByRole("button", { name: "Keep mine" })).toBeNull();
    await settle(800);
    first.unmount();
    await settle(50);
    expect(writesTo(api, "a.tex")).toEqual([]);
    expect(writesTo(api, "b.tex")).toEqual([]);
    expect(Object.keys(api.data.documentFiles.docs1 ?? {})).toEqual([]);
  });

  it("a file nobody typed in that went away and came back is reloaded, not questioned and not written", async () => {
    /* A checkout of another branch and back. THE MUTANT: mark a deletion dirty. The buffer then reads
       as the reader's unsaved text: the restored file comes back as a conflict nobody caused. */
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "a.tex": "x" }, ["a.tex"], "a.tex");
    const first = render(pane(store));
    await settle(50);
    const d = disk(api);
    d.remove("a.tex");
    d.put("a.tex", "x, as the other branch has it");
    await settle(50);
    expect(screen.getByLabelText("Edit a.tex")).toHaveValue("x, as the other branch has it");
    expect(screen.queryByRole("alert")).toBeNull();
    await settle(800);
    first.unmount();
    await settle(50);
    expect(writesTo(api, "a.tex")).toEqual([]);
  });

  it("typing in a file that is then deleted is kept, asks before it comes back, and comes back on Keep mine", async () => {
    /* The conflict's rule, for a deletion: the reader's text stays, nothing writes it on their behalf,
       and the bar asks. THE MUTANT: let `canSave` pass a missing buffer. The autosave puts the file
       straight back, which is the deletion undone behind the agent's back. */
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "a.tex": "x" }, ["a.tex"], "a.tex");
    render(pane(store));
    await settle(50);
    fireEvent.change(screen.getByLabelText("Edit a.tex"), { target: { value: "x and my paragraph" } });
    disk(api).remove("a.tex");
    await settle(800);
    expect(writesTo(api, "a.tex")).toEqual([]);
    expect(screen.getByRole("alert")).toHaveTextContent("This file was deleted on disk while you were editing.");
    expect(screen.getByLabelText("Edit a.tex")).toHaveValue("x and my paragraph");
    expect(screen.getByLabelText("Needs attention")).toBeTruthy();
    /* THE MUTANT: Keep mine calls the plain save. The policy refuses it, and the button does nothing. */
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await settle(50);
    expect(api.data.documentFiles.docs1?.["a.tex"]).toBe("x and my paragraph");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("typing in a file that is then deleted is not written as the pane goes", async () => {
    /* THE MUTANT: the write as the pane goes passes `recreate`. Leaving the pane would then answer the
       bar's question for the reader. */
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "a.tex": "x", "b.tex": "y" }, ["a.tex", "b.tex"], "a.tex");
    const first = render(pane(store));
    await settle(50);
    fireEvent.change(screen.getByLabelText("Edit a.tex"), { target: { value: "x and my paragraph" } });
    disk(api).remove("a.tex");
    fireEvent.click(screen.getByTitle("b.tex"));
    await settle(50);
    first.unmount();
    await settle(50);
    expect(writesTo(api, "a.tex")).toEqual([]);
    expect(api.data.documentFiles.docs1?.["a.tex"]).toBeUndefined();
  });
});

describe("typing the pane could not write comes back after a switch, as it was left", () => {
  /** A pane mounted on `store`, settled: a session or space switch is this unmount and a later mount. */
  async function mount(store: ReturnType<typeof makeStore>["store"]) {
    const r = render(pane(store));
    await settle(50);
    return r;
  }
  const typeInto = (name: string, text: string) => fireEvent.change(screen.getByLabelText(`Edit ${name}`), { target: { value: text } });

  it("a conflict comes back across a session switch — the reader's text, the agent's, both choices — and is never written on its own", async () => {
    /* THE MUTANT: keep nothing as the pane goes. The pane comes back on the agent's version, and the
       paragraph the reader typed is gone without a word. */
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "a.tex": "x" }, ["a.tex"], "a.tex");
    const first = await mount(store);
    typeInto("a.tex", "x and my paragraph");
    disk(api).put("a.tex", "x as the agent has it");
    await settle(10);
    expect(screen.getByRole("alert")).toHaveTextContent("This file changed on disk while you were editing.");
    first.unmount();
    await settle(800);

    await mount(store);
    expect(screen.getByRole("alert")).toHaveTextContent("This file changed on disk while you were editing.");
    expect(screen.getByLabelText("Edit a.tex")).toHaveValue("x and my paragraph");
    expect(screen.getByLabelText("Needs attention")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep mine" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Take theirs" })).toBeTruthy();
    await settle(800);
    // Neither the pane going nor the autosave after it answered the question for the reader.
    expect(writesTo(api, "a.tex")).toEqual([]);
    expect(api.data.documentFiles.docs1?.["a.tex"]).toBe("x as the agent has it");

    /* Answered, it is not kept again. THE MUTANT: a pane going forgets nothing for a tab it holds clean.
       The settled conflict comes back from the copy of the switch before. */
    fireEvent.click(screen.getByRole("button", { name: "Take theirs" }));
    await settle(10);
    expect(screen.getByLabelText("Edit a.tex")).toHaveValue("x as the agent has it");
    cleanup();
    await mount(store);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Edit a.tex")).toHaveValue("x as the agent has it");
  });

  it("a conflict comes back against what disk holds now, if the agent wrote again while the pane was away", async () => {
    /* THE MUTANT: lay the kept buffer back as it was, without hearing disk. Take theirs then adopts a
       version the agent has since replaced. */
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "a.tex": "x" }, ["a.tex"], "a.tex");
    const first = await mount(store);
    typeInto("a.tex", "mine");
    disk(api).put("a.tex", "the agent's first pass");
    await settle(10);
    first.unmount();
    disk(api).quietly.put("a.tex", "the agent's second pass");
    await mount(store);
    expect(screen.getByLabelText("Edit a.tex")).toHaveValue("mine");
    fireEvent.click(screen.getByRole("button", { name: "Take theirs" }));
    await settle(10);
    expect(screen.getByLabelText("Edit a.tex")).toHaveValue("the agent's second pass");
  });

  it("typing in a file deleted under it comes back across a space switch, and the file only on Keep mine", async () => {
    /* THE MUTANT: write as the pane goes with `recreate`, i.e. answer the bar for the reader. The
       deleted file is back on disk before the reader has been asked. */
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "a.tex": "x" }, ["a.tex"], "a.tex");
    const first = await mount(store);
    typeInto("a.tex", "x and my paragraph");
    disk(api).remove("a.tex");
    first.unmount();
    await settle(800);
    expect(api.data.documentFiles.docs1?.["a.tex"]).toBeUndefined();

    /* THE MUTANT: drop a kept file whose read fails on the way back, as any vanished tab is dropped. */
    await mount(store);
    expect(screen.getByRole("alert")).toHaveTextContent("This file was deleted on disk while you were editing.");
    expect(screen.getByLabelText("Edit a.tex")).toHaveValue("x and my paragraph");
    expect(screen.getByLabelText("Needs attention")).toBeTruthy();
    await settle(800);
    expect(writesTo(api, "a.tex")).toEqual([]);
    expect(api.data.documentFiles.docs1?.["a.tex"]).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await settle(10);
    expect(api.data.documentFiles.docs1?.["a.tex"]).toBe("x and my paragraph");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closing the file's tab lets the kept typing go", async () => {
    /* THE MUTANT: closing a tab forgets nothing. The pane going does not touch a tab it no longer
       holds, so the closed file comes back, typing and all, on the next switch. */
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "a.tex": "x", "b.tex": "y" }, ["a.tex", "b.tex"], "a.tex");
    const first = await mount(store);
    typeInto("a.tex", "mine");
    disk(api).put("a.tex", "theirs");
    await settle(10);
    first.unmount();
    const again = await mount(store);
    expect(screen.getByRole("alert")).toHaveTextContent("changed on disk");
    fireEvent.click(screen.getByLabelText("Close a.tex"));
    await settle(10);
    again.unmount();
    await mount(store);
    expect(screen.queryByTitle("a.tex")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a kept file no longer on the strip comes back as a tab", async () => {
    /* THE MUTANT: restore only the tabs the strip lists. The typing stays in memory where nothing shows it. */
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "a.tex": "x", "b.tex": "y" }, ["a.tex", "b.tex"], "a.tex");
    const first = await mount(store);
    typeInto("a.tex", "mine");
    disk(api).put("a.tex", "theirs");
    await settle(10);
    first.unmount();
    api.data.documentWorkspaces.docs1!.openPaths = ["b.tex"];
    api.data.documentWorkspaces.docs1!.activePath = "b.tex";
    await mount(store);
    fireEvent.click(screen.getByTitle("a.tex"));
    await settle(10);
    expect(screen.getByLabelText("Edit a.tex")).toHaveValue("mine");
    expect(screen.getByRole("alert")).toHaveTextContent("changed on disk");
  });

  it("typing whose write landed as the pane went is not kept, so a later change by an agent is no conflict", async () => {
    /* THE MUTANT: never forget a copy once its write lands. The saved paragraph comes back as unsaved
       typing, and the agent's later edit as a conflict nobody caused. */
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "a.tex": "x" }, ["a.tex"], "a.tex");
    const first = await mount(store);
    typeInto("a.tex", "x and my paragraph");
    first.unmount();
    await settle(10);
    expect(api.data.documentFiles.docs1?.["a.tex"]).toBe("x and my paragraph");
    disk(api).quietly.put("a.tex", "x and my paragraph, edited by an agent");
    await mount(store);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Edit a.tex")).toHaveValue("x and my paragraph, edited by an agent");
  });

  it("typing whose write was refused as the pane went comes back as the conflict it is", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api, store } = makeStore({ "a.tex": "x" }, ["a.tex"], "a.tex");
    // The real server's check: a write lands only on the disk it was based on.
    const files = api.data.documentFiles.docs1!;
    const hashOf = (t: string) => `h:${t.length}:${t}`;
    api.writeDocument = async (_id, path, text, baseHash) => {
      api.calls.push(`writeDocument:docs1:${path}`);
      const cur = files[path];
      if (cur !== undefined && hashOf(cur) !== baseHash) return { ok: false as const, currentText: cur, currentHash: hashOf(cur) };
      files[path] = text;
      return { ok: true as const, hash: hashOf(text) };
    };
    const first = await mount(store);
    typeInto("a.tex", "mine");
    disk(api).quietly.put("a.tex", "the agent's, unheard"); // between the last event and the pane going
    first.unmount();
    await settle(10);
    expect(writesTo(api, "a.tex")).toHaveLength(1);
    expect(files["a.tex"]).toBe("the agent's, unheard");
    await mount(store);
    expect(screen.getByRole("alert")).toHaveTextContent("changed on disk");
    expect(screen.getByLabelText("Edit a.tex")).toHaveValue("mine");
  });
});

