import { describe, expect, it } from "vitest";
import { findLeafOfItem, findSidePane } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, session } from "./store.test-fakes";
import { appCommands } from "../keys/commands";

/**
 * The documents pane, reached from outside it: ⌘P (`palette.files`, `findInDocuments`), a file shown
 * at a line (`openDocumentPath(…, { line })`), and a listed file added to the next message
 * (`attachPaths`). Every test names the one-line change that would make it fail.
 */

type Store = ReturnType<typeof createAppStore>;
const docsOf = (store: Store) => store.getState().items.find((i) => i.kind === "documents");

/** The lead focused in a pane of its own, nothing beside it. */
async function mount(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({
    items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }), item("i-term", "s1", { kind: "terminal", title: "Shell" })] },
    sessions: [session("lead", "s1", { environmentId: "env-lead" })],
    ...over,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-lead");
  return { api, store };
}

describe("⌘P", () => {
  it("opens the focused session's documents as a tab of its side pane, and asks for the search", async () => {
    // THE MUTANT: the old palette (`setPaletteOpen(true, "files")`) — a search that found a file
    // and then opened a pane somewhere else.
    const { api, store } = await mount();
    appCommands(store)["palette.files"]!();
    await waitForAsk(store);
    expect(api.calls).toContain("createDocuments:s1:env-lead");
    const docs = docsOf(store)!;
    expect(findSidePane(store.getState().layout!, "i-lead")?.tabs).toContain(docs.id);
    expect(store.getState()).toMatchObject({ paletteOpen: false, documentsAsk: { documentsId: docs.refId, search: true } });
  });

  it("from ⌘⇧P's own field, closes the palette and takes the question to the pane", async () => {
    const { store } = await mount();
    store.getState().setPaletteOpen(true, "grep");
    await store.getState().findInDocuments();
    expect(store.getState().paletteOpen).toBe(false);
    expect(store.getState().documentsAsk).toMatchObject({ search: true });
  });

  it("serves the session on screen when the keyboard is in a terminal beside it", async () => {
    // THE MUTANT: read only the focused leaf, and ⌘P from a terminal opens the space's documents
    // with no session to list.
    const { api, store } = await mount();
    await store.getState().openItemBeside("i-term");
    expect(store.getState().focusedLeafId).toBe(findLeafOfItem(store.getState().layout!, "i-term")!.id);
    await store.getState().findInDocuments();
    expect(api.calls).toContain("createDocuments:s1:env-lead");
    expect(findSidePane(store.getState().layout!, "i-lead")?.tabs).toContain(docsOf(store)!.id);
  });

  it("asks a documents pane that already has the keyboard for its search, where it is", async () => {
    const { api, store } = await mount();
    await store.getState().findInDocuments();
    const docs = docsOf(store)!;
    const made = api.calls.filter((c) => c.startsWith("createDocuments:")).length;
    store.getState().focusLeaf(findLeafOfItem(store.getState().layout!, docs.id)!.id);
    const before = store.getState().documentsAsk!.seq;
    await store.getState().findInDocuments();
    expect(api.calls.filter((c) => c.startsWith("createDocuments:"))).toHaveLength(made);
    // A second ask is a second ask: the pane's search takes the keyboard again.
    expect(store.getState().documentsAsk!.seq).toBeGreaterThan(before);
  });

  it("is taken once — a newer ask is left for the pane it is for", async () => {
    const { store } = await mount();
    await store.getState().findInDocuments();
    const first = store.getState().documentsAsk!.seq;
    await store.getState().findInDocuments();
    store.getState().takeDocumentsAsk(first);
    expect(store.getState().documentsAsk).not.toBeNull();
    store.getState().takeDocumentsAsk(store.getState().documentsAsk!.seq);
    expect(store.getState().documentsAsk).toBeNull();
  });
});

describe("a file at a line", () => {
  it("rides to the pane by the tab's own name for the file, whatever shape the path came in", async () => {
    // The server answers the path as the tab names it; an absolute path from an agent's prose and
    // the tab's relative one are the same file. THE MUTANT: key the ask on the path as sent.
    const { api, store } = await mount();
    const answer = api.openDocumentPath;
    api.openDocumentPath = async (sid, path, env) => ({ ...(await answer(sid, path, env)), path: "src/greet.ts" });
    await store.getState().openDocumentPath("/repo/src/greet.ts", null, null, { line: 42 });
    expect(store.getState().documentsAsk).toMatchObject({ path: "src/greet.ts", line: 42 });
  });

  it("asks nothing of the pane for an open with no line", async () => {
    const { store } = await mount();
    await store.getState().openDocumentPath("README.md");
    expect(store.getState().documentsAsk).toBeNull();
  });
});

describe("a listed file, added to the next message", () => {
  it("goes in as the prompter's own attachment, described by main", async () => {
    const { api, store } = await mount();
    await store.getState().attachPaths("lead", ["/repo/notes/plan.md"]);
    expect(api.calls).toContain("describePaths");
    expect(store.getState().pendingAttachments.lead).toEqual([{ path: "/repo/notes/plan.md", mime: "text/markdown", name: "plan.md", size: 1 }]);
  });

  it("says a file that is no longer on disk, rather than adding nothing in silence", async () => {
    // Main describes only what it can stat. THE MUTANT: hand its answer straight on, and a click on
    // a file an agent has since deleted adds no chip and says nothing.
    const { api, store } = await mount();
    api.describePaths = async () => [];
    await store.getState().attachPaths("lead", ["/repo/gone.md"]);
    expect(store.getState().pendingAttachments.lead ?? []).toEqual([]);
    expect(store.getState().toasts.map((t) => t.text)).toEqual(["No longer on disk: gone.md"]);
  });
});

async function waitForAsk(store: Store) {
  for (let i = 0; i < 50 && store.getState().documentsAsk === null; i++) await new Promise((r) => setTimeout(r, 10));
}
