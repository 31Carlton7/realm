import { describe, expect, it } from "vitest";
import { allItems, findSidePane } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, session } from "./store.test-fakes";

/**
 * A file named in a transcript opens where the session's own Documents button opens one: as a tab of
 * that session's side pane, the session left exactly where it was — the reader asked to look at a
 * file, not to leave what they were reading.
 */
async function reading() {
  const api = fakeApi();
  api.data.items.s1 = [item("i-a", "s1", { kind: "session", refId: "a" })];
  api.data.sessions = [session("a", "s1")];
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-a");
  return { api, store };
}

describe("a file opened from the transcript", () => {
  it("is a tab of the session's side pane, and the session keeps its pane", async () => {
    // THE MUTANT: hand `adoptItem` no `beside` — the documents pane then takes the session's own leaf.
    const { store } = await reading();
    await store.getState().openDocumentPath("/tmp/web/lib/orgs.ts", null, "s1", { line: 83, beside: { sessionId: "a" } });
    const layout = store.getState().layout!;
    const docs = allItems(layout).find((id) => id !== "i-a");
    expect(allItems(layout)).toContain("i-a");
    expect(findSidePane(layout, "i-a")).toMatchObject({ itemId: docs, tabs: [docs] });
    // …and the line rides along, for the editor to land on when it opens.
    expect(store.getState().documentsAsk).toMatchObject({ documentsId: expect.any(String), path: "/tmp/web/lib/orgs.ts", line: 83 });
  });

  it("asked for with no session to sit beside, takes the focused pane as it always has", async () => {
    const { store } = await reading();
    await store.getState().openDocumentPath("/tmp/notes.md", null, "s1");
    expect(allItems(store.getState().layout!)).not.toContain("i-a");
    expect(store.getState().documentsAsk).toBeNull();
  });
});
