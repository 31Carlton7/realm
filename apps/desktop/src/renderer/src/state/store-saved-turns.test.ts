import { describe, expect, it } from "vitest";
import { createAppStore } from "./store";
import { fakeApi, item, session, space } from "./store.test-fakes";

/**
 * Saved turns in the store: one session's set, read when its pane mounts and kept by `session.saved`;
 * the bookmark's save, shown at once and put back on a refusal; and the pulse that opens a session AT a
 * prompt when the Library sends the reader there.
 */
async function mount(saved: Record<string, number[]> = { se1: [11] }) {
  const api = fakeApi({
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework")],
    items: { s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "Org access" })], s2: [] },
    sessions: [session("se1", "s1"), session("ghost", "s1")],
    savedTurns: saved,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
}

describe("saved turns in the store", () => {

  it("shows a save at once, and keeps the server's answer over its own guess", async () => {
    const { api, store } = await mount();
    await store.getState().refreshSavedTurns("se1");
    let answer!: (seqs: number[]) => void;
    api.setTurnSaved = () => new Promise((resolve) => { answer = resolve; });
    const pending = store.getState().saveTurn("se1", 13, true);
    // Under the pointer, before the round trip: the bookmark already reads as saved.
    expect(store.getState().savedTurns.se1).toEqual([11, 13]);
    answer([13]); // another window unsaved 11 meanwhile
    await pending;
    expect(store.getState().savedTurns.se1).toEqual([13]);
  });

  it("puts a save back when the server refuses it", async () => {
    const { api, store } = await mount();
    await store.getState().refreshSavedTurns("se1");
    api.setTurnSaved = async () => { throw new Error("event 13 is not a prompt"); };
    await expect(store.getState().saveTurn("se1", 13, true)).rejects.toThrow(/not a prompt/);
    expect(store.getState().savedTurns.se1).toEqual([11]);
    // …and an unsave too.
    await expect(store.getState().saveTurn("se1", 11, false)).rejects.toThrow(/not a prompt/);
    expect(store.getState().savedTurns.se1).toEqual([11]);
  });

  it("opens a session at a prompt only when it could bring the session forward, and the pulse is spent once", async () => {
    const { store } = await mount();
    expect(await store.getState().revealPrompt("se1", "s1", 13)).toBe(true);
    const pulse = store.getState().promptFor!;
    expect(pulse).toMatchObject({ sessionId: "se1", seq: 13 });
    // An older pulse's word does not spend a newer one.
    await store.getState().revealPrompt("se1", "s1", 11);
    store.getState().promptTaken(pulse.n);
    expect(store.getState().promptFor).toMatchObject({ seq: 11 });
    store.getState().promptTaken(store.getState().promptFor!.n);
    expect(store.getState().promptFor).toBeNull();
    // A session with no pane to bring forward is no place to land: nothing is left waiting for it.
    expect(await store.getState().revealPrompt("ghost", "s1", 3)).toBe(false);
    expect(store.getState().promptFor).toBeNull();
  });
});
