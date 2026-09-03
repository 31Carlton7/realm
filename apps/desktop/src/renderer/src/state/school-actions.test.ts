import { describe, expect, it } from "vitest";
import { allItems, findLeafOfItem } from "@realm/contracts";
import { createAppStore } from "./store";
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
  it("brings the item in beside the focused pane, quietly, for the active space only", async () => {
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
  it("makes a named group for today, opens the lecture file in it, and a session beside it", async () => {
    const { api, store } = await booted();
    await store.getState().startLecture("Pipelining hazards");
    const gs = store.getState().groups!;
    expect(gs.groups).toHaveLength(2);
    const active = gs.groups.find((g) => g.id === gs.activeGroupId)!;
    expect(active.name).toMatch(/^Pipelining hazards · \d{4}-\d{2}-\d{2}$/);
    expect(api.calls).toContain("startLecture:s1:Pipelining hazards");
    const ids = allItems(active.layout);
    const items = store.getState().items;
    const kinds = ids.map((id) => items.find((i) => i.id === id)?.kind);
    expect(kinds.sort()).toEqual(["documents", "session"]);
    // The original session pane stays in the Main group, untouched.
    const main = gs.groups.find((g) => g.id !== gs.activeGroupId)!;
    expect(allItems(main.layout)).toEqual(["i-sess"]);
    // Nothing is sent to the new session — a lecture starts quiet.
    expect(api.sent).toEqual([]);
    const created = store.getState().items.filter((i) => i.kind === "session" && i.id !== "i-sess");
    expect(created).toHaveLength(1);
  });

  it("names the group after the date alone when no topic is given", async () => {
    const { store } = await booted();
    await store.getState().startLecture("   ");
    const gs = store.getState().groups!;
    expect(gs.groups.find((g) => g.id === gs.activeGroupId)!.name).toMatch(/^Lecture · \d{4}-\d{2}-\d{2}$/);
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
