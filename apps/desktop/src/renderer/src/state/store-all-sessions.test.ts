import { describe, expect, it } from "vitest";
import { sessionEvent } from "@realm/contracts";
import { isUnread } from "./attention";
import { createAppStore } from "./store";
import { fakeApi, item, session, space, type FakeData } from "./store.test-fakes";

const boot = async (overrides: FakeData = {}) => {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
};

/** A session in the room you are NOT in, which `sessions` never holds. */
const elsewhere = () => ({
  items: { s1: [item("i1", "s1", { title: "Terminal" })], s2: [item("i2", "s2", { kind: "session", refId: "se2", title: "Port the picker" })] },
  sessions: [session("se2", "s2", { title: "Port the picker", status: "running", seenSeq: 4, lastEventSeq: 4 })],
});

describe("allSessions — a row for every session, in every room", () => {
  it("is seeded at boot from the same list that seeds the cross-room maps", async () => {
    const { store } = await boot(elsewhere());
    expect(store.getState().sessions["se2"]).toBeUndefined(); // not the room you are in
    expect(store.getState().allSessions["se2"]).toMatchObject({ title: "Port the picker", spaceId: "s2" });
  });

  it("a persisted event in another room moves its log on, so a finished turn reads as unread there", async () => {
    /* THE MUTANT: leave `lastEventSeq` where the last list put it. The row then says the session was
       read to the end for as long as nothing re-lists it — and nothing does, for a room you are not
       in — so a turn that finished while you were elsewhere never wears the ring. */
    const { store } = await boot(elsewhere());
    expect(isUnread(store.getState().allSessions["se2"]!)).toBe(false);
    store.getState().applySessionEvent({ seq: 5, sessionId: "se2", ephemeral: false, event: sessionEvent("assistant_text", { messageId: "m", text: "done" }, 1) });
    expect(store.getState().allSessions["se2"]!.lastEventSeq).toBe(5);
    expect(isUnread(store.getState().allSessions["se2"]!)).toBe(true);
  });

  it("an ephemeral delta is not the log growing, and an old seq does not move it back", async () => {
    const { store } = await boot(elsewhere());
    store.getState().applySessionEvent({ seq: -1, sessionId: "se2", ephemeral: true, event: sessionEvent("assistant_delta", { messageId: "m", delta: "do" }, 1) });
    store.getState().applySessionEvent({ seq: 2, sessionId: "se2", ephemeral: false, event: sessionEvent("assistant_text", { messageId: "m", text: "done" }, 1) });
    expect(store.getState().allSessions["se2"]!.lastEventSeq).toBe(4);
  });

  it("the room you are in moves its own row on too, so its list and the cross-room rows agree", async () => {
    const { store } = await boot({
      items: { s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "Fix the build" })] },
      sessions: [session("se1", "s1", { seenSeq: 3, lastEventSeq: 3 })],
    });
    let writes = 0; store.subscribe(() => writes++);
    store.getState().applySessionEvent({ seq: 4, sessionId: "se1", ephemeral: false, event: sessionEvent("assistant_text", { messageId: "m", text: "done" }, 1) });
    expect(store.getState().sessions["se1"]!.lastEventSeq).toBe(4);
    expect(store.getState().allSessions["se1"]!.lastEventSeq).toBe(4);
    // One write for the event, however many rows it moved — the activity fold's rule.
    expect(writes).toBe(1);
  });

  it("a row written locally — the optimistic read mark — lands here too", async () => {
    const { store } = await boot(elsewhere());
    await store.getState().selectSpace("s2");
    await store.getState().openSession("se2");
    store.setState({ transcripts: { ...store.getState().transcripts, se2: { ...store.getState().transcripts["se2"]!, lastSeq: 9 } } });
    // The fake hands the store its own row objects and its `markSessionSeen` marks them in place, so
    // this copy is detached first — otherwise it would read 9 whether or not the store wrote it.
    store.setState({ allSessions: { ...store.getState().allSessions, se2: { ...store.getState().allSessions["se2"]! } } });
    await store.getState().markSessionSeen("se2");
    expect(store.getState().allSessions["se2"]!.seenSeq).toBe(9);
  });
});

describe("sidebarOpenSpaces — which rooms show their live sessions", () => {
  it("remembers an unfolded room across a relaunch", async () => {
    const { api, store } = await boot({ spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s3", "p1", "Thesis")] });
    expect(store.getState().sidebarOpenSpaces).toEqual([]);
    await store.getState().setSpaceRowOpen("s2", true);
    await store.getState().setSpaceRowOpen("s3", true);
    await store.getState().setSpaceRowOpen("s2", false);
    expect(store.getState().sidebarOpenSpaces).toEqual(["s3"]);
    // THE MUTANT: keep it in memory only. The next launch reads the key back.
    const again = createAppStore(api);
    await again.getState().boot();
    expect(again.getState().sidebarOpenSpaces).toEqual(["s3"]);
  });

  it("reads anything that is not a list of ids as nothing unfolded, and drops a deleted room on the next write", async () => {
    for (const junk of ["s2", { s2: true }, 3, [7, null]]) {
      const { store } = await boot({ settings: { "ui.sidebarOpenSpaces": junk } });
      expect(store.getState().sidebarOpenSpaces).toEqual([]);
    }
    const { store } = await boot({ settings: { "ui.sidebarOpenSpaces": ["gone", "s2"] } });
    await store.getState().setSpaceRowOpen("s1", true);
    expect(store.getState().sidebarOpenSpaces).toEqual(["s2", "s1"]);
  });
});
