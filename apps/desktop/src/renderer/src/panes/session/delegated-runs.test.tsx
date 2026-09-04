import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { allItems, type DelegatedRun } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";

const KID: DelegatedRun = { sessionId: "se2", startedAt: 0, detached: false, owned: true };
const PEER: DelegatedRun = { sessionId: "se3", startedAt: 0, detached: false, owned: false };

const ITEMS = { s1: [
  item("i9", "s1", { kind: "session", title: "Parent", refId: "se1" }),
  item("i8", "s1", { kind: "session", title: "Agent: audit the mapper", refId: "se2" }),
  item("i7", "s1", { kind: "session", title: "A colleague", refId: "se3" }),
] };
const SESSIONS = [
  session("se1", "s1", { title: "Parent" }),
  session("se2", "s1", { title: "Agent: audit the mapper", status: "running", dispatchedBy: { sessionId: "se1", kind: "agent_run" } }),
  session("se3", "s1", { title: "A colleague" }),
];

async function mount(delegatedRuns: Record<string, DelegatedRun[]> = {}) {
  const api = fakeApi({ items: ITEMS, sessions: SESSIONS, delegatedRuns });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ sessionStatus: { se1: "running", se2: "running" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
  await store.getState().openItem("i9");
  const r = render(<StoreContext.Provider value={store}><SessionPane item={ITEMS.s1[0]!} visible /></StoreContext.Provider>);
  return { api, store, ...r };
}

const dock = () => screen.queryByRole("button", { name: /agents? in flight for Parent/ });

afterEach(() => cleanup());

describe("the delegating session's dock", () => {
  it("draws nothing at all for a session that is waiting on no one", async () => {
    await mount();
    expect(dock()).toBeNull();
  });

  it("fetches on mount, so a pane opened mid-delegation still sees the run", async () => {
    const { api } = await mount({ se1: [KID] });
    // THE MUTANT: drop the fetch and rely on `delegation.changed` alone. The registry is in the
    // server's memory, so a reload — or a second window, or opening the pane ten minutes in — would
    // show nothing until the run ENDED, which is exactly when it stops being worth showing.
    await waitFor(() => expect(dock()).not.toBeNull());
    expect(api.calls).toContain("listDelegatedRuns:se1");
    expect(screen.getByRole("button", { name: /Agent: audit the mapper/ })).toBeInTheDocument();
  });

  it("leaves when the last run settles rather than sitting there stale", async () => {
    const { store } = await mount({ se1: [KID] });
    await waitFor(() => expect(dock()).not.toBeNull());
    store.getState().applyDelegationChanged({ sessionId: "se1", running: [] });
    // THE MUTANT: have `applyDelegationChanged` merge, or park the empty array under the key. The
    // pane then keeps announcing an agent that finished, with nothing left that will ever correct
    // it — the registry has already forgotten the run.
    await waitFor(() => expect(dock()).toBeNull());
    expect(store.getState().delegatedRuns).not.toHaveProperty("se1");
  });

  it("refetches when the socket comes back, because the registry may have died with the server", async () => {
    const scripted: Record<string, DelegatedRun[]> = { se1: [KID] };
    const { store } = await mount(scripted);
    await waitFor(() => expect(dock()).not.toBeNull());
    delete scripted["se1"]; // the server restarted while we were away: it is holding nothing now
    store.getState().applyConnectionState("reconnecting");
    store.getState().applyConnectionState("connected");
    // THE MUTANT: leave delegation out of the reconnect refetch. Every other kind of stale state
    // that gap covers is backed by a table the server can re-read; this one is not backed by
    // anything, so nothing will ever arrive to correct it and the dock names agents that are gone.
    await waitFor(() => expect(dock()).toBeNull());
  });

  it("replaces the set rather than accumulating: the payload is the whole truth", async () => {
    const { store } = await mount({ se1: [KID] });
    await waitFor(() => expect(dock()).not.toBeNull());
    store.getState().applyDelegationChanged({ sessionId: "se1", running: [PEER] });
    expect(store.getState().delegatedRuns["se1"]).toEqual([PEER]);
  });

  it("opens a sub-agent BESIDE its parent, never over the top of it", async () => {
    const { store } = await mount({ se1: [KID] });
    await waitFor(() => expect(dock()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Agent: audit the mapper/ }));
    // THE MUTANT: open in place. The pane the user pressed the button in is the parent whose work
    // they are trying to follow, and evicting it to show the child destroys the comparison.
    await waitFor(() => expect(allItems(store.getState().layout!)).toEqual(expect.arrayContaining(["i9", "i8"])));
  });

  it("does not call a peer it merely asked a question a sub-agent", async () => {
    await mount({ se1: [PEER] });
    // THE MUTANT: read the origin off the session row for every run. A peer was doing its own work
    // before the question arrived and keeps doing it after — `agent_ask` neither spawned it nor owns
    // it, and its own row says nothing about this session at all.
    await waitFor(() => expect(screen.getByRole("button", { name: /A colleague/ })).toHaveAccessibleName(/Asked a question/));
  });
});
