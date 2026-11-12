import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, session } from "../../state/store.test-fakes";
import { Transcript } from "./Transcript";
import { reduceAll } from "./transcript-model";

const LEAD = "01JC0000000000000000000001";
const POLISH = "01JC0000000000000000000009";

const set = (by: string | null, from: string, to: string, note: string) =>
  sessionEvent("access_changed", { teammateId: POLISH, handle: "polish", by, from, to, note });

async function mount(events: ReturnType<typeof set>[], undo: (id: string, from: string, to: string) => Promise<never> | Promise<unknown>) {
  const api = fakeApi({ sessions: [session(LEAD, "s1")] });
  const calls: string[] = [];
  api.teammateUndoAccess = async (id, from, to) => { calls.push(`${id}:${from}:${to}`); return undo(id, from, to) as never; };
  const store = createAppStore(api); await store.getState().boot();
  render(<StoreContext.Provider value={store}>
    <Transcript transcript={reduceAll(events)} sessionStatus="idle" onDecide={() => {}} sessionId={LEAD} />
  </StoreContext.Provider>);
  return { calls };
}

afterEach(() => cleanup());

describe("a line saying the Lead changed a teammate's access", () => {
  it("says who changed what, and its Undo puts the teammate back on the mode it was on", async () => {
    const { calls } = await mount([set("captain", "default", "bypassPermissions", "@captain set @polish to Full access, at your request.")],
      async () => { throw new Error("no teammate in the fake"); });
    expect(screen.getByText("@captain set @polish to Full access, at your request.")).toBeTruthy();
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo.getAttribute("data-no-agent")).toBe("teammate access undo");
    fireEvent.click(undo);
    await waitFor(() => expect(calls).toEqual([`${POLISH}:default:bypassPermissions`]));
  });

  it("says why when the server will not undo it", async () => {
    await mount([set("captain", "default", "bypassPermissions", "@captain set @polish to Full access, at your request.")],
      async () => { throw new Error("@polish is on Accept edits now, so there is nothing to undo"); });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("@polish is on Accept edits now, so there is nothing to undo")).toBeTruthy();
  });

  it("offers Undo only on the newest line for that teammate, and never on the person's own", async () => {
    await mount([
      set("captain", "default", "bypassPermissions", "@captain set @polish to Full access, at your request."),
      set(null, "bypassPermissions", "default", "You set @polish back to Ask each time."),
    ], async () => ({}));
    expect(screen.getByText("You set @polish back to Ask each time.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});
