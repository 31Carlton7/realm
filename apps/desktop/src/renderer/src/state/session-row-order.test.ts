import { describe, expect, it } from "vitest";
import { sessionEvent, type SessionEvent } from "@realm/contracts";
import { createAppStore, type AppState } from "./store";
import { fakeApi, item, session, space } from "./store.test-fakes";
import { listedSessions, spaceRows, type SidebarState } from "../components/sidebar/model";

/**
 * What moves a session's row in the sidebar, against the store as the app drives it.
 *
 * A row moves when its conversation does — a prompt going out, a reply, a turn ending — and for
 * nothing a reader does: selecting it, reading it, the statuses a resume passes through, a write to
 * its row, renaming it. Eight idle sessions a minute apart, the fifth (`e`) unread.
 */
const IDS = ["a", "b", "c", "d", "e", "f", "g", "h"];
const T0 = 1_000_000;

async function booted() {
  const api = fakeApi({
    spaces: [space("s1", "p1", "Versed")],
    items: { s1: IDS.map((id) => item(`i-${id}`, "s1", { kind: "session", refId: `se-${id}`, title: id })) },
    sessions: IDS.map((id, i) => session(`se-${id}`, "s1", { activityAt: T0 - i * 60_000, updatedAt: T0 - i * 60_000, lastEventSeq: 9, seenSeq: id === "e" ? 4 : 9 })),
  });
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
}

const order = (st: AppState) => spaceRows(listedSessions({ ...st, quickChatId: null } as unknown as SidebarState)).map((r) => r.id.replace("se-", ""));
const event = (id: string, seq: number, ev: SessionEvent) => ({ seq, sessionId: `se-${id}`, event: ev, ephemeral: false });

describe("a session's row stays where it is", () => {
  it("when it is opened and read", async () => {
    const { store } = await booted();
    expect(order(store.getState())).toEqual(IDS);
    await store.getState().openItem("i-e");
    await store.getState().markSessionSeen("se-e");
    expect(order(store.getState())).toEqual(IDS);
  });

  it("when opening it resumes the agent: an init, and the statuses passed through on the way", async () => {
    const { store } = await booted();
    store.getState().applySessionEvent(event("e", 10, sessionEvent("init", { providerSessionId: "p-e", model: null, tools: [] } as never)));
    store.getState().applySessionStatus("se-e", "ended");
    store.getState().applySessionStatus("se-e", "idle");
    store.getState().applySessionEvent(event("e", 11, sessionEvent("status", { status: "idle" })));
    expect(order(store.getState())).toEqual(IDS);
  });

  it("when its row is written to, refetched, or renamed", async () => {
    const { api, store } = await booted();
    api.data.sessions.find((s) => s.id === "se-e")!.updatedAt = T0 + 60_000;
    await store.getState().refreshAllSessions();
    await store.getState().updateItem({ id: "i-e", title: "renamed" });
    expect(order(store.getState())).toEqual(IDS);
  });

  it("when a message is written while a turn is running — it is queued, and moves the row when it goes", async () => {
    const { store } = await booted();
    store.getState().applySessionStatus("se-e", "running");
    const ranked = order(store.getState()); // a running session ranks above the idle ones
    await store.getState().sendMessage("se-e", "and then this");
    expect(store.getState().sessionActivityAt["se-e"]).toBe(T0 - 4 * 60_000);
    expect(order(store.getState())).toEqual(ranked);
  });
});

describe("a session's row comes to the top", () => {
  it("as a prompt is sent — before the server's echo", async () => {
    const { store } = await booted();
    await store.getState().sendMessage("se-e", "keep going");
    expect(order(store.getState())).toEqual(["e", "a", "b", "c", "d", "f", "g", "h"]);
  });

  it("when a prompt or a reply arrives from the server — a queued message going out, another window's", async () => {
    const { store } = await booted();
    store.getState().applySessionEvent(event("e", 10, sessionEvent("user_message", { text: "queued", attachments: [] }, T0 + 1)));
    expect(order(store.getState())[0]).toBe("e");
    store.getState().applySessionEvent(event("g", 11, sessionEvent("assistant_text", { messageId: "m", text: "done" }, T0 + 2)));
    expect(order(store.getState()).slice(0, 2)).toEqual(["g", "e"]);
  });

  it("when its turn ends", async () => {
    const { store } = await booted();
    store.getState().applySessionStatus("se-f", "running");
    store.getState().applySessionStatus("se-f", "idle");
    expect(order(store.getState())[0]).toBe("f");
  });

  it("and a list refetched a moment later, still holding the server's older time, does not pull it back", async () => {
    const { store } = await booted();
    await store.getState().sendMessage("se-e", "keep going");
    await store.getState().refreshAllSessions();
    expect(order(store.getState())[0]).toBe("e");
  });
});
