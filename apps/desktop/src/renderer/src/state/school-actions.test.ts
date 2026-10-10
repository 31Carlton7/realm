import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS_KEY, allItems, findLeafOfItem } from "@realm/contracts";
import { SETTING_LAST_MODELS, createAppStore } from "./store";
import { fakeApi, item, space } from "./store.test-fakes";

/** A booted store on space s1 with one session pane open, the state a student starts a lecture from. */
async function booted(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({ spaces: [space("s1", "p1", "EE 457")], items: { s1: [item("i-sess", "s1", { kind: "session", refId: "se1" })] }, ...over });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().selectSpace("s1");
  await store.getState().openItem("i-sess");
  return { api, store };
}

describe("openDocumentPath (Plan 22)", () => {
  it("asks the server to open the path and brings the documents item into the layout", async () => {
    const { api, store } = await booted({ documentFiles: {} });
    await store.getState().openDocumentPath("lectures/a.md");
    expect(api.calls).toContain("openDocumentPath:s1:lectures/a.md");
    const docs = store.getState().items.find((i) => i.kind === "documents")!;
    expect(docs).toBeDefined();
    expect(findLeafOfItem(store.getState().layout!, docs.id)).not.toBeNull();
    // The server-side strip now carries the path as the active tab.
    const ws = await api.getDocuments(docs.refId);
    expect(ws).toMatchObject({ openPaths: ["lectures/a.md"], activePath: "lectures/a.md" });
  });
});

describe("applyDocumentOpenRequested", () => {
  it("brings the item in beside the focused pane, quietly, for the window's own spaces only", async () => {
    const { api, store } = await booted();
    const { itemId } = await api.createDocuments("s1");
    const focusedBefore = store.getState().focusedLeafId;
    await store.getState().applyDocumentOpenRequested({ spaceId: "s1", environmentId: "env-s1", documentsId: "x", itemId, path: "g.html" });
    expect(findLeafOfItem(store.getState().layout!, itemId)).not.toBeNull();
    expect(store.getState().focusedLeafId).toBe(focusedBefore); // no focus steal
    // Another space's event changes nothing here.
    const layoutBefore = store.getState().layout;
    await store.getState().applyDocumentOpenRequested({ spaceId: "s2", environmentId: "e", documentsId: "x", itemId: "nope", path: "g.html" });
    expect(store.getState().layout).toBe(layoutBefore);
  });

  it("leaves an item that is already on screen alone", async () => {
    const { api, store } = await booted();
    const { itemId } = await api.createDocuments("s1");
    await store.getState().refreshItems();
    await store.getState().openItem(itemId);
    const before = store.getState().layout;
    await store.getState().applyDocumentOpenRequested({ spaceId: "s1", environmentId: "env-s1", documentsId: "x", itemId, path: "g.html" });
    expect(store.getState().layout).toBe(before);
  });
});

describe("startLecture", () => {
  it("puts the lecture file in the main view with a session beside it, and leaves the session it replaced in its space", async () => {
    const { api, store } = await booted();
    await store.getState().startLecture("Pipelining hazards");
    expect(api.calls).toContain("startLecture:s1:Pipelining hazards");
    const ids = allItems(store.getState().layout!);
    const items = store.getState().items;
    const kinds = ids.map((id) => items.find((i) => i.id === id)?.kind);
    // THE MUTANT: open the lecture beside the session instead — three panes, or the session evicted
    // for the session only. One view, two panes: the notes and the assistant.
    expect(kinds).toEqual(["documents", "session"]);
    // The session it replaced is off the screen and nothing else: still an item of the space.
    expect(ids).not.toContain("i-sess");
    expect(items.map((i) => i.id)).toContain("i-sess");
    // Nothing is sent to the new session — a lecture starts quiet.
    expect(api.sent).toEqual([]);
    const created = store.getState().items.filter((i) => i.kind === "session" && i.id !== "i-sess");
    expect(created).toHaveLength(1);
    expect(store.getState().sessions[created[0]!.refId]!.title).toMatch(/^Lecture assistant · Pipelining hazards$/);
  });

  it("names the assistant after the date alone when no topic is given", async () => {
    const { api, store } = await booted();
    await store.getState().startLecture("   ");
    expect(api.data.sessions.at(-1)!.title).toMatch(/^Lecture assistant · \d{4}-\d{2}-\d{2}$/);
  });

  it("starts in the space it is told, whichever space the session in focus is from", async () => {
    const { api, store } = await booted({ spaces: [space("s1", "p1", "EE 457"), space("s2", "p1", "CS 101")] });
    await store.getState().startLecture("Graphs", "s2");
    expect(api.calls).toContain("startLecture:s2:Graphs");
    expect(api.data.sessions.at(-1)!.spaceId).toBe("s2");
  });
});

describe("wrapUpLecture", () => {
  it("opens a session beside the focused pane and sends it the wrap-up prompt naming the file and course", async () => {
    const { api, store } = await booted();
    await store.getState().wrapUpLecture({ path: "lectures/2026-09-02-caches.md", title: "Caches", date: "2026-09-02", hasTranscript: true, sizeBytes: 10 });
    expect(api.sent).toHaveLength(1);
    const msg = api.sent[0]!;
    expect(msg.text).toContain("`lectures/2026-09-02-caches.md`");
    expect(msg.text).toContain("EE 457");
    expect(msg.text).toContain('"## Transcript" is the recording');
    expect(msg.text).toContain("docs_open");
    expect(msg.text).not.toMatch(/(^|\s)@[a-z]/); // no literal mentions reach the agent
    const sess = store.getState().sessions[msg.id]!;
    expect(sess.title).toBe("Wrap up · Caches");
    // Beside, not replacing: both panes are on screen.
    expect(allItems(store.getState().layout!)).toHaveLength(2);
  });
});

/** A student with Sonnet 5 chosen for new Claude sessions, who last sent on Opus 5.5 — and every
 *  session the store then asks the server to make, as it was asked for. */
async function withSonnetChosen() {
  const { api, store } = await booted({ settings: { [DEFAULT_MODELS_KEY]: { claude: "claude-sonnet-5" }, [SETTING_LAST_MODELS]: { claude: "claude-opus-5-5" } } });
  const asked: unknown[] = [];
  const create = api.createSession;
  api.createSession = async (input) => { asked.push(input); return create(input); };
  return { store, asked };
}

describe("the model a lecture's sessions are asked for", () => {
  it("names no model for the lecture's assistant, leaving the server to start it on the one chosen for its agent", async () => {
    const { store, asked } = await withSonnetChosen();
    await store.getState().startLecture("Pipelining hazards");
    expect(asked).toStrictEqual([{ spaceId: "s1", agentKind: "claude", title: "Lecture assistant · Pipelining hazards" }]);
  });

  it("names no model for the wrap-up, leaving the server to start it on the one chosen for its agent", async () => {
    const { store, asked } = await withSonnetChosen();
    await store.getState().wrapUpLecture({ path: "lectures/2026-09-02-caches.md", title: "Caches", date: "2026-09-02", hasTranscript: true, sizeBytes: 10 });
    expect(asked).toStrictEqual([{ spaceId: "s1", agentKind: "claude", title: "Wrap up · Caches" }]);
  });
});

describe("plynnImport", () => {
  it("imports into the active space and refreshes items so the pane the server opened is listed", async () => {
    const { api, store } = await booted({ plynn: { available: true, folder: "/m", meetings: [{ file: "/m/2026-09-02 10.00 L.md", title: "L", startedAt: "2026-09-02T10:00", sizeBytes: 5, imported: false }] } });
    const r = await store.getState().plynnImport(["/m/2026-09-02 10.00 L.md"]);
    expect(r.imported).toEqual([{ file: "/m/2026-09-02 10.00 L.md", path: "lectures/imported-2026-09-02 10.00 L.md" }]);
    expect(api.calls).toContain("plynnImport:s1:1");
    expect(store.getState().items.some((i) => i.kind === "documents")).toBe(true);
    expect((await store.getState().plynnList()).meetings[0]!.imported).toBe(true);
  });
});
