import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, session, space } from "../../state/store.test-fakes";
import { HOVER_PREFETCH_MS, NEIGHBOUR_PREFETCH_MS } from "./prefetch";

/** A session's log is read ahead of the click on its row: the rows beside the one on screen, and the
 *  row the pointer rests on. */
afterEach(cleanup);

const IDS = ["w", "x", "y", "z"];
async function mount() {
  const api = fakeApi({
    profiles: [profile("p1", "Work")],
    spaces: [space("s1", "p1", "Versed")],
    items: { s1: IDS.map((id) => item(`i-${id}`, "s1", { kind: "session", refId: id, title: `Chat ${id}` })) },
    // Newest first in the list: w, x, y, z.
    sessions: IDS.map((id, i) => session(id, "s1", { title: `Chat ${id}`, activityAt: 100 - i, updatedAt: 100 - i, lastEventSeq: 1 })),
    sessionEvents: Object.fromEntries(IDS.map((id) => [id, [{ seq: 1, sessionId: id, event: sessionEvent("user_message", { text: `hi ${id}`, attachments: [] }, 1) }]])),
  });
  const store = createAppStore(api); await store.getState().boot();
  render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
  await waitFor(() => expect(api.calls).toContain("listAllItems"));
  return { api, store };
}
const readAhead = (calls: string[]) => IDS.filter((id) => calls.includes(`sessionEventsBefore:${id}:end`));
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("reading a session ahead of the click", () => {
  it("reads the row the pointer rests on, and not the rows it only passes over", async () => {
    const { api } = await mount();
    const row = (id: string) => screen.getByRole("button", { name: new RegExp(`^Chat ${id}`) });
    fireEvent.pointerEnter(row("w")); fireEvent.pointerLeave(row("w"));
    fireEvent.pointerEnter(row("x"));
    await wait(HOVER_PREFETCH_MS + 30);
    expect(readAhead(api.calls)).toEqual(["x"]);
  });

  it("reads the rows above and below the session in focus, once it is on screen", async () => {
    const { api, store } = await mount();
    await act(() => store.getState().revealSession("x", "s1"));
    expect(readAhead(api.calls)).toEqual([]);
    await wait(NEIGHBOUR_PREFETCH_MS + 50);
    expect(readAhead(api.calls)).toEqual(["w", "y"]);
  });
});
