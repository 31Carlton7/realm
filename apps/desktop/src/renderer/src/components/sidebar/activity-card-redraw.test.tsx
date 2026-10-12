import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { Session } from "@realm/contracts";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, session, space } from "../../state/store.test-fakes";

/* Every card's tooltip is formatted in its render, so the calls per moment count the card's renders. */
const titled = vi.hoisted(() => [] as number[]);
vi.mock("../../panes/session/timestamps", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../panes/session/timestamps")>();
  return { ...real, stampTitle: (ts: number) => { titled.push(ts); return real.stampTitle(ts); } };
});

/**
 * The Activity view redraws only the cards a store write changed. Every event a working session
 * writes rebuilds every row object; drawing all of them again on each one is what held frames while
 * the list was being scrolled (sidebar-scroll-perf-live.mjs).
 */
afterEach(() => { cleanup(); titled.length = 0; });

describe("the Activity view while a session works", () => {
  it("redraws the card of the session that moved and leaves the rest alone", async () => {
    // THE MUTANT: `memo(` taken off ActivityCardView (or its comparator returning false) — the quiet card draws again on every write.
    const A = 1_760_000_000_000, B = A - 3_600_000;
    const sessions: Session[] = [session("a", "s1", { title: "quiet", activityAt: A, createdAt: A }), session("b", "s1", { title: "busy", activityAt: B, createdAt: B })];
    const items = { s1: sessions.map((s) => item(`i-${s.id}`, "s1", { kind: "session", refId: s.id, title: s.title })) };
    const api = fakeApi({ profiles: [profile("p1", "Work")], spaces: [space("s1", "p1", "Work")], items, sessions, settings: { "ui.sidebarLens": "recent" } });
    const store = createAppStore(api);
    await store.getState().boot();
    const { container } = render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
    await waitFor(() => expect(container.querySelectorAll(".sb-recent .sb-card")).toHaveLength(2));
    await waitFor(() => expect(api.calls).toContain("listAllItems"));
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    titled.length = 0;
    // An event in "b": its row in `sessions` moves, as `logGrew` moves it on every persisted event.
    act(() => {
      const s = store.getState();
      const b = s.sessions.b ?? s.allSessions.b!;
      store.setState({ sessions: { ...s.sessions, b: { ...b, lastEventSeq: b.lastEventSeq + 1 } } });
    });
    expect(titled.filter((t) => t === B).length).toBeGreaterThan(0);
    expect(titled.filter((t) => t === A)).toHaveLength(0);
  });
});
